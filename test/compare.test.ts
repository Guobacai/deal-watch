import { describe, expect, it } from "vitest";
import { compare } from "../src/compare";
import type { HistoryEntry } from "../src/store/history";

let day = 0;
const at = (d: number) => new Date(Date.UTC(2026, 10, 1 + d, 9)).toISOString();
const ok = (price: number, d = day++): HistoryEntry => ({ checkedAt: at(d), status: "ok", price });
const failed = (d = day++): HistoryEntry => ({ checkedAt: at(d), status: "failed", price: null, error: "no price found" });
const missed = (d = day++): HistoryEntry => ({ checkedAt: at(d), status: "missed", price: null });

describe("compare()", () => {
  it("no history at all", () => {
    expect(compare([])).toMatchObject({
      current: null,
      previous: null,
      change: null,
      lowest: null,
      highest: null,
      average: null,
      isFirstCheck: false,
      isNewLow: false,
      okCount: 0,
      lastAttempt: null,
    });
  });

  it("only failures: no prices, but the last attempt is reported", () => {
    const r = compare([failed(0), missed(1)]);
    expect(r.current).toBeNull();
    expect(r.lastAttempt).toEqual({ status: "missed", checkedAt: at(1) });
  });

  it("first successful check", () => {
    const r = compare([ok(24.99, 0)]);
    expect(r).toMatchObject({
      current: { price: 24.99 },
      previous: null,
      change: null,
      lowest: { price: 24.99 },
      highest: { price: 24.99 },
      average: 24.99,
      isFirstCheck: true,
      isNewLow: false,
      okCount: 1,
    });
  });

  it.each([
    { name: "price drop", prices: [24.99, 19.99], amount: -5, percent: -20, newLow: true },
    { name: "price increase", prices: [19.99, 24.99], amount: 5, percent: 25, newLow: false },
    { name: "no change", prices: [899.99, 899.99], amount: 0, percent: 0, newLow: false },
    { name: "drop, but not below an older low", prices: [849.99, 999.99, 899.99], amount: -100, percent: -10, newLow: false },
    { name: "equal to the old low is not a new low", prices: [849.99, 999.99, 849.99], amount: -150, percent: -15, newLow: false },
    { name: "cents stay exact", prices: [0.3, 0.1], amount: -0.2, percent: -66.7, newLow: true },
  ])("$name", ({ prices, amount, percent, newLow }) => {
    const r = compare(prices.map((p, i) => ok(p, i)));
    expect(r.change).toEqual({ amount, percent });
    expect(r.isNewLow).toBe(newLow);
    expect(r.isFirstCheck).toBe(false);
  });

  it("lowest, highest and average across all successful checks", () => {
    const r = compare([ok(100, 0), ok(80, 1), ok(120, 2), ok(90, 3)]);
    expect(r.lowest).toEqual({ price: 80, checkedAt: at(1) });
    expect(r.highest).toEqual({ price: 120, checkedAt: at(2) });
    expect(r.average).toBe(97.5);
    expect(r.okCount).toBe(4);
  });

  it("reports the earliest time the lowest price was seen", () => {
    const r = compare([ok(50, 0), ok(40, 1), ok(40, 2)]);
    expect(r.lowest?.checkedAt).toBe(at(1));
  });

  it("failed and missed entries don't affect prices or statistics", () => {
    const r = compare([ok(24.99, 0), failed(1), missed(2), ok(19.99, 3), failed(4)]);
    expect(r.current).toEqual({ price: 19.99, checkedAt: at(3) });
    expect(r.previous).toEqual({ price: 24.99, checkedAt: at(0) });
    expect(r.change).toEqual({ amount: -5, percent: -20 });
    expect(r.average).toBe(22.49);
    expect(r.okCount).toBe(2);
    expect(r.lastAttempt).toEqual({ status: "failed", checkedAt: at(4), error: "no price found" });
  });

  it("works on entries given out of order", () => {
    const r = compare([ok(19.99, 3), ok(24.99, 0)]);
    expect(r.current?.price).toBe(19.99);
    expect(r.previous?.price).toBe(24.99);
  });
});
