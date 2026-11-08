// Portal data and watch-list management, built from items.json + history.json.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compare, type Comparison } from "../compare";
import type { HistoryEntry, HistoryRepository } from "../store/history";
import { ItemNotFoundError, type Item, type ItemRepository } from "../store/items";

export interface ItemView extends Item {
  comparison: Comparison;
}

export interface ItemsResponse {
  items: ItemView[];
  /** Time of the most recent entry (any status) across all items, or null if nothing was ever checked. */
  lastCheckedAt: string | null;
}

export interface HistoryResponse {
  item: ItemView;
  /** Every entry, newest first. */
  entries: HistoryEntry[];
}

const AddItemSchema = z.object({
  url: z.string().min(1, "paste a Costco product URL").max(2000),
  name: z.string().max(200).optional(),
});
const ItemNumberParams = z.object({ itemNumber: z.string().regex(/^\d{1,20}$/, "not an item number") });

export async function buildItemsView(items: ItemRepository, history: HistoryRepository): Promise<ItemsResponse> {
  const [list, all] = await Promise.all([items.list(), history.getAll()]);
  let lastCheckedAt: string | null = null;
  const views = list.map((item) => {
    const comparison = compare(all[item.itemNumber] ?? []);
    const t = comparison.lastAttempt?.checkedAt;
    if (t && (lastCheckedAt === null || t > lastCheckedAt)) lastCheckedAt = t;
    return { ...item, comparison };
  });
  return { items: views, lastCheckedAt };
}

async function findItem(items: ItemRepository, itemNumber: string): Promise<Item> {
  const item = (await items.list()).find((i) => i.itemNumber === itemNumber);
  if (!item) throw new ItemNotFoundError(itemNumber);
  return item;
}

export function registerItemRoutes(app: FastifyInstance, deps: { items: ItemRepository; history: HistoryRepository }) {
  app.get("/api/items", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return buildItemsView(deps.items, deps.history);
  });

  // Add an item. If it was watched before, its old history comes back with it.
  app.post("/api/items", async (req, reply) => {
    const body = AddItemSchema.parse(req.body);
    const item = await deps.items.add({ url: body.url, ...(body.name !== undefined ? { name: body.name } : {}) });
    const comparison = compare(await deps.history.get(item.itemNumber));
    return reply.code(201).send({ ...item, comparison } satisfies ItemView);
  });

  // Remove from the watch list. History is kept.
  app.delete("/api/items/:itemNumber", async (req, reply) => {
    const { itemNumber } = ItemNumberParams.parse(req.params);
    await deps.items.remove(itemNumber);
    return reply.code(204).send();
  });

  app.get("/api/items/:itemNumber/history", async (req, reply) => {
    const { itemNumber } = ItemNumberParams.parse(req.params);
    const item = await findItem(deps.items, itemNumber);
    const entries = await deps.history.get(itemNumber);
    reply.header("cache-control", "no-store");
    return { item: { ...item, comparison: compare(entries) }, entries: entries.reverse() } satisfies HistoryResponse;
  });
}
