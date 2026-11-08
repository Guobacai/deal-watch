import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { Notification } from "../src/notify/types";
import { Reminder, parseReminderTime, reminderDue } from "../src/reminder";
import { RunManager } from "../src/runs";
import { HistoryRepository } from "../src/store/history";
import { ItemRepository } from "../src/store/items";
import { StateRepository, type RunSummary, type State } from "../src/store/state";
import { findDrops, summaryNotification } from "../src/summary";

const NINE = 9 * 60;
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);
const PORTAL = "http://127.0.0.1:4000";

describe("parseReminderTime", () => {
  it("reads HH:MM", () => {
    expect(parseReminderTime("09:00")).toBe(540);
    expect(parseReminderTime("9:05")).toBe(545);
    expect(parseReminderTime("23:59")).toBe(1439);
  });
  it.each(["9", "24:00", "09:60", "9am", ""])("rejects %j", (v) => {
    expect(() => parseReminderTime(v)).toThrow(/REMINDER_TIME/);
  });
  it("is used by loadConfig, default 09:00", () => {
    expect(loadConfig({}).reminderMinutes).toBe(540);
    expect(loadConfig({ REMINDER_TIME: "18:30" }).reminderMinutes).toBe(1110);
    expect(() => loadConfig({ REMINDER_TIME: "noon" })).toThrow();
  });
});

describe("reminderDue", () => {
  const summary = (startedAt: Date): RunSummary => ({
    id: "r",
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    trigger: "portal",
    items: [],
    ok: 0,
    failed: 0,
    missed: 0,
  });

  it("is due at or after the reminder time", () => {
    expect(reminderDue(at(8, 8, 59), NINE, {}, 3).due).toBe(false);
    expect(reminderDue(at(8, 9, 0), NINE, {}, 3).due).toBe(true);
    expect(reminderDue(at(8, 15, 0), NINE, {}, 3).due).toBe(true); // woke up late: still comes
  });

  it("once a day", () => {
    expect(reminderDue(at(8, 10), NINE, { lastReminderDate: "2026-11-08" }, 3)).toEqual({ due: false, reason: "already reminded today" });
    expect(reminderDue(at(9, 9), NINE, { lastReminderDate: "2026-11-08" }, 3).due).toBe(true);
  });

  it("not if a check already ran today, or one is running, or the list is empty", () => {
    expect(reminderDue(at(8, 10), NINE, { lastRunSummary: summary(at(8, 7)) }, 3)).toEqual({ due: false, reason: "already checked today" });
    expect(reminderDue(at(8, 10), NINE, { lastRunSummary: summary(at(7, 20)) }, 3).due).toBe(true);
    const running = { currentRun: { id: "r", startedAt: at(8, 9).toISOString(), deadline: at(8, 9, 10).toISOString(), trigger: "portal", items: [] } } as State;
    expect(reminderDue(at(8, 10), NINE, running, 3).due).toBe(false);
    expect(reminderDue(at(8, 10), NINE, {}, 0)).toEqual({ due: false, reason: "the watch list is empty" });
  });
});

