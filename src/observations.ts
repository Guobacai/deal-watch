// What happens when the extension reports a price it read from a Costco page.
import { z } from "zod";
import { compare, type Comparison } from "./compare";
import { parseItemUrl } from "./costcoUrl";
import type { HistoryEntry, HistoryRepository } from "./store/history";
import type { ItemRepository } from "./store/items";
import { serialized } from "./store/jsonFile";

export const ObservationSchema = z.object({
  url: z.string().max(2000),
  itemNumber: z.string().regex(/^\d+$/).optional(), // if sent, must match the URL
  price: z.number().positive().max(1_000_000).nullable(), // null = the page showed no readable price
  name: z.string().max(300).optional(),
  via: z.string().max(40).optional(), // which extraction method found the price
  runId: z.string().max(100).optional(),
  error: z.string().max(500).optional(),
  // When the page was read. Captures queued while the service was down arrive later but keep their real time.
  capturedAt: z.iso.datetime().optional(),
});

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Use the capture time if it's plausible (not in the future), otherwise the server's time. */
export function checkTime(obs: Observation, now: Date): Date {
  if (!obs.capturedAt) return now;
  const t = new Date(obs.capturedAt);
  return t.getTime() <= now.getTime() + MAX_CLOCK_SKEW_MS ? t : now;
}
export type Observation = z.infer<typeof ObservationSchema>;

export type ObservationResult =
  | { watched: false; saved: false; itemNumber: string }
  | { watched: true; saved: false; duplicate: true; itemNumber: string; comparison: Comparison }
  | { watched: true; saved: true; itemNumber: string; entry: HistoryEntry; comparison: Comparison };

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationError";
  }
}

export interface ObservationDeps {
  items: ItemRepository;
  history: HistoryRepository;
  dedupeWindowMs: number;
  now?: () => Date;
}

/**
 * Record an observation for a watched item. Unwatched items are ignored.
 * A repeat of the latest entry (same status and price) within the dedupe window is not stored again,
 * so reloading a page doesn't create duplicates.
 */
export async function recordObservation(deps: ObservationDeps, obs: Observation): Promise<ObservationResult> {
  const { itemNumber } = parseItemUrl(obs.url); // throws InvalidItemUrlError
  if (obs.itemNumber && obs.itemNumber !== itemNumber) {
    throw new ObservationError(`itemNumber ${obs.itemNumber} doesn't match the URL (${itemNumber})`);
  }
  const now = checkTime(obs, (deps.now ?? (() => new Date()))());

  // Check-then-append must be atomic, or two quick reloads could both be stored.
  return serialized("observations", async () => {
    const watched = (await deps.items.list()).some((i) => i.itemNumber === itemNumber);
    if (!watched) return { watched: false, saved: false, itemNumber };

    const entry: HistoryEntry =
      obs.price !== null
        ? { checkedAt: now.toISOString(), status: "ok", price: obs.price }
        : { checkedAt: now.toISOString(), status: "failed", price: null, error: obs.error || "no price found on the page" };
    if (obs.runId) entry.runId = obs.runId;

    const existing = await deps.history.get(itemNumber);
    // A repeat = same result as an existing entry close in time (either side, since queued captures can arrive late).
    const isRepeat = existing.some(
      (e) =>
        e.status === entry.status &&
        e.price === entry.price &&
        Math.abs(now.getTime() - new Date(e.checkedAt).getTime()) < deps.dedupeWindowMs,
    );
    if (isRepeat) return { watched: true, saved: false, duplicate: true, itemNumber, comparison: compare(existing) };

    await deps.history.append(itemNumber, entry);
    if (entry.status === "ok" && obs.name) await deps.items.fillNameIfEmpty(itemNumber, obs.name);
    return { watched: true, saved: true, itemNumber, entry, comparison: compare([...existing, entry]) };
  });
}
