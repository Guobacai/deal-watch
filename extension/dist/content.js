"use strict";
(() => {
  // src/costcoUrl.ts
  var PRODUCT_PATH = /^\/p\/[^/]+\/[^/]+\/(\d+)\/?$/;
  function parseItemNumber(url) {
    try {
      const m = new URL(url).pathname.match(PRODUCT_PATH);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // src/extract.ts
  function parseMoney(text) {
    const m = text.replace(/\s+/g, " ").match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function toPrice(v) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function fromLdJson(doc) {
    const candidates = [];
    let name = null;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((el, i) => {
      let data;
      try {
        data = JSON.parse(el.textContent ?? "");
      } catch {
        return;
      }
      const stack = [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) {
          stack.push(...node);
          continue;
        }
        const obj = node;
        const type = obj["@type"];
        const isProduct = type === "Product" || Array.isArray(type) && type.includes("Product");
        if (isProduct && typeof obj.name === "string" && !name) name = obj.name;
        if (type === "Offer" || type === "AggregateOffer") {
          const p = toPrice(obj.price) ?? toPrice(obj.lowPrice);
          if (p != null) candidates.push({ via: "ld+json", price: p, detail: `ld+json #${i} ${type}` });
        }
        for (const v of Object.values(obj)) if (v && typeof v === "object") stack.push(v);
      }
    });
    return { candidates, name };
  }
  function fromMeta(doc) {
    const out = [];
    const sel = 'meta[itemprop="price"], meta[property="product:price:amount"], meta[property="og:price:amount"]';
    doc.querySelectorAll(sel).forEach((el) => {
      const p = toPrice(el.getAttribute("content"));
      const key = el.getAttribute("itemprop") ?? el.getAttribute("property");
      if (p != null) out.push({ via: "meta", price: p, detail: `meta ${key}` });
    });
    return out;
  }
  function fromDom(doc) {
    const out = [];
    const sel = [
      '[automation-id*="price" i]',
      '[data-testid*="price" i]',
      '[itemprop="price"]',
      '[id*="price" i]',
      '[class*="price" i]'
    ].join(",");
    const seen = /* @__PURE__ */ new Set();
    doc.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el) || out.length >= 12) return;
      seen.add(el);
      const text = (el.textContent ?? "").trim();
      if (!text || text.length > 80) return;
      const p = parseMoney(text);
      if (p == null) return;
      const attr = ["automation-id", "data-testid", "id", "class"].map((a) => el.getAttribute(a) ? `${a}="${el.getAttribute(a).slice(0, 50)}"` : "").find(Boolean);
      out.push({ via: "dom", price: p, detail: `<${el.tagName.toLowerCase()} ${attr ?? ""}> "${text.slice(0, 40)}"` });
    });
    return out;
  }
  function extract(doc, url) {
    const ld = fromLdJson(doc);
    const candidates = [...ld.candidates, ...fromMeta(doc), ...fromDom(doc)];
    const best = candidates[0] ?? null;
    const name = ld.name ?? doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? doc.querySelector("h1")?.textContent?.trim() ?? null;
    return {
      itemNumber: parseItemNumber(url),
      name,
      price: best?.price ?? null,
      via: best?.via ?? null,
      candidates
    };
  }

  // extension/src/settings.ts
  var RUN_TAB_MARK = /(?:^#|&)cpw-run=[\w-]+/;

  // extension/src/content.ts
  var TIMEOUT_MS = 2e4;
  var runTab = RUN_TAB_MARK.test(location.hash);
  var TOAST_ID = "cpw-toast";
  function waitForPrice() {
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
  var money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function describe(price, result) {
    switch (result.outcome) {
      case "unwatched":
        return null;
      // not on the watch list: stay out of the way
      case "rejected":
        return { text: `Price Watcher: couldn't save (${result.error})`, tone: "warn" };
      case "queued":
        return { text: `Price saved offline. It will be sent when the service is running.`, tone: "warn" };
      case "saved":
      case "duplicate": {
        if (price === null) return { text: "Price Watcher: couldn't read the price on this page", tone: "warn" };
        const c = result.comparison ?? {};
        let detail = "";
        if (c.isFirstCheck) detail = " \xB7 first check";
        else if (c.change && c.change.amount < 0) detail = ` \xB7 \u25BC ${money(-c.change.amount)} (${c.change.percent}%)${c.isNewLow ? " \u2605 new low" : ""}`;
        else if (c.change && c.change.amount > 0) detail = ` \xB7 \u25B2 ${money(c.change.amount)} (+${c.change.percent}%)`;
        else if (c.change) detail = " \xB7 no change";
        const verb = result.outcome === "saved" ? "Price saved" : "Already saved";
        const closing = result.closingTab ? " \xB7 closing tab" : "";
        return { text: `${verb} \u2713 ${money(price)}${detail}${closing}`, tone: "ok" };
      }
    }
  }
  function toast(text, tone) {
    document.getElementById(TOAST_ID)?.remove();
    const el = document.createElement("div");
    el.id = TOAST_ID;
    el.setAttribute("role", "status");
    el.textContent = text;
    el.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:8px 12px;border-radius:8px;font:13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);background:${tone === "ok" ? "#166534" : "#92400e"};transition:opacity .4s;opacity:1;cursor:pointer`;
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.style.opacity = "0", 5e3);
    setTimeout(() => el.remove(), 5500);
  }
  var running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const r = await waitForPrice();
      if (!r.itemNumber) return;
      const capture = {
        url: location.href,
        price: r.price,
        capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...r.name ? { name: r.name.slice(0, 300) } : {},
        ...r.via ? { via: r.via } : {},
        ...r.price === null ? { error: "no price found on the page" } : {}
      };
      const isRunTab = runTab;
      runTab = false;
      const result = await chrome.runtime.sendMessage({ type: "capture", capture, runTab: isRunTab });
      const t = describe(r.price, result);
      if (t) toast(t.text, t.tone);
    } catch (e) {
      console.warn("[costco-price-watcher]", e);
    } finally {
      running = false;
    }
  }
  var lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (/^\/p\//.test(location.pathname)) void run();
    }
  }, 1e3);
  void run();
})();
