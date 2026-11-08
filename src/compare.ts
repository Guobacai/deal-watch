// Compare an item's latest price with its history. Pure: no I/O.
// Only "ok" entries count toward prices and statistics; failed/missed entries
// are reported through `lastAttempt` so the portal can show a ⚠.
import type { HistoryEntry } from "./store/history";

export interface PricePoint {
  price: number;
  checkedAt: string;
}

export interface Comparison {
  current: PricePoint | null; // latest successful price
  previous: PricePoint | null; // the successful price before that
  change: { amount: number; percent: number } | null; // current − previous
  lowest: PricePoint | null; // earliest time the lowest price was seen
  highest: PricePoint | null;
  average: number | null;
  isFirstCheck: boolean; // exactly one successful price so far
  isNewLow: boolean; // current is strictly below every earlier successful price
  okCount: number;
  lastAttempt: { status: HistoryEntry["status"]; checkedAt: string; error?: string } | null; // latest entry of any status
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function compare(entries: readonly HistoryEntry[]): Comparison {
  const sorted = [...entries].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  const ok: PricePoint[] = sorted
    .filter((e) => e.status === "ok" && e.price !== null)
    .map((e) => ({ price: e.price!, checkedAt: e.checkedAt }));

  const last = sorted.at(-1);
  const lastAttempt = last
    ? { status: last.status, checkedAt: last.checkedAt, ...(last.error ? { error: last.error } : {}) }
    : null;

  if (ok.length === 0) {
    return {
      current: null,
      previous: null,
      change: null,
      lowest: null,
      highest: null,
      average: null,
      isFirstCheck: false,
      isNewLow: false,
      okCount: 0,
      lastAttempt,
    };
  }

  const current = ok.at(-1)!;
  const previous = ok.length > 1 ? ok.at(-2)! : null;
  const change = previous
    ? {
        amount: cents(current.price - previous.price),
        percent: Math.round(((current.price - previous.price) / previous.price) * 1000) / 10,
      }
    : null;

  let lowest = ok[0];
  let highest = ok[0];
  for (const p of ok) {
    if (p.price < lowest.price) lowest = p;
    if (p.price > highest.price) highest = p;
  }
  const earlier = ok.slice(0, -1);
  const isNewLow = earlier.length > 0 && earlier.every((p) => current.price < p.price);

  return {
    current,
    previous,
    change,
    lowest,
    highest,
    average: cents(ok.reduce((sum, p) => sum + p.price, 0) / ok.length),
    isFirstCheck: ok.length === 1,
    isNewLow,
    okCount: ok.length,
    lastAttempt,
  };
}
