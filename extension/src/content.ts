// Runs on Costco product pages you open. Waits for the price, reads it, and hands it to the
// background worker, which sends it to the local service. Shows a small toast for watched items.
// It reads only what the page already shows; it makes no requests to Costco.
import { extract, type Extraction } from "../../src/extract";
import type { Capture } from "./queue";
import { RUN_TAB_MARK, type CaptureOutcome, type Message } from "./settings";

const TIMEOUT_MS = 20_000;
// Was this tab opened by "Check all"? Read once at load: only the page the run opened counts,
// not products you click through to later in the same tab.
let runTab = RUN_TAB_MARK.test(location.hash);
const TOAST_ID = "cpw-toast";

function waitForPrice(): Promise<Extraction> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(extract(document, location.href));
    };
    const check = () => {
      if (extract(document, location.href).price != null) finish();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(finish, TIMEOUT_MS);
    check();
  });
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface ToastComparison {
  isFirstCheck?: boolean;
  isNewLow?: boolean;
  change?: { amount: number; percent: number } | null;
}

function describe(price: number | null, result: CaptureOutcome): { text: string; tone: "ok" | "warn" } | null {
  switch (result.outcome) {
    case "unwatched":
      return null; // not on the watch list: stay out of the way
    case "rejected":
      return { text: `Price Watcher: couldn't save (${result.error})`, tone: "warn" };
    case "queued":
      return { text: `Price saved offline. It will be sent when the service is running.`, tone: "warn" };
    case "saved":
    case "duplicate": {
      if (price === null) return { text: "Price Watcher: couldn't read the price on this page", tone: "warn" };
      const c = (result.comparison ?? {}) as ToastComparison;
      let detail = "";
      if (c.isFirstCheck) detail = " · first check";
      else if (c.change && c.change.amount < 0) detail = ` · ▼ ${money(-c.change.amount)} (${c.change.percent}%)${c.isNewLow ? " ★ new low" : ""}`;
      else if (c.change && c.change.amount > 0) detail = ` · ▲ ${money(c.change.amount)} (+${c.change.percent}%)`;
      else if (c.change) detail = " · no change";
      const verb = result.outcome === "saved" ? "Price saved" : "Already saved";
      const closing = result.closingTab ? " · closing tab" : "";
      return { text: `${verb} ✓ ${money(price)}${detail}${closing}`, tone: "ok" };
    }
  }
}

function toast(text: string, tone: "ok" | "warn") {
  document.getElementById(TOAST_ID)?.remove();
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.setAttribute("role", "status");
  el.textContent = text;
  el.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:8px 12px;border-radius:8px;" +
    "font:13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);" +
    `background:${tone === "ok" ? "#166534" : "#92400e"};transition:opacity .4s;opacity:1;cursor:pointer`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => (el.style.opacity = "0"), 5000);
  setTimeout(() => el.remove(), 5500);
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  try {
    const r = await waitForPrice();
    if (!r.itemNumber) return;
    const capture: Capture = {
      url: location.href,
      price: r.price,
      capturedAt: new Date().toISOString(),
      ...(r.name ? { name: r.name.slice(0, 300) } : {}),
      ...(r.via ? { via: r.via } : {}),
      ...(r.price === null ? { error: "no price found on the page" } : {}),
    };
    const isRunTab = runTab;
    runTab = false;
    const result = (await chrome.runtime.sendMessage({ type: "capture", capture, runTab: isRunTab } satisfies Message)) as CaptureOutcome;
    const t = describe(r.price, result);
    if (t) toast(t.text, t.tone);
  } catch (e) {
    console.warn("[costco-price-watcher]", e); // e.g. the extension was reloaded while this tab was open
  } finally {
    running = false;
  }
}

// Costco may switch products without a full page load, so watch for URL changes.
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (/^\/p\//.test(location.pathname)) void run();
  }
}, 1000);

void run();
