// The watch list, stored in data/items.json.
import { z } from "zod";
import { parseItemUrl } from "../costcoUrl";
import { readJson, serialized, writeJsonAtomic } from "./jsonFile";

export const ItemSchema = z.object({
  itemNumber: z.string().regex(/^\d+$/),
  name: z.string(), // may be "" until the first successful check fills it in
  url: z.url(),
  addedAt: z.iso.datetime(),
});
export type Item = z.infer<typeof ItemSchema>;

const ItemsFileSchema = z.array(ItemSchema);

export class DuplicateItemError extends Error {
  constructor(itemNumber: string) {
    super(`Item ${itemNumber} is already on the watch list.`);
    this.name = "DuplicateItemError";
  }
}

export class ItemNotFoundError extends Error {
  constructor(itemNumber: string) {
    super(`Item ${itemNumber} is not on the watch list.`);
    this.name = "ItemNotFoundError";
  }
}

export class ItemRepository {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<Item[]> {
    return serialized(this.path, () => this.read());
  }

  /** Add an item by URL. Throws InvalidItemUrlError or DuplicateItemError. */
  async add(input: { url: string; name?: string }): Promise<Item> {
    const { itemNumber, url } = parseItemUrl(input.url); // validate before queueing
    return serialized(this.path, async () => {
      const items = await this.read();
      if (items.some((i) => i.itemNumber === itemNumber)) throw new DuplicateItemError(itemNumber);
      const item: Item = { itemNumber, url, name: input.name?.trim() ?? "", addedAt: this.now().toISOString() };
      await writeJsonAtomic(this.path, [...items, item]);
      return item;
    });
  }

  remove(itemNumber: string): Promise<Item> {
    return serialized(this.path, async () => {
      const items = await this.read();
      const item = items.find((i) => i.itemNumber === itemNumber);
      if (!item) throw new ItemNotFoundError(itemNumber);
      await writeJsonAtomic(this.path, items.filter((i) => i.itemNumber !== itemNumber));
      return item;
    });
  }

  /** Fill in the name from the product page, only if the user didn't give one. */
  fillNameIfEmpty(itemNumber: string, name: string): Promise<void> {
    return serialized(this.path, async () => {
      const items = await this.read();
      const item = items.find((i) => i.itemNumber === itemNumber);
      if (!item || item.name || !name.trim()) return;
      item.name = name.trim();
      await writeJsonAtomic(this.path, items);
    });
  }

  private read(): Promise<Item[]> {
    return readJson(this.path, ItemsFileSchema, []);
  }
}
