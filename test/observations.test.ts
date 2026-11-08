import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, isAllowedRequest } from "../src/server";
import { HistoryRepository } from "../src/store/history";
import { ItemRepository } from "../src/store/items";

const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const LA_MER = "https://www.costco.com/p/-/la-mer-creme-de-la-mer-moisturizing-cream-34-oz/100511846";
const UNWATCHED = "https://www.costco.com/p/-/something-else/999999";

let dir: string;
let items: ItemRepository;
let history: HistoryRepository;
let app: FastifyInstance;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-costco-api-"));
  items = new ItemRepository(join(dir, "items.json"));
  history = new HistoryRepository(join(dir, "history.json"));
  await items.add({ url: LA_MER });
  clock = new Date("2026-11-08T09:00:00Z");
  app = buildServer({ port: PORT, items, history, dedupeWindowMs: 10 * 60_000, now: () => clock });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/observations", headers: { host: HOST, origin: EXT, ...headers }, payload: body as object });

const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));

describe("POST /api/observations", () => {
  it("saves a price for a watched item, fills in its name, and returns the comparison", async () => {
    const res = await post({ url: LA_MER, price: 434.99, name: "La Mer Creme", via: "ld+json" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      watched: true,
      saved: true,
      itemNumber: "100511846",
      entry: { status: "ok", price: 434.99, checkedAt: "2026-11-08T09:00:00.000Z" },
      comparison: { isFirstCheck: true, current: { price: 434.99 } },
    });
    expect(await history.get("100511846")).toHaveLength(1);
    expect((await items.list())[0].name).toBe("La Mer Creme");
  });

  it("compares with the previous price on the next capture", async () => {
    await post({ url: LA_MER, price: 434.99 });
    minutes(24 * 60);
    const res = await post({ url: LA_MER, price: 399.99 });
    expect(res.json().comparison).toMatchObject({ change: { amount: -35, percent: -8 }, isNewLow: true });
  });

  it("ignores items that aren't on the watch list", async () => {
    const res = await post({ url: UNWATCHED, price: 10 });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ watched: false, saved: false, itemNumber: "999999" });
    expect(await history.getAll()).toEqual({});
  });

  it("records a page with no readable price as failed", async () => {
    const res = await post({ url: LA_MER, price: null, error: "Sign in to see price" });
    expect(res.statusCode).toBe(201);
    expect(res.json().entry).toMatchObject({ status: "failed", price: null, error: "Sign in to see price" });
  });

  it("collapses a reload with the same price within 10 minutes", async () => {
    await post({ url: LA_MER, price: 434.99 });
    minutes(5);
    const res = await post({ url: LA_MER, price: 434.99 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saved: false, duplicate: true });
    expect(await history.get("100511846")).toHaveLength(1);
  });

  it("stores the same price again after 10 minutes, or a different price right away", async () => {
    await post({ url: LA_MER, price: 434.99 });
    minutes(1);
    expect((await post({ url: LA_MER, price: 429.99 })).statusCode).toBe(201);
    minutes(11);
    expect((await post({ url: LA_MER, price: 429.99 })).statusCode).toBe(201);
    expect(await history.get("100511846")).toHaveLength(3);
  });

  it("doesn't store duplicates when two captures arrive at once", async () => {
    await Promise.all([post({ url: LA_MER, price: 434.99 }), post({ url: LA_MER, price: 434.99 })]);
    expect(await history.get("100511846")).toHaveLength(1);
  });

  it("keeps the original capture time for a capture that was queued while the service was down", async () => {
    const res = await post({ url: LA_MER, price: 434.99, capturedAt: "2026-11-08T07:30:00.000Z" });
    expect(res.json().entry.checkedAt).toBe("2026-11-08T07:30:00.000Z");
  });

  it("ignores a capture time in the future and uses the server's time", async () => {
    const res = await post({ url: LA_MER, price: 434.99, capturedAt: "2026-11-09T09:00:00.000Z" });
    expect(res.json().entry.checkedAt).toBe("2026-11-08T09:00:00.000Z");
  });

  it("treats a late-arriving copy of an earlier capture as a duplicate", async () => {
    await post({ url: LA_MER, price: 434.99 }); // 09:00
    minutes(30);
    const res = await post({ url: LA_MER, price: 434.99, capturedAt: "2026-11-08T08:58:00.000Z" });
    expect(res.json()).toMatchObject({ duplicate: true });
  });

  it("ignores a run id sent by the client (the service assigns run ids)", async () => {
    await post({ url: LA_MER, price: 434.99, runId: "run-2026-11-08" });
    expect((await history.get("100511846"))[0].runId).toBeUndefined();
  });

  it("uses the item number from the URL, ignoring the query string", async () => {
    const res = await post({ url: `${LA_MER}?langId=-1`, itemNumber: "100511846", price: 434.99 });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ["missing price", { url: LA_MER }],
    ["negative price", { url: LA_MER, price: -1 }],
    ["price as a string", { url: LA_MER, price: "434.99" }],
    ["not a Costco product URL", { url: "https://www.costco.com/", price: 10 }],
    ["another site", { url: "https://example.com/p/-/x/100511846", price: 10 }],
    ["item number doesn't match the URL", { url: LA_MER, itemNumber: "123", price: 10 }],
  ])("rejects an invalid payload: %s", async (_name, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect(await history.getAll()).toEqual({});
  });

  it("rejects a non-JSON body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/observations",
      headers: { host: HOST, origin: EXT, "content-type": "text/plain" },
      payload: "price=1",
    });
    expect(res.statusCode).toBe(415);
  });

  it("returns 500 with a clear message when the history file is corrupt, and doesn't overwrite it", async () => {
    await writeFile(join(dir, "history.json"), "{broken");
    const res = await post({ url: LA_MER, price: 434.99 });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/history\.json.*not valid JSON/);
    expect(await readFile(join(dir, "history.json"), "utf8")).toBe("{broken");
  });
});

describe("request guard", () => {
  it("blocks other websites", async () => {
    const res = await post({ url: LA_MER, price: 1 }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(await history.getAll()).toEqual({});
  });

  it("blocks requests addressed to another host name (DNS rebinding)", async () => {
    const res = await post({ url: LA_MER, price: 1 }, { host: `evil.example:${PORT}` });
    expect(res.statusCode).toBe(403);
  });

  it("allows the portal's own origin and requests without an origin", async () => {
    expect((await post({ url: LA_MER, price: 1 }, { origin: `http://localhost:${PORT}` })).statusCode).toBe(201);
    const health = await app.inject({ method: "GET", url: "/api/health", headers: { host: HOST } });
    expect(health.json()).toEqual({ ok: true });
  });

  it.each([
    [HOST, EXT, true],
    [`localhost:${PORT}`, undefined, true],
    [HOST, `http://${HOST}`, true],
    [HOST, "https://www.costco.com", false],
    [HOST, "chrome-extension://short", false],
    [HOST, "null", false],
    ["127.0.0.1:9999", undefined, false],
    [undefined, undefined, false],
  ])("isAllowedRequest(host=%s, origin=%s) → %s", (host, origin, expected) => {
    expect(isAllowedRequest(PORT, host, origin)).toBe(expected);
  });
});
