// Turns /api/items data into what each table cell shows. Pure (no DOM), so it is unit-tested.

/** @param {number} n */
export const money = (n) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "9:01 AM" today, "yesterday 9:01 AM", otherwise "Nov 6". Uses the browser's time zone. */
export function when(iso, now = new Date()) {
  const t = new Date(iso);
  const time = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay(t, now)) return time;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(t, y)) return `yesterday ${time}`;
  const opts = { month: "short", day: "numeric" };
  if (t.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return t.toLocaleDateString("en-US", opts);
}

/**
 * @typedef {{ text: string, tone?: "down" | "up" | "warn" | "muted", title?: string }} Cell
 * @returns {{ current: Cell, previous: Cell, change: Cell, lowest: Cell, checked: Cell }}
 */
export function describeRow(item, now = new Date()) {
  const c = item.comparison;
  const last = c.lastAttempt;
  const none = { text: "none", tone: "muted" };

  if (!last) {
    return {
      current: { text: "–", tone: "muted" },
      previous: none,
      change: { text: "not checked yet", tone: "muted" },
      lowest: none,
      checked: { text: "never", tone: "muted" },
    };
  }

  const checked = { text: when(last.checkedAt, now), title: new Date(last.checkedAt).toLocaleString() };
  const lowest = c.lowest && c.okCount > 1
    ? { text: `${money(c.lowest.price)}${c.isNewLow ? " ★" : ""}`, tone: c.isNewLow ? "down" : undefined }
    : none;

  // The latest attempt didn't get a price: show the warning, with the last good price as "Previous".
  if (last.status !== "ok") {
    return {
      current: { text: `⚠ ${last.status}`, tone: "warn", title: last.error ?? `This check was ${last.status}.` },
      previous: c.current ? { text: money(c.current.price) } : none,
      change: { text: "n/a", tone: "muted" },
      lowest: c.lowest ? { text: money(c.lowest.price) } : none,
      checked: { ...checked, tone: "warn" },
    };
  }

  const current = { text: money(c.current.price) };
  if (c.isFirstCheck || !c.previous) {
    return { current, previous: none, change: { text: "first check", tone: "muted" }, lowest: none, checked };
  }

  const { amount, percent } = c.change;
  let change;
  if (amount < 0) change = { text: `▼ ${money(-amount)} (−${Math.abs(percent)}%)`, tone: "down" };
  else if (amount > 0) change = { text: `▲ ${money(amount)} (+${percent}%)`, tone: "up" };
  else change = { text: "no change", tone: "muted" };

  return { current, previous: { text: money(c.previous.price) }, change, lowest, checked };
}

/** Header text: when the newest price came in and how many items have a good price from today. */
export function describeSummary(data, now = new Date()) {
  const total = data.items.length;
  if (!data.lastCheckedAt) return { text: total ? "No prices yet" : "", checkedToday: 0, total };
  const checkedToday = data.items.filter(
    (i) => i.comparison.lastAttempt?.status === "ok" && sameDay(new Date(i.comparison.lastAttempt.checkedAt), now),
  ).length;
  const t = new Date(data.lastCheckedAt);
  const day = sameDay(t, now) ? "today " : "";
  return { text: `Last check: ${day}${when(data.lastCheckedAt, now)}`, checkedToday, total };
}

/** One line of the history list. */
export function describeEntry(entry, now = new Date()) {
  const date = new Date(entry.checkedAt);
  const sameYear = date.getFullYear() === now.getFullYear();
  const text = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  if (entry.status === "ok") return { when: text, price: { text: money(entry.price) } };
  return {
    when: text,
    price: { text: `⚠ ${entry.status}`, tone: "warn", title: entry.error ?? `This check was ${entry.status}.` },
  };
}

/** Highest / average / lowest for the detail panel, or null before the first good price. */
export function describeStats(c) {
  if (!c.okCount) return null;
  return {
    highest: money(c.highest.price),
    average: money(c.average),
    lowest: money(c.lowest.price),
    count: `${c.okCount} price${c.okCount === 1 ? "" : "s"}`,
  };
}

/**
 * Where to draw each good price on a width × height chart, oldest on the left.
 * Spaced by time; a flat line sits in the middle. Returns null when there's nothing to draw.
 */
export function chartGeometry(entries, width, height, pad = 8) {
  const ok = entries
    .filter((e) => e.status === "ok" && e.price !== null)
    .map((e) => ({ t: new Date(e.checkedAt).getTime(), price: e.price, checkedAt: e.checkedAt }))
    .sort((a, b) => a.t - b.t);
  if (ok.length === 0) return null;
  const tMin = ok[0].t;
  const tSpan = ok.at(-1).t - tMin;
  const prices = ok.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const round = (n) => Math.round(n * 10) / 10;
  const points = ok.map((p, i) => ({
    x: round(pad + (tSpan > 0 ? ((p.t - tMin) / tSpan) * innerW : ok.length === 1 ? innerW / 2 : (i / (ok.length - 1)) * innerW)),
    y: round(pad + (max > min ? ((max - p.price) / (max - min)) * innerH : innerH / 2)),
    price: p.price,
    checkedAt: p.checkedAt,
  }));
  return { points, min, max };
}

const RUN_ICONS = { pending: "…", ok: "✓", failed: "✗", missed: "⚠" };
const RUN_TONES = { pending: "muted", ok: "down", failed: "warn", missed: "warn" };

/** What the run banner shows for a run in progress, or for the last finished one. */
export function describeRun(run, now = new Date()) {
  const finished = "finishedAt" in run;
  const total = run.items.length;
  const ok = run.items.filter((i) => i.status === "ok").length;
  const failed = run.items.filter((i) => i.status === "failed").length;
  const missed = run.items.filter((i) => i.status === "missed").length;
  const reported = ok + failed;
  const items = run.items.map((i) => ({
    itemNumber: i.itemNumber,
    name: i.name || `Item #${i.itemNumber}`,
    icon: RUN_ICONS[i.status],
    tone: RUN_TONES[i.status],
    text: i.status === "ok" ? money(i.price) : i.status === "pending" ? "waiting" : i.status,
  }));
  if (!finished) {
    return {
      state: "running",
      title: `Checking ${total} item${total === 1 ? "" : "s"} in Chrome…`,
      detail: `${reported} of ${total} reported · ${ok} saved · gives up at ${when(run.deadline, now)}`,
      items,
    };
  }
  const problems = [failed && `${failed} failed`, missed && `${missed} missed`].filter(Boolean).join(", ");
  return {
    state: problems ? "warn" : "done",
    title: `Check finished ${when(run.finishedAt, now)}`,
    detail: `${ok} of ${total} saved${problems ? ` · ${problems}` : " ✓"}`,
    items,
  };
}
