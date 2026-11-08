# Spike Findings: Fetching Costco Prices (Task 1)

## Update (2026-11-07, after Task 2): automated fetching ruled out

The real fetcher (Playwright headless Chromium with its **default** User-Agent, no disguise) was **blocked on the first item with HTTP 429**. The two remaining items were skipped as designed.

The spike below only passed because it sent a custom normal-Chrome User-Agent, which is a disguise. The default headless User-Agent contains `HeadlessChrome`, which Kasada blocks. We won't disguise automation, so an unattended fetcher isn't viable. **Decision:** the one-click daily check (the user opens the tabs in their real Chrome and the extension reads the prices). See `tasks/plan.md`.

---

**Original result (superseded): GO.** The headless browser read the correct price on all 3 test pages. Run by the user on this laptop on 2026-11-07, with prices confirmed against costco.com in Chrome.

## Test run (2026-11-07)

Command: `npx tsx spike/fetch.ts check <3 URLs>`. Standard Playwright headless Chromium with no stealth or evasion, run one page at a time with a 3–6 s pause between pages.

| Item | Item # | Plain HTTP | Headless browser | Matches site |
|---|---|---|---|---|
| La Mer Crème de la Mer 3.4 oz | 100511846 | 200, $434.99 (ld+json) | 200, $434.99 (ld+json) | ✓ |
| Samsung 65" S90H OLED bundle | 4201001045 | 200, $1,399.99 (ld+json) | 200, $1,399.99 (ld+json) | ✓ |
| Mac Studio M5 Max | 4000444300 | **429 (blocked)** | 200, $2,299.99 (ld+json) | ✓ |

## Conclusions

- **Use the headless browser for every fetch.** Plain HTTP is inconsistent: it worked twice and was then blocked (429) on the third request, and earlier blocked on the first try. The browser loaded all 3 pages.
- **Read the price from JSON-LD.** Each page has a `Product` → `Offer` block in `<script type="application/ld+json">` with `price`, `priceCurrency: "USD"` and `availability` (for example the La Mer item shows `OutOfStock`). This is more stable than page CSS selectors. The meta and page-element methods stay as fallbacks.
- **Bonus data:** `availability` could be shown in the portal as in stock / out of stock at no extra cost.
- **Item number:** the number in the URL (`/p/-/<slug>/<itemNumber>`) matches the product number on the page. The slug in the canonical URL can differ slightly (for example `---` versus `-`), so items are matched by number only.
- The `blocked` flag in the spike's HTTP output was a false alarm: normal pages also include the bot-protection script. Task 2 should detect a block by `status === 429` or a missing `Product` JSON-LD, not by that script.
- **Not yet known:** whether daily runs keep working over days or weeks. Failures will show as ⚠ in the portal and be counted in the notification (Tasks 4 and 7).

## Fixtures

Saved in `test/fixtures/` (`*.browser.html` are rendered pages, `*.http.html` are raw responses, including two 429 challenge pages). Task 2 will rename them to short names and use them in extractor tests.

## Earlier probe (2026-11-06)

`curl` with a browser User-Agent: the homepage returned 200; search results are drawn by JavaScript after loading; a product page returned 429 with a Kasada challenge (`KPSDK`, `x-kpsdk-*` headers).
