import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { HistoryRepository } from "../src/store/history";
import { ItemRepository } from "../src/store/items";

const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const LA_MER = "https://www.costco.com/p/-/la-mer-creme-de-la-mer-moisturizing-cream-34-oz/100511846";
const TV = "https://www.costco.com/p/-/samsung-65-tv/4201001045";
const MAC = "https://www.costco.com/p/-/mac-studio/4000444300";

let dir: string;
let items: ItemRepository;
let history: HistoryRepository;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-costco-items-api-"));
  items = new ItemRepository(join(dir, "items.json"));
  history = new HistoryRepository(join(dir, "history.json"));
  await items.add({ url: LA_MER, name: "La Mer" });
  await items.add({ url: TV });
  await items.add({ url: MAC });
  app = buildServer({ port: PORT, items, history, dedupeWindowMs: 10 * 60_000 });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const PORTAL = `http://${HOST}`;
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { host: HOST, ...headers } });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/items", headers: { host: HOST, origin: PORTAL, ...headers }, payload: body as object });
const del = (itemNumber: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "DELETE", url: `/api/items/${itemNumber}`, headers: { host: HOST, origin: PORTAL, ...headers } });
const NEW = "https://www.costco.com/p/-/kirkland-olive-oil-2l/1234567?ref=home#reviews";

