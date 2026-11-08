import { describe, expect, it } from "vitest";
import { chartGeometry, describeEntry, describeRow, describeStats, describeSummary, money, when } from "../public/format.js";
import { compare } from "../src/compare";
import type { HistoryEntry } from "../src/store/history";

// Local times, so the tests pass in any time zone.
const NOW = new Date(2026, 10, 8, 15, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const ok = (iso: string, price: number): HistoryEntry => ({ checkedAt: iso, status: "ok", price });
const item = (entries: HistoryEntry[]) => ({
  itemNumber: "1",
  name: "Thing",
  url: "https://www.costco.com/p/-/thing/1",
  addedAt: at(1, 9),
  comparison: compare(entries),
});

describe("money / when", () => {
  it("formats dollars", () => {
    expect(money(1399.99)).toBe("$1,399.99");
    expect(money(5)).toBe("$5.00");
  });
  it("shows the time today, 'yesterday', or a date", () => {
    expect(when(at(8, 9, 1), NOW)).toBe("9:01 AM");
    expect(when(at(7, 21, 30), NOW)).toBe("yesterday 9:30 PM");
    expect(when(at(3, 9), NOW)).toBe("Nov 3");
  });
});

describe("describeRow", () => {
  it("never checked", () => {
    const r = describeRow(item([]), NOW);
    expect(r.current.text).toBe("–");
    expect(r.change.text).toBe("not checked yet");
    expect(r.checked.text).toBe("never");
  });

  it("first check", () => {
    const r = describeRow(item([ok(at(8, 9), 199.99)]), NOW);
    expect(r).toMatchObject({
      current: { text: "$199.99" },
      previous: { text: "none" },
      change: { text: "first check" },
      lowest: { text: "none" },
      checked: { text: "9:00 AM" },
    });
  });

  it("price drop to a new low is green with a star", () => {
    const r = describeRow(item([ok(at(6, 9), 24.99), ok(at(7, 9), 22.99), ok(at(8, 9), 19.99)]), NOW);
    expect(r.current.text).toBe("$19.99");
    expect(r.previous.text).toBe("$22.99");
    expect(r.change).toEqual({ text: "▼ $3.00 (−13%)", tone: "down" });
    expect(r.lowest).toEqual({ text: "$19.99 ★", tone: "down" });
  });

  it("price drop that isn't a new low has no star", () => {
    const r = describeRow(item([ok(at(6, 9), 10), ok(at(7, 9), 15), ok(at(8, 9), 12)]), NOW);
    expect(r.change.tone).toBe("down");
    expect(r.lowest.text).toBe("$10.00");
  });

  it("price increase is red", () => {
    const r = describeRow(item([ok(at(7, 9), 849.99), ok(at(8, 9), 899.99)]), NOW);
    expect(r.change).toEqual({ text: "▲ $50.00 (+5.9%)", tone: "up" });
    expect(r.lowest.text).toBe("$849.99");
  });

  it("no change", () => {
    const r = describeRow(item([ok(at(7, 9), 899.99), ok(at(8, 9), 899.99)]), NOW);
    expect(r.change.text).toBe("no change");
  });

  it.each(["missed", "failed"] as const)("%s check shows a warning and keeps the last good price", (status) => {
    const r = describeRow(
      item([
        ok(at(6, 9), 11.49),
        ok(at(7, 9), 12.99),
        { checkedAt: at(8, 9), status, price: null, ...(status === "failed" ? { error: "no price found on the page" } : {}) },
      ]),
      NOW,
    );
    expect(r.current).toMatchObject({ text: `⚠ ${status}`, tone: "warn" });
    if (status === "failed") expect(r.current.title).toBe("no price found on the page");
    expect(r.previous.text).toBe("$12.99");
    expect(r.change.text).toBe("n/a");
    expect(r.lowest.text).toBe("$11.49");
    expect(r.checked.tone).toBe("warn");
  });

  it("a failed check on an item that never had a price", () => {
    const r = describeRow(item([{ checkedAt: at(8, 9), status: "failed", price: null, error: "x" }]), NOW);
    expect(r.current.text).toBe("⚠ failed");
    expect(r.previous.text).toBe("none");
    expect(r.lowest.text).toBe("none");
  });
});

describe("describeSummary", () => {
  it("counts items with a good price from today", () => {
    const data = {
      items: [item([ok(at(8, 9), 1)]), item([ok(at(7, 9), 1)]), item([{ checkedAt: at(8, 10), status: "missed", price: null }])],
      lastCheckedAt: at(8, 10),
    };
    expect(describeSummary(data, NOW)).toEqual({ text: "Last check: today 10:00 AM", checkedToday: 1, total: 3 });
  });
  it("says when there are no prices yet", () => {
    expect(describeSummary({ items: [item([])], lastCheckedAt: null }, NOW).text).toBe("No prices yet");
  });
});

describe("history panel", () => {
  it("describes entries", () => {
    expect(describeEntry(ok(at(8, 9, 5), 19.99), NOW)).toEqual({ when: "Nov 8, 9:05 AM", price: { text: "$19.99" } });
    expect(describeEntry({ checkedAt: at(7, 9), status: "missed", price: null }, NOW).price).toEqual({
      text: "⚠ missed",
      tone: "warn",
      title: "This check was missed.",
    });
  });

  it("describes stats, or null before any price", () => {
    expect(describeStats(compare([ok(at(6, 9), 10), ok(at(7, 9), 20), ok(at(8, 9), 15)]))).toEqual({
      highest: "$20.00",
      average: "$15.00",
      lowest: "$10.00",
      count: "3 prices",
    });
    expect(describeStats(compare([{ checkedAt: at(8, 9), status: "failed", price: null }]))).toBeNull();
  });

  it("charts good prices by time: oldest left, highest at the top", () => {
    const g = chartGeometry(
      [ok(at(6, 0), 20), { checkedAt: at(7, 0), status: "missed", price: null }, ok(at(8, 0), 10), ok(at(7, 0), 15)],
      120,
      60,
      10,
    );
    expect(g?.min).toBe(10);
    expect(g?.max).toBe(20);
    expect(g?.points.map((p: { x: number; y: number; price: number }) => [p.x, p.y, p.price])).toEqual([
      [10, 10, 20],
      [60, 30, 15],
      [110, 50, 10],
    ]);
  });

  it("draws one price, or a flat line, in the middle", () => {
    expect(chartGeometry([ok(at(8, 0), 5)], 120, 60, 10)?.points[0]).toMatchObject({ x: 60, y: 30 });
    const flat = chartGeometry([ok(at(7, 0), 5), ok(at(8, 0), 5)], 120, 60, 10);
    expect(flat?.points.map((p: { y: number }) => p.y)).toEqual([30, 30]);
  });

  it("has nothing to draw without a good price", () => {
    expect(chartGeometry([], 120, 60)).toBeNull();
    expect(chartGeometry([{ checkedAt: at(8, 0), status: "failed", price: null }], 120, 60)).toBeNull();
  });
});
