// Portal page: the price table, adding and removing items, and each item's history.
// All text goes in via textContent; nothing from the data is parsed as HTML.
import { chartGeometry, describeEntry, describeRow, describeRun, describeStats, describeSummary, money } from "./format.js";

const REFRESH_MS = 30_000;
const COLUMNS = 7;
const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

let openItem = null; // itemNumber whose history is showing
let detailRow = null; // its <tr>, kept across refreshes so it doesn't flicker

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

// ---- Table ----

function cell(c, cls = "") {
  const td = el("td", { className: [cls, c.tone].filter(Boolean).join(" "), textContent: c.text });
  if (c.title) td.title = c.title;
  return td;
}

function itemCell(item, expanded) {
  const label = item.name || `Item ${item.itemNumber}`;
  const toggle = el("button", {
    type: "button",
    className: "toggle",
    textContent: expanded ? "▾" : "▸",
    title: expanded ? "Hide price history" : "Show price history",
  });
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} price history for ${label}`);
  toggle.dataset.action = "toggle";

  // The URL was checked to be a costco.com product page when the item was added.
  const link = el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", textContent: label });
  const inner = el("div", { className: "item-inner" }, toggle, el("div", {}, link, el("span", { className: "num-id", textContent: `#${item.itemNumber}` })));
  return el("td", { className: "item" }, inner);
}

function removeCell(item) {
  const label = item.name || `Item ${item.itemNumber}`;
  const button = el("button", { type: "button", className: "remove", textContent: "Remove" });
  button.setAttribute("aria-label", `Remove ${label}`);
  button.dataset.action = "remove";
  return el("td", { className: "actions" }, button);
}

function render(data) {
  const now = new Date();
  if (openItem && !data.items.some((i) => i.itemNumber === openItem)) closeDetail();

  const rows = [];
  for (const item of data.items) {
    const r = describeRow(item, now);
    const expanded = item.itemNumber === openItem;
    const tr = el(
      "tr",
      { className: `row${expanded ? " open" : ""}` },
      itemCell(item, expanded),
      cell(r.current, "num"),
      cell(r.previous, "num"),
      cell(r.change),
      cell(r.lowest, "num"),
      cell(r.checked),
      removeCell(item),
    );
    tr.dataset.item = item.itemNumber;
    tr.dataset.name = item.name || `Item ${item.itemNumber}`;
    rows.push(tr);
    if (expanded) rows.push(detailRow);
  }
  $("rows").replaceChildren(...rows);
  $("empty").hidden = data.items.length > 0;

  const s = describeSummary(data, now);
  const summary = $("summary");
  summary.replaceChildren();
  if (s.text) {
    summary.append(s.text);
    if (s.total) {
      const all = s.checkedToday === s.total;
      summary.append(
        el("span", { className: all ? "ok" : "", textContent: ` · ${s.checkedToday} of ${s.total} checked today${all ? " ✓" : ""}` }),
      );
    }
  }
}

async function load() {
  try {
    render(await api("GET", "/api/items"));
    showError("");
    if (openItem) await loadDetail(openItem);
  } catch (e) {
    showError(`Couldn't load prices: ${e.message}. Is \`npm start\` running?`);
  }
}

// ---- History panel ----

function closeDetail() {
  openItem = null;
  detailRow = null;
}

function chart(entries) {
  const W = 600;
  const H = 140;
  const g = chartGeometry(entries, W, H, 20);
  if (!g) return el("p", { className: "muted", textContent: "No prices yet, so there's nothing to chart." });

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  const first = g.points[0];
  const last = g.points.at(-1);
  root.setAttribute(
    "aria-label",
    `Price chart: ${g.points.length} prices from ${money(first.price)} to ${money(last.price)}, lowest ${money(g.min)}, highest ${money(g.max)}`,
  );

  // Dashed guide lines at the highest and lowest price, labelled on the right.
  const ys = g.points.map((p) => p.y);
  const guides = g.max > g.min
    ? [{ y: Math.min(...ys), label: money(g.max), dy: -5 }, { y: Math.max(...ys), label: money(g.min), dy: 14 }]
    : [{ y: ys[0], label: money(g.max), dy: -5 }];
  for (const { y, label, dy } of guides) {
    root.append(svg("line", { x1: 0, x2: W, y1: y, y2: y, class: "grid" }));
    const text = svg("text", { x: W, y: y + dy, class: "label", "text-anchor": "end" });
    text.textContent = label;
    root.append(text);
  }

  if (g.points.length > 1) {
    root.append(svg("polyline", { points: g.points.map((p) => `${p.x},${p.y}`).join(" "), class: "line" }));
  }
  for (const p of g.points) {
    const dot = svg("circle", { cx: p.x, cy: p.y, r: 4, class: p.price === g.min ? "dot low" : "dot" });
    const tip = svg("title");
    tip.textContent = `${money(p.price)} · ${new Date(p.checkedAt).toLocaleString()}`;
    dot.append(tip);
    root.append(dot);
  }

  const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const axis = el("div", { className: "axis" }, el("span", { textContent: day(first.checkedAt) }));
  if (g.points.length > 1) axis.append(el("span", { textContent: day(last.checkedAt) }));
  return el("div", { className: "chart-wrap" }, root, axis);
}

