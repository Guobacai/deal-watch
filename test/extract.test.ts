import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { extract, parseMoney } from "../src/extract";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const doc = (html: string) => parseHTML(html).document as unknown as Document;

const pages = [
  { file: "la-mer.browser.html", item: "100511846", price: 434.99, name: /La Mer/ },
  { file: "samsung-tv.browser.html", item: "4201001045", price: 1399.99, name: /Samsung 65/ },
  { file: "mac-studio.browser.html", item: "4000444300", price: 2299.99, name: /Mac Studio/ },
];

describe("extract() on saved Costco pages", () => {
  for (const p of pages) {
    it(`${p.file} → $${p.price} via ld+json`, () => {
      const r = extract(doc(fixture(p.file)), `https://www.costco.com/p/-/x/${p.item}`);
      expect(r.price).toBe(p.price);
      expect(r.via).toBe("ld+json");
      expect(r.itemNumber).toBe(p.item);
      expect(r.name).toMatch(p.name);
    });
  }

  it("returns null price on a page with no price", () => {
    const r = extract(doc("<html><body><h1>Sign in to see price</h1></body></html>"), "https://www.costco.com/p/-/x/1");
    expect(r.price).toBeNull();
    expect(r.via).toBeNull();
  });

  it("falls back to a page element when there is no JSON-LD", () => {
    const html = `<html><body><h1>TV</h1><span automation-id="productPriceOutput">$1,049.99</span></body></html>`;
    const r = extract(doc(html), "https://www.costco.com/p/-/x/1");
    expect(r).toMatchObject({ price: 1049.99, via: "dom" });
  });
});

describe("parseMoney()", () => {
  it.each([
    ["$24.99", 24.99],
    ["Your price $1,299.99", 1299.99],
    ["$5", 5],
    ["free", null],
    ["$0.00", null],
  ])("%s → %s", (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });
});