describe("Reminder.tick", () => {
  let dir: string;
  let items: ItemRepository;
  let state: StateRepository;
  let runs: RunManager;
  let sent: Notification[];
  let failNotify: boolean;
  let clock: Date;
  let reminder: Reminder;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "watch-costco-reminder-"));
    items = new ItemRepository(join(dir, "items.json"));
    state = new StateRepository(join(dir, "state.json"));
    const history = new HistoryRepository(join(dir, "history.json"));
    await items.add({ url: "https://www.costco.com/p/-/a/1" });
    await items.add({ url: "https://www.costco.com/p/-/b/2" });
    clock = at(8, 8, 30);
    sent = [];
    failNotify = false;
    runs = new RunManager({ items, history, state, timeoutMs: 600_000, now: () => clock, openTabs: async () => undefined });
    reminder = new Reminder({
      items,
      state,
      runs,
      reminderMinutes: NINE,
      portalUrl: PORTAL,
      now: () => clock,
      notifier: {
        notify: async (n) => {
          if (failNotify) throw new Error("notification center unavailable");
          sent.push(n);
        },
      },
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sends exactly one reminder a day, with a working one-time link", async () => {
    expect(await reminder.tick()).toBe(false);
    clock = at(8, 9, 0);
    expect(await reminder.tick()).toBe(true);
    expect(await reminder.tick()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("Time to check Costco prices (2 items). Click to open them in Chrome.");

    const url = new URL(sent[0].url!);
    expect(url.origin + url.pathname).toBe(`${PORTAL}/run/start`);
    const run = await runs.startWithToken(url.searchParams.get("token")!);
    expect(run.trigger).toBe("reminder");

    clock = at(9, 9, 0);
    // the run from the 8th is still open past its deadline; tick() closes it first
    await runs.tick();
    expect(await reminder.tick()).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("comes after waking if the Mac slept through the reminder time", async () => {
    clock = at(8, 13, 42);
    expect(await reminder.tick()).toBe(true);
  });

  it("is skipped when you already checked today", async () => {
    clock = at(8, 8, 0);
    await runs.start("portal");
    await runs.noteCapture("1", "ok", 5, clock);
    await runs.noteCapture("2", "ok", 6, clock);
    clock = at(8, 9, 0);
    expect(await reminder.tick()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("a failing notification is logged, not thrown, and not retried every minute", async () => {
    failNotify = true;
    clock = at(8, 9, 0);
    expect(await reminder.tick()).toBe(false);
    failNotify = false;
    expect(await reminder.tick()).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("run summary notification", () => {
  let dir: string;
  let history: HistoryRepository;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "watch-costco-summary-"));
    history = new HistoryRepository(join(dir, "history.json"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ok = (itemNumber: string, iso: string, price: number) =>
    history.append(itemNumber, { checkedAt: iso, status: "ok", price });
  const run = (items: RunSummary["items"], failed = 0, missed = 0): RunSummary => ({
    id: "r",
    startedAt: "2026-11-08T14:00:00.000Z",
    finishedAt: "2026-11-08T14:02:00.000Z",
    trigger: "reminder",
    items,
    ok: items.filter((i) => i.status === "ok").length,
    failed,
    missed,
  });

  it("counts drops, new lows and missed items, and names the biggest drop", async () => {
    await ok("1", "2026-11-06T14:00:00.000Z", 24.99);
    await ok("1", "2026-11-08T14:01:00.000Z", 19.99); // −20%, new low
    await ok("2", "2026-11-06T14:00:00.000Z", 849.99);
    await ok("2", "2026-11-07T14:00:00.000Z", 949.99);
    await ok("2", "2026-11-08T14:01:00.000Z", 899.99); // −5.3%, not a new low
    await ok("3", "2026-11-07T14:00:00.000Z", 199.99);
    await ok("3", "2026-11-08T14:01:00.000Z", 209.99); // up
    await ok("4", "2026-11-08T14:01:00.000Z", 12.99); // first check

    const s = run(
      [
        { itemNumber: "1", name: "Kirkland Olive Oil 2L", status: "ok", price: 19.99 },
        { itemNumber: "2", name: "Samsung TV", status: "ok", price: 899.99 },
        { itemNumber: "3", name: "AirPods", status: "ok", price: 209.99 },
        { itemNumber: "4", name: "", status: "ok", price: 12.99 },
        { itemNumber: "5", name: "Gone", status: "missed" },
      ],
      0,
      1,
    );
    const drops = await findDrops(s, history);
    expect(drops.map((d) => [d.name, d.percent, d.isNewLow])).toEqual([
      ["Kirkland Olive Oil 2L", 20, true],
      ["Samsung TV", 5.3, false],
    ]);
    expect(summaryNotification(s, drops, PORTAL)).toEqual({
      title: "Costco prices checked",
      message: "5 items · 2 price drops · 1 new low · 1 missed\n▼ Kirkland Olive Oil 2L $19.99 (−20%) ★",
      url: `${PORTAL}/`,
    });
  });

  it("says when nothing dropped", async () => {
    await ok("1", "2026-11-08T14:01:00.000Z", 5);
    const s = run([{ itemNumber: "1", name: "A", status: "ok", price: 5 }]);
    expect(summaryNotification(s, await findDrops(s, history), PORTAL).message).toBe("1 item · no price drops");
  });

  it("reports failures without a drop line", () => {
    const s = run([{ itemNumber: "1", name: "A", status: "failed" }], 1, 0);
    expect(summaryNotification(s, [], PORTAL).message).toBe("1 item · 1 failed");
  });
});
