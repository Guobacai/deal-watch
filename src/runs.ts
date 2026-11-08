// A "check run": open every watched item in Chrome, count the prices the extension sends back,
// and finish when all items have reported or the timeout passes (the rest are marked "missed").
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { HistoryRepository } from "./store/history";
import type { ItemRepository } from "./store/items";
import type { Run, RunItem, RunSummary, State, StateRepository } from "./store/state";

export class AlreadyRunningError extends Error {
  constructor(public readonly run: Run) {
    super("A check is already running.");
    this.name = "AlreadyRunningError";
  }
}
export class NothingToCheckError extends Error {
  constructor() {
    super("There are no items on the watch list to check.");
    this.name = "NothingToCheckError";
  }
}
export class OpenTabsError extends Error {
  constructor(cause: unknown) {
    super(`Couldn't open the items in Chrome: ${(cause as Error).message ?? cause}`);
    this.name = "OpenTabsError";
  }
}
export class BadTokenError extends Error {
  constructor() {
    super("This link has expired or was already used.");
    this.name = "BadTokenError";
  }
}

/** Marks a tab as opened by a run, so the extension knows it may close it. Never sent to Costco (it's a #fragment). */
export const RUN_TAB_MARK = "cpw-run";
export const runTabUrl = (url: string, runId: string) => `${url}#${RUN_TAB_MARK}=${runId}`;

export interface RunProgress extends Run {
  total: number;
  ok: number;
  failed: number;
  missed: number;
  pending: number;
}

export interface RunDeps {
  items: ItemRepository;
  history: HistoryRepository;
  state: StateRepository;
  /** Opens these URLs as tabs in Chrome. */
  openTabs: (urls: string[]) => Promise<void>;
  timeoutMs: number;
  now?: () => Date;
  /** Called once when a run finishes (for the summary notification). */
  onFinish?: (summary: RunSummary) => void;
}

const counts = (items: RunItem[]) => ({
  total: items.length,
  ok: items.filter((i) => i.status === "ok").length,
  failed: items.filter((i) => i.status === "failed").length,
  missed: items.filter((i) => i.status === "missed").length,
  pending: items.filter((i) => i.status === "pending").length,
});

/** YYYY-MM-DD in local time. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class RunManager {
  constructor(private readonly deps: RunDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Start a run: record it, then open every watched item in Chrome. */
  async start(trigger: Run["trigger"]): Promise<RunProgress> {
    const finished = await this.timeoutIfDue(); // a stale run from before a restart shouldn't block a new one
    if (finished) this.deps.onFinish?.(finished);

    const items = await this.deps.items.list();
    return this.deps.state.update(async (state) => {
      if (state.currentRun) throw new AlreadyRunningError(state.currentRun);
      if (items.length === 0) throw new NothingToCheckError();
      const now = this.now();
      const run: Run = {
        id: `${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`,
        startedAt: now.toISOString(),
        deadline: new Date(now.getTime() + this.deps.timeoutMs).toISOString(),
        trigger,
        items: items.map((i) => ({ itemNumber: i.itemNumber, name: i.name, status: "pending" })),
      };
      try {
        await this.deps.openTabs(items.map((i) => runTabUrl(i.url, run.id)));
      } catch (e) {
        throw new OpenTabsError(e); // nothing is saved: the run never started
      }
      state.currentRun = run;
      return { ...run, ...counts(run.items) };
    });
  }

  /** The id of the run a capture taken at `at` belongs to, or undefined. */
  async runIdAt(at: Date): Promise<string | undefined> {
    const run = (await this.deps.state.get()).currentRun;
    return run && at.getTime() >= new Date(run.startedAt).getTime() ? run.id : undefined;
  }

  /**
   * A price (or a failure) came in for an item. If it's part of the current run, count it.
   * A later good price replaces an earlier failure. Finishes the run when nothing is pending.
   */
  async noteCapture(itemNumber: string, status: "ok" | "failed", price: number | null, at: Date): Promise<void> {
    const summary = await this.deps.state.update((state) => {
      const run = state.currentRun;
      if (!run || at.getTime() < new Date(run.startedAt).getTime()) return null;
      const item = run.items.find((i) => i.itemNumber === itemNumber);
      if (!item) return null;
      if (status === "ok" && price !== null) {
        item.status = "ok";
        item.price = price;
      } else if (item.status === "pending") {
        item.status = "failed";
      }
      return run.items.some((i) => i.status === "pending") ? null : this.finish(state);
    });
    if (summary) this.deps.onFinish?.(summary);
  }

  /** Mark leftovers "missed" if the run is past its deadline. Call this regularly. */
  async tick(): Promise<RunSummary | null> {
    const summary = await this.timeoutIfDue();
    if (summary) this.deps.onFinish?.(summary);
    return summary;
  }

  /** Progress of the current run (if any) and the last finished run. */
  async current(): Promise<{ run: RunProgress | null; last: RunSummary | null }> {
    await this.tick();
    const state = await this.deps.state.get();
    const run = state.currentRun;
    return { run: run ? { ...run, ...counts(run.items) } : null, last: state.lastRunSummary ?? null };
  }

  // ---- Reminder link (the notification in Task 9 uses these) ----

  /** A fresh one-time token for today's reminder link. Replaces any earlier one. */
  issueReminderToken(): Promise<string> {
    return this.deps.state.update((state) => {
      const token = randomBytes(24).toString("base64url");
      state.reminderToken = token;
      state.reminderTokenDate = localDate(this.now());
      return token;
    });
  }

  /** Start a run from the reminder link. The token must be today's and is used up. */
  async startWithToken(token: string): Promise<RunProgress> {
    await this.deps.state.update((state) => {
      const valid =
        !!state.reminderToken &&
        state.reminderTokenDate === localDate(this.now()) &&
        sameToken(token, state.reminderToken);
      if (!valid) throw new BadTokenError();
      delete state.reminderToken;
      delete state.reminderTokenDate;
    });
    return this.start("reminder");
  }

  private timeoutIfDue(): Promise<RunSummary | null> {
    return this.deps.state.update(async (state) => {
      const run = state.currentRun;
      if (!run || this.now().getTime() < new Date(run.deadline).getTime()) return null;
      const watched = new Set((await this.deps.items.list()).map((i) => i.itemNumber));
      for (const item of run.items) {
        if (item.status !== "pending") continue;
        item.status = "missed";
        if (watched.has(item.itemNumber)) {
          await this.deps.history.append(item.itemNumber, {
            checkedAt: run.deadline,
            status: "missed",
            price: null,
            runId: run.id,
            error: "No price came back from Chrome before the check timed out.",
          });
        }
      }
      return this.finish(state);
    });
  }

  /** Move the current run into the summary. Call inside a state update. */
  private finish(state: State): RunSummary {
    const run = state.currentRun!;
    const c = counts(run.items);
    const summary: RunSummary = {
      id: run.id,
      startedAt: run.startedAt,
      trigger: run.trigger,
      items: run.items,
      finishedAt: this.now().toISOString(),
      ok: c.ok,
      failed: c.failed,
      missed: c.missed,
    };
    state.lastRunSummary = summary;
    delete state.currentRun;
    return summary;
  }
}
