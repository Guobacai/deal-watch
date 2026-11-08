// The daily "time to check prices" reminder. Checked every minute, so if the Mac slept through
// the reminder time it comes shortly after waking. At most once a day; skipped if a check already ran today.
import { localDate, type RunManager } from "./runs";
import type { Notifier } from "./notify/types";
import type { ItemRepository } from "./store/items";
import type { State, StateRepository } from "./store/state";

/** "HH:MM" (24-hour) → minutes after midnight. Throws on anything else. */
export function parseReminderTime(value: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) throw new Error(`REMINDER_TIME must be HH:MM in 24-hour time, like 09:00 (got "${value}")`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export type ReminderDecision = { due: true } | { due: false; reason: string };

export function reminderDue(now: Date, reminderMinutes: number, state: State, itemCount: number): ReminderDecision {
  const today = localDate(now);
  if (now.getHours() * 60 + now.getMinutes() < reminderMinutes) return { due: false, reason: "not time yet" };
  if (state.lastReminderDate === today) return { due: false, reason: "already reminded today" };
  if (itemCount === 0) return { due: false, reason: "the watch list is empty" };
  if (state.currentRun) return { due: false, reason: "a check is running" };
  const last = state.lastRunSummary;
  if (last && localDate(new Date(last.startedAt)) === today) return { due: false, reason: "already checked today" };
  return { due: true };
}

export interface ReminderDeps {
  items: ItemRepository;
  state: StateRepository;
  runs: RunManager;
  notifier: Notifier;
  reminderMinutes: number;
  portalUrl: string;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

export class Reminder {
  constructor(private readonly deps: ReminderDeps) {}

  /** Send today's reminder if it's due. Returns true if one was sent. Never throws. */
  async tick(): Promise<boolean> {
    const log = this.deps.log ?? (() => undefined);
    try {
      const now = (this.deps.now ?? (() => new Date()))();
      const count = (await this.deps.items.list()).length;
      // Claim today's reminder first, so it's sent at most once even if two ticks overlap.
      const claimed = await this.deps.state.update((state) => {
        if (!reminderDue(now, this.deps.reminderMinutes, state, count).due) return false;
        state.lastReminderDate = localDate(now);
        return true;
      });
      if (!claimed) return false;

      const token = await this.deps.runs.issueReminderToken();
      await this.deps.notifier.notify({
        title: "Costco Price Watcher",
        message: `Time to check Costco prices (${count} item${count === 1 ? "" : "s"}). Click to open them in Chrome.`,
        url: `${this.deps.portalUrl}/run/start?token=${encodeURIComponent(token)}`,
      });
      log("Daily reminder sent");
      return true;
    } catch (e) {
      log("Couldn't send the daily reminder", e);
      return false;
    }
  }
}