describe("GET /api/items", () => {
  it("returns every item in list order with its comparison, matching history.json", async () => {
    await history.append("100511846", { checkedAt: "2026-11-07T09:00:00.000Z", status: "ok", price: 449.99 });
    await history.append("100511846", { checkedAt: "2026-11-08T09:00:00.000Z", status: "ok", price: 434.99 });
    await history.append("4000444300", { checkedAt: "2026-11-08T09:05:00.000Z", status: "missed", price: null });

    const res = await get("/api/items");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();

    expect(body.items.map((i: { itemNumber: string }) => i.itemNumber)).toEqual(["100511846", "4201001045", "4000444300"]);
    expect(body.items[0]).toMatchObject({
      name: "La Mer",
      url: LA_MER,
      comparison: {
        current: { price: 434.99 },
        previous: { price: 449.99 },
        change: { amount: -15, percent: -3.3 },
        isNewLow: true,
        okCount: 2,
      },
    });
    expect(body.items[1].comparison).toMatchObject({ current: null, lastAttempt: null, okCount: 0 });
    expect(body.items[2].comparison).toMatchObject({ current: null, lastAttempt: { status: "missed" } });
    expect(body.lastCheckedAt).toBe("2026-11-08T09:05:00.000Z");
  });

  it("works with no history at all", async () => {
    const body = (await get("/api/items")).json();
    expect(body.items).toHaveLength(3);
    expect(body.lastCheckedAt).toBeNull();
  });

  it("ignores history for items no longer on the list", async () => {
    await history.append("999999", { checkedAt: "2026-11-09T00:00:00.000Z", status: "ok", price: 1 });
    const body = (await get("/api/items")).json();
    expect(body.items).toHaveLength(3);
    expect(body.lastCheckedAt).toBeNull();
  });

  it("is refused to other websites", async () => {
    expect((await get("/api/items", { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await get("/api/items", { host: "evil.example:4000" })).statusCode).toBe(403);
  });
});

describe("POST /api/items", () => {
  it("adds a valid URL (normalized) with an optional name", async () => {
    const res = await post({ url: NEW, name: "  Olive Oil  " });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      itemNumber: "1234567",
      name: "Olive Oil",
      url: "https://www.costco.com/p/-/kirkland-olive-oil-2l/1234567",
      comparison: { okCount: 0, current: null },
    });
    expect((await items.list()).map((i) => i.itemNumber)).toContain("1234567");
  });

  it("adds without a name", async () => {
    const res = await post({ url: NEW });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("");
  });

  it.each([
    [{ url: "not a url" }, "That isn't a valid URL."],
    [{ url: "https://www.amazon.com/p/-/thing/123" }, "Only costco.com product URLs are supported."],
    [{ url: "https://www.costco.com/televisions.html" }, "That isn't a Costco product page"],
    [{ url: "" }, "paste a Costco product URL"],
    [{}, "invalid url"],
    [{ url: NEW, name: "x".repeat(201) }, "invalid name"],
  ])("rejects %j with a message and saves nothing", async (body, message) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(message);
    expect(await items.list()).toHaveLength(3);
  });

  it("rejects a duplicate item number (even with a different slug) with 409", async () => {
    const res = await post({ url: "https://www.costco.com/p/-/other-slug/100511846" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Item 100511846 is already on the watch list.");
    expect(await items.list()).toHaveLength(3);
  });

  it("is refused to other websites", async () => {
    expect((await post({ url: NEW }, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect(await items.list()).toHaveLength(3);
  });
});

describe("DELETE /api/items/:itemNumber", () => {
  it("removes the item and keeps its history; re-adding restores it", async () => {
    await history.append("100511846", { checkedAt: "2026-11-08T09:00:00.000Z", status: "ok", price: 434.99 });

    const res = await del("100511846");
    expect(res.statusCode).toBe(204);
    expect((await items.list()).map((i) => i.itemNumber)).toEqual(["4201001045", "4000444300"]);
    expect(await history.get("100511846")).toHaveLength(1);
    expect((await get("/api/items")).json().items).toHaveLength(2);

    const again = await post({ url: LA_MER });
    expect(again.statusCode).toBe(201);
    expect(again.json().comparison).toMatchObject({ okCount: 1, current: { price: 434.99 } });
  });

  it("404s for an item not on the list", async () => {
    const res = await del("999999");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Item 999999 is not on the watch list.");
  });

  it("400s for something that isn't an item number", async () => {
    expect((await del("abc")).statusCode).toBe(400);
  });

  it("is refused to other websites", async () => {
    expect((await del("100511846", { origin: "https://evil.example" })).statusCode).toBe(403);
    expect(await items.list()).toHaveLength(3);
  });
});

describe("GET /api/items/:itemNumber/history", () => {
  it("returns every entry newest first, with the comparison", async () => {
    await history.append("100511846", { checkedAt: "2026-11-06T09:00:00.000Z", status: "ok", price: 449.99 });
    await history.append("100511846", { checkedAt: "2026-11-07T09:00:00.000Z", status: "failed", price: null, error: "no price found on the page" });
    await history.append("100511846", { checkedAt: "2026-11-08T09:00:00.000Z", status: "ok", price: 434.99 });

    const res = await get("/api/items/100511846/history");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: { checkedAt: string }) => e.checkedAt)).toEqual([
      "2026-11-08T09:00:00.000Z",
      "2026-11-07T09:00:00.000Z",
      "2026-11-06T09:00:00.000Z",
    ]);
    expect(body.entries[1]).toMatchObject({ status: "failed", error: "no price found on the page" });
    expect(body.item).toMatchObject({
      itemNumber: "100511846",
      name: "La Mer",
      comparison: { highest: { price: 449.99 }, lowest: { price: 434.99 }, average: 442.49, okCount: 2 },
    });
  });

  it("is empty for an item never checked", async () => {
    const body = (await get("/api/items/4201001045/history")).json();
    expect(body.entries).toEqual([]);
  });

  it("404s for an item not on the list", async () => {
    expect((await get("/api/items/999999/history")).statusCode).toBe(404);
  });
});

describe("portal files", () => {
  it.each([
    ["/", "text/html"],
    ["/app.js", "text/javascript"],
    ["/format.js", "text/javascript"],
    ["/style.css", "text/css"],
  ])("serves %s with a strict content security policy", async (url, type) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(type);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves nothing else from disk", async () => {
    for (const url of ["/../package.json", "/index.html/../../package.json", "/%2e%2e/package.json", "/format.d.ts"]) {
      expect((await get(url)).statusCode).toBe(404);
    }
  });
});
