# Implementation Plan: Costco Price Watcher (One-Click Daily Check)

## Overview

A TypeScript service on this Mac keeps a watch list of Costco items that you manage in a local web portal (http://localhost:4000). Once a day a macOS notification reminds you to check prices. **One click**, on the notification or on the portal's **Check all** button, opens every watched item as a tab in your own Chrome. A small Chrome extension reads the price from each page and sends it to the service. The service saves each price to a JSON history file and compares it with history (previous check, lowest, highest, average). When the check finishes, it sends a summary notification. The portal shows current prices, comparisons and history.

**Why one click instead of an unattended fetcher:** Costco's bot protection (Kasada) blocked the automated browser on the first request (HTTP 429, Task 2 run on 2026-11-07). Getting past it would mean disguising automation as a person, which we won't do. Here, every page is a real visit by you in your real browser, and the extension only reads what Costco already showed you. See `tasks/spike-findings.md`.

**Not in scope for now:** target prices and price-drop alerts (may be added later).

## How a Daily Check Works

```
09:00  🔔 "Time to check Costco prices (6 items)"           ← daily reminder
          │ click
          ▼
Service starts a check run → opens the 6 product pages as tabs in Google Chrome
          │
          ▼
Extension (on each costco.com/p/… tab): wait for price → read it → POST to service
          │                                   └─ closes that tab after saving (setting)
          ▼
Service: append to data/history.json → compare with history
          │ all items reported, or 10 min timeout (missing items = "missed")
          ▼
🔔 "Costco check done: 6 items · 2 price drops · 1 new low"  ← click opens portal
```

Prices are also saved any time you open a watched item's page on your own, with no check run needed. Pages for items not on your watch list are ignored.

## Architecture Decisions

- **One local Node process:** a Fastify server bound to `127.0.0.1:4000` serving the portal and API, plus a small daily scheduler. It's the only writer to the JSON files, and writes are serialized in-process. The service starts at login via a `launchd` LaunchAgent.
- **Opening tabs:** the service runs `open -a "Google Chrome" <url> …` (macOS). This opens real tabs in your normal Chrome, with your session and sign-in, exactly as if you had clicked the links. It only happens when you click: on the reminder, or on "Check all".
- **Clicking the reminder:** the notification (`node-notifier`) opens `http://localhost:4000/run/start?token=<today's one-time token>`. That starts the run and redirects to the portal's run-progress view. The one-time token stops any other page from triggering a run.
- **Chrome extension (Manifest V3):**
  - The content script runs on `https://www.costco.com/p/*` and uses the existing `src/extract.ts` (JSON-LD first, then meta tags, then a page element).
  - It waits for the price to load, then sends the result through the extension's background worker to `POST /api/observations`.
  - If the service isn't running, captures are queued in `chrome.storage` and retried.
  - A small "Price saved ✓" toast shows on the page.
  - The extension makes **no requests to Costco** and **opens no pages by itself**.
  - Host permissions: only `costco.com/p/*` and `127.0.0.1:4000`.
- **Closing tabs after capture:** for tabs opened by a check run, the extension closes each tab once its price is saved (a checkbox in the extension's options, default on). Run tabs are marked with `#cpw-run=<id>` in the URL fragment, which Costco never receives. Tabs you opened yourself are never closed, and tabs where no price was found stay open.
- **Check runs:** a run tracks which items it's waiting for. It completes when every item has reported, or after `RUN_TIMEOUT_MINUTES` (default 10), at which point items that never reported are recorded as `missed`. Only one run at a time.
- **Data in `data/` (gitignored), zod-validated, written atomically with a `.bak` copy** (reusing `src/store/jsonFile.ts`):
  - `data/items.json`: `{ itemNumber, name, url, addedAt }[]` (unchanged from Task 2)
  - `data/history.json`: `{ [itemNumber]: { checkedAt, status: "ok" | "failed" | "missed", price | null, runId?, error? }[] }`
  - `data/state.json`: `{ lastReminderDate, reminderToken, currentRun?, lastRunSummary? }`
- **Comparison (pure, tested):** current price vs. the previous successful price (change in $ and %), plus the lowest, highest and average price, a new-low flag and a first-check flag.
- **Notifications (`node-notifier`):** a daily reminder at `REMINDER_TIME` (default 09:00). If the Mac was asleep at that time, the reminder comes after it wakes. It's skipped if a check already ran today, and sent at most once a day. A summary notification is sent at the end of each run.
- **Reused from Task 2:** `src/costcoUrl.ts`, `src/extract.ts`, `src/store/jsonFile.ts`, `src/store/items.ts` and their tests. **To be removed (Task 10):** `src/fetcher.ts`, `src/runPolicy.ts`, the `once` command, Playwright, cheerio and `spike/`.

## Portal Layout (sketch)

```
Costco Price Watcher         Last check: today 9:02 AM ✓ (6/6)        [Check all]
┌────────────────────────┬─────────┬──────────┬────────────────┬────────────┬──────────┬──────┐
│ Item                   │ Current │ Previous │ Change         │ Lowest     │ Checked  │      │
├────────────────────────┼─────────┼──────────┼────────────────┼────────────┼──────────┼──────┤
│ Kirkland Olive Oil 2L  │ $19.99  │ $24.99   │ ▼ $5.00 (−20%) │ $19.99 ★   │ 9:01 AM  │ [🗑] │
│ Samsung 65" TV         │ $899.99 │ $899.99  │ no change      │ $849.99    │ 9:01 AM  │ [🗑] │
│ AirPods Pro            │ $199.99 │ none     │ first check    │ none       │ 9:02 AM  │ [🗑] │
│ Some Item              │ ⚠ missed│ $12.99   │ n/a            │ $11.49     │ yesterday│ [🗑] │
└────────────────────────┴─────────┴──────────┴────────────────┴────────────┴──────────┴──────┘
Add item:  [ paste Costco product URL ]  [ name (optional) ]  [Add]
▸ Clicking a row shows its price history (table + small chart; highest, average, lowest)
While a check runs: "Checking… 4 of 6 saved" with per-item ticks.
```

## Dependency Graph

```
✅ Task 1: Fetch test     ✅ Task 2: Watch list + price reading (reused parts)
                                   │
                                   ├── Task 3: History + comparison
                                   │      │
                                   │      └── Task 4: Service + observations API
                                   │             │
                                   │             └── Task 5: Capture extension   ◄── end-to-end slice
                                   │                    │
                                   │                    ├── Task 6: Portal price table ── Task 7: Manage items + item detail
                                   │                    │
                                   │                    └── Task 8: "Check all" run (open tabs, track, close tabs)
                                   │                               │
                                   │                               └── Task 9: Notifications (reminder + summary) + daily schedule
                                   │                                          │
                                   └──────────────────────────────────────────└── Task 10: launchd + cleanup + README
```

## Task List

### Done

#### ✅ Task 1: Fetch test (2026-11-07)
The headless browser read prices on 3 pages, but only while it was disguised as normal Chrome (a custom User-Agent). See Task 2.

#### ✅ Task 2: Watch list + price reading (2026-11-07)
Built: URL parsing and validation, the price extractor and block detector, the safe JSON store, the item repository, and a CLI to list, add and remove items. 40 tests pass.

The real undisguised automated run was **blocked on the first item (HTTP 429)**. Unattended fetching is ruled out, which led to this plan.

### Phase 1: Capture End-to-End

#### ✅ Task 3: Price history + comparison (done 2026-11-07)
Built `src/store/history.ts` and `src/compare.ts`, with 24 new tests (64 total). Test, build and lint pass.

**Description:** Add a `HistoryRepository` on `data/history.json` with `append(itemNumber, entry)`, `get(itemNumber)` (time-ordered) and `latestOk(itemNumber)`. Add a pure `compare(entries)` that returns the current and previous price, the change in $ and %, the lowest, highest and average price, `isNewLow` and `isFirstCheck`. Failed and missed entries are excluded from the statistics.

**Acceptance criteria:**
- [ ] An item's first price is reported as "first check"; later prices show the correct change and statistics
- [ ] Failed and missed entries are stored but don't affect the comparison
- [ ] A corrupt history file gives a clear error and is never overwritten

**Verification:**
- [ ] Table-driven unit tests for `compare()`; repository tests in a temp dir
- [ ] `npm test`, `npm run build` and `npm run lint` pass

**Dependencies:** Task 2
**Files likely touched:** `src/store/history.ts`, `src/compare.ts`, `test/compare.test.ts`, `test/history.test.ts`
**Estimated scope:** M

#### ✅ Task 4: Service + observations API (done 2026-11-07)
Built `src/server.ts`, `src/observations.ts` and `src/main.ts` (`npm start`), with 28 new tests (92 total) and a live curl check. Instead of CORS headers, a request guard does the job: the extension's background worker has host permission and doesn't need CORS. The guard allows only Host 127.0.0.1/localhost on our port, and an Origin that is either the extension or the portal itself. Bodies must be JSON.

**Description:** A Fastify server on `127.0.0.1:4000` with `POST /api/observations` taking `{ itemNumber, url, price | null, name?, via?, runId? }`. For a watched item it appends to history (`ok`, or `failed` if `price` is null) and fills in the item's name if it's empty. Unwatched items are ignored (202, nothing stored). Repeat captures of the same item and price within 10 minutes are collapsed into one entry. CORS allows only the extension's origin. `npm start` runs the server.

**Acceptance criteria:**
- [ ] A watched item's capture adds one history entry; an unwatched item stores nothing
- [ ] An invalid payload gets 400; reloading the same page doesn't create duplicate entries
- [ ] The server is reachable only from this Mac, and only the extension can call it from a browser

**Verification:**
- [ ] API tests using Fastify `inject`
- [ ] Manual: a `curl` POST for a watched item shows up in `data/history.json`

**Dependencies:** Task 3
**Files likely touched:** `src/server.ts`, `src/routes/observations.ts`, `src/main.ts`, `test/observations.test.ts`
**Estimated scope:** M

#### Task 5: Capture extension ✅ (verified in Chrome 2026-11-08: La Mer $434.99 saved, name filled in)
Built `extension/src/{content,background,queue,settings,options}.ts` and `extension/options.html`, with 14 new queue tests (109 total). The service now also accepts `capturedAt`, so a capture that was queued keeps its real time, and a late-arriving copy counts as a duplicate.

Host permissions are `http://127.0.0.1/*` and `http://localhost/*`, any port, so the service address can be changed on the options page. The content script needs no host permission. Permissions: `storage` and `alarms` (the alarm retries the queue every minute).

**Description:** Replace the spike's debug panel with the real content script: wait for the price (up to 20 s), extract it, send it to the background worker, and show a brief "Price saved ✓" or "Couldn't read price" toast. The background worker POSTs to the service and queues failed sends in `chrome.storage.local` for retry. Add an extension options page with the service URL (default `http://127.0.0.1:4000`).

**Acceptance criteria:**
- [ ] Opening a watched item's page in Chrome adds a correct history entry within a few seconds
- [ ] A capture made while the service is stopped is delivered after the service starts
- [ ] The extension asks only for the `costco.com/p/*` and `127.0.0.1:4000` host permissions and `storage`

**Verification:**
- [ ] Unit tests for the queue/retry logic with a fake `fetch` and fake storage
- [ ] Manual (you): reload the extension, open the 3 test items, and see 3 correct entries in `data/history.json`

**Dependencies:** Task 4
**Files likely touched:** `extension/manifest.json`, `extension/src/content.ts`, `extension/src/background.ts`, `extension/src/queue.ts`, `test/queue.test.ts`
**Estimated scope:** M

### Checkpoint: Capture End-to-End
- [ ] All tests pass, build and lint clean
- [ ] You open 3 watched items by hand, and 3 correct prices land in history

### Phase 2: Portal

#### Task 6: Portal price table ✅ (done 2026-11-08)
**Description:** `GET /api/items` returns each item with its comparison. The portal page (HTML + vanilla JS) shows the table from the sketch: drops in green, increases in red, ★ for a new low, ⚠ for failed or missed. The header shows the last check time and how many items were captured.

**Acceptance criteria:**
- [ ] The table matches `history.json` for every item
- [ ] Drop, increase, new-low, first-check, failed and missed states all display correctly

**Verification:**
- [ ] API tests for `GET /api/items`
- [ ] Manual: open http://localhost:4000 and compare with the JSON

**Dependencies:** Task 5
**Files likely touched:** `src/routes/items.ts`, `public/index.html`, `public/app.js`, `public/style.css`, `test/items.api.test.ts`
**Estimated scope:** M

#### Task 7: Manage items + item detail ✅ (done 2026-11-08)
**Description:** An add form (Costco URL + optional name) and a remove button per row, with a confirmation. Removing an item keeps its history, so re-adding the same item number restores it. Clicking a row expands its history: every entry newest first, a small inline SVG chart, and the highest, average and lowest price. Uses `POST /api/items`, `DELETE /api/items/:itemNumber` and `GET /api/items/:itemNumber/history`.

**Acceptance criteria:**
- [ ] Adding a valid URL makes the item appear; an invalid or duplicate URL shows an inline error and saves nothing
- [ ] Removing takes the item off the list and keeps its history
- [ ] The history view lists every entry and draws the chart

**Verification:**
- [ ] API tests for add (valid, invalid, duplicate), remove, and history
- [ ] Manual: add 2 items, open one in Chrome, then see its history in the portal

**Dependencies:** Task 6
**Files likely touched:** `src/routes/items.ts`, `public/index.html`, `public/app.js`, `test/items.api.test.ts`
**Estimated scope:** M

### Checkpoint: Portal
- [ ] Add an item in the portal, open it in Chrome, and see its price, comparison and history in the portal
- [ ] You review the portal

### Phase 3: One-Click Check and Notifications

#### Task 8: "Check all" run ✅ (verified in Chrome 2026-11-08)
**Description:** `POST /api/runs` (the portal's **Check all** button) and `GET /run/start?token=…` (the notification) both start a run. The service records the run in `state.json` and opens every watched item in Chrome with `open -a "Google Chrome"`. Captures that arrive during the run count toward it. `GET /api/runs/current` returns progress for the portal ("4 of 6 saved"). The run completes when every item has reported, or at the timeout, when missing items get `missed` entries. The extension's background worker asks the service whether a captured tab belongs to the current run, and if so closes it after saving (when that setting is on).

**Acceptance criteria:**
- [ ] One click opens one tab per watched item in Chrome and starts a run; a second click during a run gets 409 or "already running"
- [ ] The run completes when every item is captured, or at the timeout with the missing items marked `missed`
- [ ] Run tabs close after capture; tabs you opened yourself never close
- [ ] `/run/start` works only with today's token

**Verification:**
- [ ] Unit tests for run tracking (complete, timeout, captures outside a run) using a fake clock and a fake tab opener
- [ ] API tests for starting a run, an already-running run, and a bad token
- [ ] Manual (you): click Check all and watch the tabs open, save their prices and close, while the portal shows progress

**Dependencies:** Task 7
**Files likely touched:** `src/runs.ts`, `src/openTabs.ts`, `src/routes/runs.ts`, `extension/src/background.ts`, `public/app.js`, `test/runs.test.ts`
**Estimated scope:** M (upper end)

#### Task 9: Notifications + daily schedule ✅ (verified 2026-11-08)
**Description:** Add a `Notifier` interface with a `node-notifier` implementation.
- **Daily reminder** at `REMINDER_TIME` (default 09:00): "Time to check Costco prices (N items)". Clicking it opens `/run/start?token=…`. It comes after wake if the Mac slept through the reminder time, at most once a day, and is skipped if a check already ran today or the list is empty.
- **Run summary** when a run completes: "N items · X price drops · Y new lows · Z missed". Clicking it opens the portal.

A notification that fails to send is logged and never breaks a run.

**Acceptance criteria:**
- [ ] Exactly one reminder a day, including after sleep, and none if a check already ran
- [ ] Clicking the reminder starts a run; clicking the summary opens the portal
- [ ] The summary counts are correct

**Verification:**
- [ ] Unit tests for "is the reminder due" (fake clock) and the summary text (fake notifier)
- [ ] Manual (you): set `REMINDER_TIME` 2 minutes ahead, click the reminder, the run completes, the summary appears and opens the portal

**Dependencies:** Task 8
**Files likely touched:** `src/notify/types.ts`, `src/notify/macos.ts`, `src/reminder.ts`, `src/summary.ts`, `test/reminder.test.ts`
**Estimated scope:** M

### Checkpoint: One-Click Check
- [ ] Full daily flow works: reminder → click → tabs → prices saved → summary → portal

### Phase 4: Always On

#### Task 10: launchd + cleanup + README ✅ (installed and restart verified 2026-11-08)
**Description:** `scripts/install-launchd.sh` and `scripts/uninstall-launchd.sh` for a LaunchAgent (`RunAtLoad`, `KeepAlive`, logs in `logs/`). Remove the code we no longer need: `src/fetcher.ts`, `src/runPolicy.ts`, the `once` CLI command and its tests, Playwright, cheerio and `spike/`. The README covers: install, loading the extension, the portal, the daily flow, data files and backups, and troubleshooting (no reminder, a tab didn't save, Costco page changed).

**Acceptance criteria:**
- [ ] The service starts at login and restarts if killed
- [ ] No unused code or packages remain; tests, build and lint pass
- [ ] Following only the README from a fresh clone gets a first check done

**Verification:**
- [ ] Manual: after install, `kill` the process and it comes back; then a README walkthrough

**Dependencies:** Task 9
**Files likely touched:** `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh`, `README.md`, `package.json`, deleted files
**Estimated scope:** M

### Checkpoint: Complete
- [ ] One week of daily use: a reminder each day, one click, prices saved, the summary arrives, and the portal and history are correct
- [ ] All acceptance criteria met

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| You skip a day | Low | The reminder comes the next day; the portal shows "last checked"; history simply has a gap |
| A tab doesn't report (slow load, sign-in prompt, page changed) | Med | Run timeout marks it `missed`; it's shown with ⚠ in the portal and counted in the summary |
| A Costco page redesign breaks price reading | Med | Several reading methods with fallbacks; fixture tests; a "Couldn't read price" toast makes it obvious |
| Many tabs open at once | Low | Tabs close automatically after capture; Chrome handles 10–20 tabs fine |
| Chrome isn't your default browser, or isn't running | Low | `open -a "Google Chrome"` always targets Chrome and starts it if needed |
| Other websites calling the local service | Low | Bound to 127.0.0.1; CORS limited to the extension; payloads validated; run links need today's token |
| JSON file corruption | Med | Atomic writes, `.bak` copies, validation that refuses to overwrite a bad file |

## Open Questions

1. **Closing tabs:** should run tabs close automatically after their price is saved? Built as yes, with an off switch in the extension options.
2. **Reminder time:** is 9:00 AM good? Built as 09:00; change with `REMINDER_TIME`.
3. **Run timeout:** is 10 minutes before unreported items are marked "missed" OK? Built as 10; change with `RUN_TIMEOUT_MINUTES`.

## Later (not in this plan)
- A target price per item, with an alert when the price drops below it
