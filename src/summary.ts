// The notification sent when a check run finishes.
import { compare } from "./compare";
import type { Notification } from "./notify/types";
import type { HistoryRepository } from "./store/history";
import type { RunSummary } from "./store/state";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface PriceDrop {
  name: string;
  price: number;
  amount: number; // how much cheaper than the previous price
  percent: number;
  isNewLow: boolean;
}

/** Items in this run whose saved price is lower than their previous price. Biggest drop (in %) first. */
export async function findDrops(summary: RunSummary, history: HistoryRepository): Promise<PriceDrop[]> {
  const drops: PriceDrop[] = [];
  for (const item of summary.items) {
    if (item.status !== "ok" || item.price === undefined) continue;
    const c = compare(await history.get(item.itemNumber));
    if (c.current?.price !== item.price || !c.change || c.change.amount >= 0) continue;
    drops.push({
      name: item.name || `Item #${item.itemNumber}`,
      price: item.price,
      amount: -c.change.amount,
      percent: Math.abs(c.change.percent),
      isNewLow: c.isNewLow,
    });
  }
  return drops.sort((a, b) => b.percent - a.percent);
}

export function summaryNotification(summary: RunSummary, drops: PriceDrop[], portalUrl: string): Notification {
  const total = summary.items.length;
  const newLows = drops.filter((d) => d.isNewLow).length;
  const parts = [plural(total, "item")];
  if (drops.length) parts.push(plural(drops.length, "price drop"));
  if (newLows) parts.push(plural(newLows, "new low"));
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.missed) parts.push(`${summary.missed} missed`);
  if (!drops.length && !summary.failed && !summary.missed) parts.push("no price drops");

  let message = parts.join(" · ");
  const top = drops[0];
  if (top) {
    const name = top.name.length > 40 ? `${top.name.slice(0, 39)}…` : top.name;
    message += `\n▼ ${name} ${money(top.price)} (−${top.percent}%)${top.isNewLow ? " ★" : ""}`;
  }
  return { title: "Costco prices checked", message, url: `${portalUrl}/` };
}
