// Pure price extraction from a rendered Costco product page.
// Takes a Document so it runs in the browser or in Node (via linkedom) and can be tested on fixtures.

export type Strategy = "ld+json" | "meta" | "dom";

export interface Candidate {
  via: Strategy;
  price: number;
  detail: string; // where it came from, for debugging
}

export interface Extraction {
  itemNumber: string | null;
  name: string | null;
  price: number | null;
  via: Strategy | null;
  candidates: Candidate[];
}

import { parseItemNumber } from "./costcoUrl";
export { parseItemNumber };


/** "$1,299.99" → 1299.99 */
export function parseMoney(text: string): number | null {
  const m = text.replace(/\s+/g, " ").match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toPrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fromLdJson(doc: Document): { candidates: Candidate[]; name: string | null } {
  const candidates: Candidate[] = [];
  let name: string | null = null;
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el, i) => {
    let data: unknown;
    try {
      data = JSON.parse(el.textContent ?? "");
    } catch {
      return;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      const obj = node as Record<string, unknown>;
      const type = obj["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
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

function fromMeta(doc: Document): Candidate[] {
  const out: Candidate[] = [];
  const sel = 'meta[itemprop="price"], meta[property="product:price:amount"], meta[property="og:price:amount"]';
  doc.querySelectorAll(sel).forEach((el) => {
    const p = toPrice(el.getAttribute("content"));
    const key = el.getAttribute("itemprop") ?? el.getAttribute("property");
    if (p != null) out.push({ via: "meta", price: p, detail: `meta ${key}` });
  });
  return out;
}

function fromDom(doc: Document): Candidate[] {
  const out: Candidate[] = [];
  const sel = [
    '[automation-id*="price" i]',
    '[data-testid*="price" i]',
    '[itemprop="price"]',
    '[id*="price" i]',
    '[class*="price" i]',
  ].join(",");
  const seen = new Set<Element>();
  doc.querySelectorAll(sel).forEach((el) => {
    if (seen.has(el) || out.length >= 12) return;
    seen.add(el);
    const text = (el.textContent ?? "").trim();
    if (!text || text.length > 80) return; // skip big containers
    const p = parseMoney(text);
    if (p == null) return;
    const attr = ["automation-id", "data-testid", "id", "class"]
      .map((a) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a)!.slice(0, 50)}"` : ""))
      .find(Boolean);
    out.push({ via: "dom", price: p, detail: `<${el.tagName.toLowerCase()} ${attr ?? ""}> "${text.slice(0, 40)}"` });
  });
  return out;
}

export function extract(doc: Document, url: string): Extraction {
  const ld = fromLdJson(doc);
  const candidates = [...ld.candidates, ...fromMeta(doc), ...fromDom(doc)];
  const best = candidates[0] ?? null; // strategies are ordered by trust
  const name =
    ld.name ??
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
    doc.querySelector("h1")?.textContent?.trim() ??
    null;
  return {
    itemNumber: parseItemNumber(url),
    name,
    price: best?.price ?? null,
    via: best?.via ?? null,
    candidates,
  };
}
