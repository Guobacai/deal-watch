import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeRun } from "../public/format.js";
import { AlreadyRunningError, BadTokenError, NothingToCheckError, OpenTabsError, RunManager, localDate } from "../src/runs";
import { buildServer } from "../src/server";
import { HistoryRepository } from "../src/store/history";
import { ItemRepository } from "../src/store/items";
import { StateRepository, type RunSummary } from "../src/store/state";

const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const PORTAL = `http://${HOST}`;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const A = "https://www.costco.com/p/-/la-mer/100511846";
const B = "https://www.costco.com/p/-/tv/4201001045";
const C = "https://www.costco.com/p/-/mac/4000444300";
const TIMEOUT = 10 * 60_000;

let dir: string;
let items: ItemRepository;
let history: HistoryRepository;
let state: StateRepository;
let clock: Date;
let opened: string[][];
let openFails: Error | null;
let finished: RunSummary[];
let runs: RunManager;

const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-costco-runs-"));
  items = new ItemRepository(join(dir, "items.json"));
  history = new HistoryRepository(join(dir, "history.json"));
  state = new StateRepository(join(dir, "state.json"));
  for (const url of [A, B, C]) await items.add({ url });
  clock = new Date(2026, 10, 8, 9, 0);
  opened = [];
  openFails = null;
  finished = [];
  runs = new RunManager({
    items,
    history,
    state,
    timeoutMs: TIMEOUT,
    now: () => clock,
    openTabs: async (urls) => {
      if (openFails) throw openFails;
      opened.push(urls);
    },
    onFinish: (s) => finished.push(s),
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RunManager", () => {
  it("opens one marked tab per watched item and records the run", async () => {
    const run = await runs.start("portal");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toEqual([A, B, C].map((u) => `${u}#cpw-run=${run.id}`));
    expect(run).toMatchObject({ trigger: "portal", total: 3, pending: 3, ok: 0 });
    expect(run.deadline).toBe(new Date(clock.getTime() + TIMEOUT).toISOString());
    expect((await state.get()).currentRun?.id).toBe(run.id);
  });

  it("refuses a second run while one is going", async () => {
    await runs.start("portal");
    await expect(runs.start("portal")).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(opened).toHaveLength(1);
  });

  it("refuses an empty watch list", async () => {
    for (const n of ["100511846", "4201001045", "4000444300"]) await items.remove(n);
    await expect(runs.start("portal")).rejects.toBeInstanceOf(NothingToCheckError);
  });

  it("saves nothing if Chrome can't be opened", async () => {
    openFails = new Error("Unable to find application named 'Google Chrome'");
    await expect(runs.start("portal")).rejects.toBeInstanceOf(OpenTabsError);
    expect((await state.get()).currentRun).toBeUndefined();
  });

  it("completes when every item has reported", async () => {
    await runs.start("portal");
    minutes(1);
    await runs.noteCapture("100511846", "ok", 434.99, clock);
    await runs.noteCapture("4201001045", "failed", null, clock);
    expect((await runs.current()).run).toMatchObject({ ok: 1, failed: 1, pending: 1 });
    expect(finished).toHaveLength(0);

    await runs.noteCapture("4000444300", "ok", 2299.99, clock);
    const { run, last } = await runs.current();
    expect(run).toBeNull();
    expect(last).toMatchObject({ ok: 2, failed: 1, missed: 0 });
    expect(finished).toHaveLength(1);
    expect(finished[0].items.find((i) => i.itemNumber === "100511846")).toMatchObject({ status: "ok", price: 434.99 });
  });

  it("lets a later good price replace a failure", async () => {
    await runs.start("portal");
    await runs.noteCapture("100511846", "failed", null, clock);
    await runs.noteCapture("100511846", "ok", 434.99, clock);
    expect((await runs.current()).run?.items[0]).toMatchObject({ status: "ok", price: 434.99 });
    await runs.noteCapture("100511846", "failed", null, clock); // a failure doesn't undo a good price
    expect((await runs.current()).run?.items[0].status).toBe("ok");
  });

  it("marks items missed at the timeout, with history entries", async () => {
    const run = await runs.start("portal");
    await runs.noteCapture("100511846", "ok", 434.99, clock);
    minutes(9);
    expect(await runs.tick()).toBeNull();
    minutes(1);
    const summary = await runs.tick();
    expect(summary).toMatchObject({ ok: 1, missed: 2 });
    expect(finished).toHaveLength(1);
    expect(await history.get("4201001045")).toEqual([
      expect.objectContaining({ status: "missed", price: null, runId: run.id, checkedAt: run.deadline }),
    ]);
    expect(await history.get("100511846")).toEqual([]); // the route records good prices, not the run manager
  });

  it("doesn't write missed entries for items removed during the run", async () => {
    await runs.start("portal");
    await items.remove("4000444300");
    minutes(11);
    await runs.tick();
    expect(await history.get("4000444300")).toEqual([]);
    expect(await history.get("4201001045")).toHaveLength(1);
  });

  it("ignores captures outside a run, before it started, or for items not in it", async () => {
    await runs.noteCapture("100511846", "ok", 1, clock); // no run
    const before = new Date(clock.getTime() - 1000);
    await runs.start("portal");
    await runs.noteCapture("100511846", "ok", 1, before); // queued from before the run
    await runs.noteCapture("999999", "ok", 1, clock); // not in this run
    expect((await runs.current()).run).toMatchObject({ ok: 0, pending: 3 });
    expect(await runs.runIdAt(before)).toBeUndefined();
  });

  it("a stale run left past its deadline doesn't block a new one", async () => {
    await runs.start("portal");
    minutes(30);
    const second = await runs.start("portal");
    expect(finished).toHaveLength(1);
    expect(second.pending).toBe(3);
  });

  it("reminder token: today's works once; wrong, used or old tokens don't", async () => {
    const token = await runs.issueReminderToken();
    await expect(runs.startWithToken("nope")).rejects.toBeInstanceOf(BadTokenError);
    const run = await runs.startWithToken(token);
    expect(run.trigger).toBe("reminder");
    await expect(runs.startWithToken(token)).rejects.toBeInstanceOf(BadTokenError);

    const yesterdaysToken = await runs.issueReminderToken();
    minutes(24 * 60);
    await expect(runs.startWithToken(yesterdaysToken)).rejects.toBeInstanceOf(BadTokenError);
  });

  it("localDate is the local calendar day", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("run API", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildServer({ port: PORT, items, history, runs, dedupeWindowMs: 10 * 60_000, now: () => clock });
  });
  afterEach(async () => {
    await app.close();
  });

  const startRun = (origin = PORTAL) => app.inject({ method: "POST", url: "/api/runs", headers: { host: HOST, origin } });
  const capture = (url: string, price: number | null, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/observations", headers: { host: HOST, origin: EXT }, payload: { url, price, ...extra } });

  it("starts a run (201), refuses a second (409), and is refused to other websites (403)", async () => {
    expect((await startRun("https://evil.example")).statusCode).toBe(403);
    const first = await startRun();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ total: 3, pending: 3 });
    const second = await startRun();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "A check is already running.", run: { id: first.json().id } });
    expect(opened).toHaveLength(1);
  });

  it("reports a 500 with the reason if Chrome won't open", async () => {
    openFails = new Error("no Chrome");
    const res = await startRun();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("no Chrome");
  });

  it("captures count toward the run and are tagged with its id (whatever the client sent)", async () => {
    const id = (await startRun()).json().id;
    const res = await capture(`${A}#cpw-run=${id}`, 434.99, { runId: "forged" });
    expect(res.statusCode).toBe(201);
    expect((await history.get("100511846"))[0].runId).toBe(id);

    await capture(B, null, { error: "no price" });
    await capture(C, 2299.99);
    const current = (await app.inject({ method: "GET", url: "/api/runs/current", headers: { host: HOST } })).json();
    expect(current.run).toBeNull();
    expect(current.last).toMatchObject({ id, ok: 2, failed: 1, missed: 0 });
  });

  it("a reload during the run (duplicate) still counts", async () => {
    await capture(A, 434.99); // before the run
    await startRun();
    minutes(1);
    const res = await capture(A, 434.99);
    expect(res.json().duplicate).toBe(true);
    const current = (await app.inject({ method: "GET", url: "/api/runs/current", headers: { host: HOST } })).json();
    expect(current.run.ok).toBe(1);
  });

  it("captures outside a run get no run id", async () => {
    await capture(A, 434.99, { runId: "forged" });
    expect((await history.get("100511846"))[0].runId).toBeUndefined();
  });

  it("/run/start: today's token starts a run and redirects to the portal; a bad token gets a page", async () => {
    const bad = await app.inject({ method: "GET", url: "/run/start?token=nope", headers: { host: HOST } });
    expect(bad.statusCode).toBe(403);
    expect(bad.headers["content-type"]).toContain("text/html");
    expect(bad.body).toContain("Link expired");
    expect((await app.inject({ method: "GET", url: "/run/start", headers: { host: HOST } })).statusCode).toBe(403);
    expect(opened).toHaveLength(0);

    const token = await runs.issueReminderToken();
    const ok = await app.inject({ method: "GET", url: `/run/start?token=${token}`, headers: { host: HOST } });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/");
    expect(opened).toHaveLength(1);

    const again = await app.inject({ method: "GET", url: `/run/start?token=${token}`, headers: { host: HOST } });
    expect(again.statusCode).toBe(403);
  });
});