function detailContent(data) {
  const now = new Date();
  const stats = describeStats(data.item.comparison);
  const statsLine = stats
    ? el(
        "div",
        { className: "stats" },
        el("span", {}, "Highest ", el("strong", { textContent: stats.highest })),
        el("span", {}, "Average ", el("strong", { textContent: stats.average })),
        el("span", {}, "Lowest ", el("strong", { textContent: stats.lowest })),
        el("span", { className: "muted", textContent: stats.count }),
      )
    : el("div", { className: "stats muted", textContent: "No prices saved yet. Open this item's page in Chrome to get one." });

  const list = data.entries.length
    ? el(
        "table",
        { className: "history" },
        el("thead", {}, el("tr", {}, el("th", { scope: "col", textContent: "Checked" }), el("th", { scope: "col", className: "num", textContent: "Price" }))),
        el(
          "tbody",
          {},
          ...data.entries.map((e) => {
            const d = describeEntry(e, now);
            return el("tr", {}, el("td", { textContent: d.when }), cell(d.price, "num"));
          }),
        ),
      )
    : el("p", { className: "muted", textContent: "No checks yet." });

  return [statsLine, chart(data.entries), list];
}

async function loadDetail(itemNumber) {
  try {
    const data = await api("GET", `/api/items/${encodeURIComponent(itemNumber)}/history`);
    if (openItem !== itemNumber || !detailRow) return; // closed while loading
    detailRow.firstChild.replaceChildren(...detailContent(data));
  } catch (e) {
    if (openItem === itemNumber && detailRow) {
      detailRow.firstChild.replaceChildren(el("p", { className: "warn", textContent: `Couldn't load history: ${e.message}` }));
    }
  }
}

function toggleDetail(itemNumber) {
  if (openItem === itemNumber) {
    closeDetail();
  } else {
    openItem = itemNumber;
    detailRow = el("tr", { className: "detail" }, el("td", { colSpan: COLUMNS }, el("p", { className: "muted", textContent: "Loading…" })));
  }
  void load();
}

// ---- Remove ----

async function removeItem(itemNumber, name) {
  const ok = window.confirm(
    `Remove "${name}" from the watch list?\n\nIts price history is kept. If you add the same item again, the history comes back.`,
  );
  if (!ok) return;
  try {
    await api("DELETE", `/api/items/${encodeURIComponent(itemNumber)}`);
    if (openItem === itemNumber) closeDetail();
    await load();
  } catch (e) {
    showError(`Couldn't remove: ${e.message}`);
  }
}

$("rows").addEventListener("click", (event) => {
  const target = event.target;
  const row = target.closest("tr.row");
  if (!row) return;
  const action = target.closest("button")?.dataset.action;
  if (action === "remove") return void removeItem(row.dataset.item, row.dataset.name);
  if (action === "toggle" || !target.closest("a, button")) toggleDetail(row.dataset.item);
});

// ---- Add ----

$("add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const url = form.elements.url.value.trim();
  const name = form.elements.name.value.trim();
  const message = $("add-message");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const item = await api("POST", "/api/items", { url, ...(name ? { name } : {}) });
    form.reset();
    message.className = "form-message ok";
    const restored = item.comparison.okCount > 0 ? ` Its ${item.comparison.okCount} saved price(s) are back.` : " Open its page in Chrome to get the first price.";
    message.textContent = `Added ${item.name || `item #${item.itemNumber}`}.${restored}`;
    await load();
  } catch (e) {
    message.className = "form-message bad";
    message.textContent = e.message;
    form.elements.url.focus();
  } finally {
    button.disabled = false;
  }
});

// ---- Check all (run) ----

const RUN_POLL_MS = 2_000;
const SHOW_LAST_RUN_MS = 12 * 60 * 60_000; // show the last result for half a day unless hidden
const HIDDEN_KEY = "hiddenRunId";
let runPoll = null;
let lastReported = -1;

function hiddenRunId() {
  try {
    return localStorage.getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
}

function renderRun({ run, last }) {
  const box = $("run");
  const button = $("check-all");
  button.disabled = !!run;
  button.textContent = run ? "Checking…" : "Check all";

  const shown =
    run ??
    (last && last.id !== hiddenRunId() && Date.now() - new Date(last.finishedAt).getTime() < SHOW_LAST_RUN_MS ? last : null);
  if (!shown) {
    box.hidden = true;
    return;
  }
  const d = describeRun(shown);
  box.hidden = false;
  box.className = `run ${d.state}`;
  box.dataset.runId = shown.id;
  $("run-title").textContent = d.title;
  $("run-detail").textContent = d.detail;
  $("run-close").hidden = d.state === "running";
  $("run-items").replaceChildren(
    ...d.items.map((i) =>
      el("li", {}, el("span", { className: `icon ${i.tone}`, textContent: i.icon }), `${i.name} `, el("span", { className: i.tone, textContent: i.text })),
    ),
  );
}

async function loadRun() {
  try {
    const data = await api("GET", "/api/runs/current");
    renderRun(data);
    // Refresh the table whenever another price comes in, and once more when the run ends.
    const reported = data.run ? data.run.ok + data.run.failed : -1;
    if (reported !== lastReported) {
      lastReported = reported;
      void load();
    }
    if (data.run && !runPoll) runPoll = setInterval(loadRun, RUN_POLL_MS);
    if (!data.run && runPoll) {
      clearInterval(runPoll);
      runPoll = null;
    }
  } catch {
    // load() already shows a connection error
  }
}

$("check-all").addEventListener("click", async () => {
  const button = $("check-all");
  button.disabled = true;
  try {
    await api("POST", "/api/runs");
  } catch (e) {
    showError(e.message === "A check is already running." ? e.message : `Couldn't start the check: ${e.message}`);
  }
  await loadRun();
});

$("run-close").addEventListener("click", () => {
  try {
    localStorage.setItem(HIDDEN_KEY, $("run").dataset.runId);
  } catch {
    // private window: hide it for this visit only
  }
  $("run").hidden = true;
});

void load();
void loadRun();
setInterval(() => {
  if (!document.hidden) {
    void load();
    if (!runPoll) void loadRun();
  }
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void load();
    void loadRun();
  }
});
