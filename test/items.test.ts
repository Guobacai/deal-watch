import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidItemUrlError } from "../src/costcoUrl";
import { JsonFileError } from "../src/store/jsonFile";
import { DuplicateItemError, ItemNotFoundError, ItemRepository } from "../src/store/items";

const URL_A = "https://www.costco.com/p/-/la-mer/100511846";
const URL_B = "https://www.costco.com/p/-/samsung-tv/4201001045";

let dir: string;
let path: string;
let repo: ItemRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-costco-"));
  path = join(dir, "items.json");
  repo = new ItemRepository(path, () => new Date("2026-11-07T12:00:00Z"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("ItemRepository", () => {
  it("starts empty when the file doesn't exist", async () => {
    expect(await repo.list()).toEqual([]);
  });

  it("adds, lists and removes items, persisting to disk", async () => {
    await repo.add({ url: URL_A, name: "La Mer" });
    await repo.add({ url: URL_B });
    expect((await repo.list()).map((i) => i.itemNumber)).toEqual(["100511846", "4201001045"]);

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk[0]).toEqual({ itemNumber: "100511846", url: URL_A, name: "La Mer", addedAt: "2026-11-07T12:00:00.000Z" });

    await repo.remove("100511846");
    expect((await repo.list()).map((i) => i.itemNumber)).toEqual(["4201001045"]);
  });

  it("rejects duplicates by item number, even with a different URL", async () => {
    await repo.add({ url: URL_A });
    await expect(repo.add({ url: "https://www.costco.com/p/-/other-slug/100511846?x=1" })).rejects.toThrow(DuplicateItemError);
  });

  it("rejects invalid URLs and saves nothing", async () => {
    await expect(repo.add({ url: "https://www.costco.com/" })).rejects.toThrow(InvalidItemUrlError);
    expect(await repo.list()).toEqual([]);
  });

  it("errors when removing an unknown item", async () => {
    await expect(repo.remove("999")).rejects.toThrow(ItemNotFoundError);
  });

  it("fills in the name only when it is empty", async () => {
    await repo.add({ url: URL_A });
    await repo.add({ url: URL_B, name: "My TV" });
    await repo.fillNameIfEmpty("100511846", "La Mer Creme");
    await repo.fillNameIfEmpty("4201001045", "Samsung 65 inch");
    const [a, b] = await repo.list();
    expect(a.name).toBe("La Mer Creme");
    expect(b.name).toBe("My TV");
  });

  it("refuses a corrupt file and never overwrites it", async () => {
    await writeFile(path, "{ not json");
    await expect(repo.list()).rejects.toThrow(JsonFileError);
    await expect(repo.add({ url: URL_A })).rejects.toThrow(JsonFileError);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("refuses a file with invalid content", async () => {
    await writeFile(path, JSON.stringify([{ itemNumber: "abc" }]));
    await expect(repo.list()).rejects.toThrow(/invalid content/);
  });

  it("keeps a .bak copy of the previous version", async () => {
    await repo.add({ url: URL_A });
    await repo.add({ url: URL_B });
    const bak = JSON.parse(await readFile(`${path}.bak`, "utf8"));
    expect(bak).toHaveLength(1);
  });

  it("serializes concurrent adds so none are lost", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://www.costco.com/p/-/item/${1000 + i}`);
    await Promise.all(urls.map((url) => repo.add({ url })));
    expect(await repo.list()).toHaveLength(10);
  });
});