describe("run banner text", () => {
  const now = new Date(2026, 10, 8, 9, 3);
  const at = (h: number, m: number) => new Date(2026, 10, 8, h, m).toISOString();
  const runItems = [
    { itemNumber: "1", name: "La Mer", status: "ok", price: 434.99 },
    { itemNumber: "2", name: "", status: "pending" },
    { itemNumber: "3", name: "Mac", status: "failed" },
  ];

  it("in progress", () => {
    const d = describeRun({ id: "r", startedAt: at(9, 0), deadline: at(9, 10), trigger: "portal", items: runItems }, now);
    expect(d.state).toBe("running");
    expect(d.title).toBe("Checking 3 items in Chrome…");
    expect(d.detail).toBe("2 of 3 reported · 1 saved · gives up at 9:10 AM");
    expect(d.items.map((i: { icon: string; name: string; text: string }) => `${i.icon} ${i.name} ${i.text}`)).toEqual([
      "✓ La Mer $434.99",
      "… Item #2 waiting",
      "✗ Mac failed",
    ]);
  });

  it("finished, with and without problems", () => {
    const done = describeRun(
      { id: "r", startedAt: at(9, 0), finishedAt: at(9, 2), trigger: "portal", items: [runItems[0]], ok: 1, failed: 0, missed: 0 },
      now,
    );
    expect(done).toMatchObject({ state: "done", title: "Check finished 9:02 AM", detail: "1 of 1 saved ✓" });
    const warn = describeRun(
      {
        id: "r",
        startedAt: at(9, 0),
        finishedAt: at(9, 10),
        trigger: "portal",
        items: [runItems[0], { ...runItems[1], status: "missed" }, runItems[2]],
        ok: 1,
        failed: 1,
        missed: 1,
      },
      now,
    );
    expect(warn).toMatchObject({ state: "warn", detail: "1 of 3 saved · 1 failed, 1 missed" });
  });
});
