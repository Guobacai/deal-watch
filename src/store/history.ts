// Price history per item, stored in data/history.json:
//   { "<itemNumber>": [ { checkedAt, status, price, runId?, error? }, ... ] }
// History is kept when an item is removed from the watch list, so re-adding it restores it.
import { z } from "zod";
import { readJson, serialized, writeJsonAtomic } from "./jsonFile";

export const HistoryEntrySchema = z
  .object({
    checkedAt: z.iso.datetime(),
    status: z.enum(["ok", "failed", "missed"]),
    price: z.number().positive().nullable(),
    runId: z.string().optional(),
    error: z.string().optional(),
  })
  .refine((e) => (e.status === "ok") === (e.price !== null), {
    message: 'an "ok" entry needs a price; "failed" and "missed" entries must have price null',
  });
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const HistoryFileSchema = z.record(z.string().regex(/^\d+$/), z.array(HistoryEntrySchema));
type HistoryFile = z.infer<typeof HistoryFileSchema>;

const byTime = (a: HistoryEntry, b: HistoryEntry) => a.checkedAt.localeCompare(b.checkedAt);

export class HistoryRepository {
  constructor(private readonly path: string) {}

  /** Add an entry, keeping the item's entries in time order. Validates the entry first. */
  async append(itemNumber: string, entry: HistoryEntry): Promise<void> {
    const valid = HistoryEntrySchema.parse(entry);
    return serialized(this.path, async () => {
      const all = await this.read();
      const list = [...(all[itemNumber] ?? []), valid].sort(byTime);
      await writeJsonAtomic(this.path, { ...all, [itemNumber]: list });
    });
  }

  /** All entries for an item, oldest first. Empty if the item has no history. */
  get(itemNumber: string): Promise<HistoryEntry[]> {
    return serialized(this.path, async () => [...((await this.read())[itemNumber] ?? [])]);
  }

  /** Every item's history, for building the portal table in one read. */
  getAll(): Promise<HistoryFile> {
    return serialized(this.path, () => this.read());
  }

  /** The most recent successful entry, or null. */
  async latestOk(itemNumber: string): Promise<HistoryEntry | null> {
    const list = await this.get(itemNumber);
    return list.findLast((e) => e.status === "ok") ?? null;
  }

  private async read(): Promise<HistoryFile> {
    const data = await readJson(this.path, HistoryFileSchema, {});
    for (const list of Object.values(data)) list.sort(byTime); // tolerate hand-edited order
    return data;
  }
}
