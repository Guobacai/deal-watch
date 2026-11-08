// Service state, stored in data/state.json: the current check run, the last run's summary,
// and today's one-time link token for the reminder notification.
import { z } from "zod";
import { readJson, serialized, writeJsonAtomic } from "./jsonFile";

export const RunItemSchema = z.object({
  itemNumber: z.string().regex(/^\d+$/),
  name: z.string(),
  status: z.enum(["pending", "ok", "failed", "missed"]),
  price: z.number().positive().optional(),
});
export type RunItem = z.infer<typeof RunItemSchema>;

export const RunSchema = z.object({
  id: z.string(),
  startedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  trigger: z.enum(["portal", "reminder"]),
  items: z.array(RunItemSchema),
});
export type Run = z.infer<typeof RunSchema>;

export const RunSummarySchema = RunSchema.omit({ deadline: true }).extend({
  finishedAt: z.iso.datetime(),
  ok: z.number().int(),
  failed: z.number().int(),
  missed: z.number().int(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const StateSchema = z.object({
  currentRun: RunSchema.optional(),
  lastRunSummary: RunSummarySchema.optional(),
  /** The day (YYYY-MM-DD, local) the reminder was last shown. Used by Task 9. */
  lastReminderDate: z.string().optional(),
  /** One-time token for today's reminder link; cleared when used. */
  reminderToken: z.string().optional(),
  reminderTokenDate: z.string().optional(),
});
export type State = z.infer<typeof StateSchema>;

export class StateRepository {
  constructor(private readonly path: string) {}

  get(): Promise<State> {
    return serialized(this.path, () => this.read());
  }

  /** Read, change and write back in one step, so concurrent updates can't lose each other's changes. */
  update<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    return serialized(this.path, async () => {
      const state = await this.read();
      const result = await fn(state);
      await writeJsonAtomic(this.path, StateSchema.parse(state));
      return result;
    });
  }

  private read(): Promise<State> {
    return readJson(this.path, StateSchema, {});
  }
}
