import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryRepository, type HistoryEntry } from "../src/store/history";
import { JsonFileError } from "../src/store/jsonFile";

let dir: string;
let path: string;
let repo: HistoryRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-costco-history-"));
  path = join(dir, "history.json");
  repo = new HistoryRepository(path);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const entry = (checkedAt: string, price: number | null, status: HistoryEntry["status"] = price === null ? "failed" : "ok"): HistoryEntry => ({
  checkedAt,
  status,
  price,
});

describe("HistoryRepository", () => {
  it("is empty for an item with no history, and when the file doesn't exist", async () => {
    expect(await repo.get("100511846")).toEqual([]);
    expect(await repo.latestOk("100511846")).toBeNull();
    expect(await repo.getAll()).toEqual({});
  });

  it("appends entries per item and persists them", async () => {
    await repo.append("100511846", entry("2026-11-07T09:00:00.000Z", 434.99));
    await repo.append("4201001045", entry("2026-11-07T09:01:00.000Z", 1399.99));
    await repo.append("100511846", entry("2026-11-08T09:00:00.000Z", 399.99));

    expect((await repo.get("100511846")).map((e) => e.price)).toEqual([434.99, 399.99]);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["100511846", "4201001045"]);
  });

  it("keeps entries in time order even if appended out of order", async () => {
    await repo.append("1", entry("2026-11-08T09:00:00.000Z", 20));
    await repo.append("1", entry("2026-11-07T09:00:00.000Z", 10));
    expect((await repo.get("1")).map((e) => e.price)).toEqual([10, 20]);
  });

  it("stores failed and missed entries, and latestOk skips them", async () => {
    await repo.append("1", entry("2026-11-07T09:00:00.000Z", 10));
    await repo.append("1", { checkedAt: "2026-11-08T09:00:00.000Z", status: "failed", price: null, error: "no price found" });
    await repo.append("1", { checkedAt: "2026-11-09T09:00:00.000Z", status: "missed", price: null, runId: "run-1" });
    expect(await repo.get("1")).toHaveLength(3);
    expect((await repo.latestOk("1"))?.checkedAt).toBe("2026-11-07T09:00:00.000Z");
  });

  it.each([
    ["ok without a price", { checkedAt: "2026-11-07T09:00:00.000Z", status: "ok", price: null }],
    ["failed with a price", { checkedAt: "2026-11-07T09:00:00.000Z", status: "failed", price: 10 }],
    ["zero price", { checkedAt: "2026-11-07T09:00:00.000Z", status: "ok", price: 0 }],
    ["bad timestamp", { checkedAt: "yesterday", status: "ok", price: 10 }],
  ])("rejects an invalid entry: %s", async (_name, bad) => {
    await expect(repo.append("1", bad as HistoryEntry)).rejects.toThrow();
    expect(await repo.get("1")).toEqual([]);
  });

  it("refuses a corrupt file and never overwrites it", async () => {
    await writeFile(path, "[oops");
    await expect(repo.get("1")).rejects.toThrow(JsonFileError);
    await expect(repo.append("1", entry("2026-11-07T09:00:00.000Z", 10))).rejects.toThrow(JsonFileError);
    expect(await readFile(path, "utf8")).toBe("[oops");
  });

  it("refuses a file with invalid entries", async () => {
    await writeFile(path, JSON.stringify({ "1": [{ checkedAt: "2026-11-07T09:00:00.000Z", status: "ok", price: -5 }] }));
    await expect(repo.getAll()).rejects.toThrow(/invalid content/);
  });

  it("serializes concurrent appends so none are lost", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => repo.append("1", entry(new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), 10 + i))),
    );
    expect(await repo.get("1")).toHaveLength(20);
  });
});
