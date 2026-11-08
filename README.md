# Costco Price Watcher

Keeps a watch list of Costco products on your Mac and tracks their prices over time.

- A **web portal** at http://127.0.0.1:4000 shows each item's current price, the change since last time, the lowest price, and its full history.
- Once a day, a **Mac notification** reminds you to check. **One click** opens every watched item as a tab in your own Chrome.
- A small **Chrome extension** reads the price from each page, saves it, and closes the tab.
- When the check is done, a **summary notification** tells you about price drops and new lows.

Everything runs on this Mac. Nothing is sent anywhere except to the local service on `127.0.0.1`.

> **Why one click instead of fully automatic?** Costco blocks automated browsers. Rather than disguise a bot, the
> prices come from real page visits in your own Chrome. You click once a day; the rest is automatic.

## Requirements

- macOS, Google Chrome
- Node.js 22 or newer (`node --version`)

## Install

```bash
cd watch-costco
npm install
npm run build:ext
```

### 1. Load the Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension` folder in this project.
3. **Costco Price Watcher** appears in the list. Pin it if you like; its badge shows prices waiting to be sent.

After changing the extension's code, run `npm run build:ext` and click ↻ on its card.

### 2. Start the service

Try it in a Terminal window first:

```bash
npm start
```

Then open http://127.0.0.1:4000. Stop it with Ctrl-C.

To run it all the time (starts when you log in, restarts if it stops):

```bash
npm run service:install
```

Settings are taken from your environment at install time, for example `REMINDER_TIME=08:30 npm run service:install`.
Re-run the install after changing settings, moving this folder, or switching Node versions (the agent remembers
the exact `node` it was installed with).

| Command                     | What it does                                        |
| --------------------------- | --------------------------------------------------- |
| `npm run service:install`   | Install or reinstall the login service and start it |
| `npm run service:restart`   | Restart it (e.g. after pulling new code)            |
| `npm run service:uninstall` | Stop it and remove it. Your data is kept.           |

### 3. Allow notifications

Notifications come from **terminal-notifier** (bundled with the `node-notifier` package). The first one may ask
for permission. If you don't see any, open **System Settings → Notifications → terminal-notifier** and allow them.
It's an Intel app, so macOS may ask to install Rosetta once.

## Using it

### Add items

In the portal, paste a Costco product link (it looks like `https://www.costco.com/p/-/<name>/<item number>`) and
click **Add**. The name is optional; it's filled in from the page the first time the price is read.

Or from the command line: `npm run items -- add <url> [name]`, `npm run items -- list`,
`npm run items -- remove <item number>`.

**Remove** takes an item off the list but keeps its price history. Add the same item again and its history comes back.

### The daily check

1. At 9:00 (`REMINDER_TIME`) you get **"Time to check Costco prices (N items)"**. If the Mac was asleep, it comes
   shortly after waking. It's skipped if you already checked that day.
2. Click it. Chrome opens one tab per item, and the portal shows progress: _"Checking 3 items… 2 of 3 reported"_.
3. Each tab shows a green **"Price saved ✓"** note and closes itself.
4. When every item has reported (or after 10 minutes, `RUN_TIMEOUT_MINUTES`), you get a summary like
   _"5 items · 2 price drops · 1 new low"_. Click it to open the portal.

You can also click **Check all** in the portal at any time. And any watched product page you open yourself in
Chrome is saved too — those tabs are never closed for you.

### Reading the portal

| You see                 | Meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| ▼ $5.00 (−20%) in green | Cheaper than the previous price                                                      |
| ▲ $2.50 (+12.5%) in red | More expensive than the previous price                                               |
| $19.99 ★                | The current price is the lowest ever seen                                            |
| first check             | Only one price so far                                                                |
| ⚠ missed / ⚠ failed     | The last check got no price (hover for why); the last good price stays in "Previous" |

Click a row to see every check, a small chart, and the highest, average and lowest price.

## Settings

Set these in the environment for `npm start`, or when running `npm run service:install`.

| Variable              | Default |                                                                      |
| --------------------- | ------- | -------------------------------------------------------------------- |
| `REMINDER_TIME`       | `09:00` | Daily reminder, 24-hour local time                                   |
| `RUN_TIMEOUT_MINUTES` | `10`    | How long a check waits before marking unreported items "missed"      |
| `NOTIFICATIONS`       | on      | `off` turns Mac notifications off                                    |
| `PORT`                | `4000`  | If you change it, also change the address in the extension's options |
| `DATA_DIR`            | `data`  | Where the JSON files live                                            |
| `DEDUPE_MINUTES`      | `10`    | Reloading a page within this time doesn't save the same price twice  |

In the extension's options (right-click its icon → **Options**): the service address, whether tabs opened by a
check close after saving (on by default), and a **Send now** button for prices saved while the service was off.

## Your data

All data is plain JSON in `data/`:

| File           | Contents                                                            |
| -------------- | ------------------------------------------------------------------- |
| `items.json`   | The watch list                                                      |
| `history.json` | Every check for every item: time, `ok` / `failed` / `missed`, price |
| `state.json`   | The current or last check, and the reminder bookkeeping             |

Each file is written safely (to a temp file, then renamed), and the previous version is kept as `*.json.bak`.
That's only one step back — for real backups, keep `data/` in Time Machine or copy it somewhere now and then.
If a file is damaged, the portal shows an error naming it; fix it by hand or copy the `.bak` over it.

## Troubleshooting

**The portal doesn't load.** The service isn't running. Run `npm start` to see errors directly, or look at
`logs/service.err.log` if it's installed as a login service.

**No reminder came.**

- Already checked today (from the portal or the reminder)? Then it's skipped until tomorrow.
- Notifications allowed for terminal-notifier? (See _Allow notifications_ above.)
- Is the service running? `curl http://127.0.0.1:4000/api/health` should print `{"ok":true}`.
- Look for "Daily reminder sent" in `logs/service.log`.

**A tab didn't save a price.**

- No green note at all: is the extension enabled and reloaded after updates? Check `chrome://extensions` for
  errors. The page must be a product page (`costco.com/p/…`).
- An amber **"saved offline"** note: the service wasn't reachable. The price is kept in Chrome and sent
  automatically within a minute of the service coming back (or click **Send now** in the extension's options).
- An amber **"couldn't read the price"** note: the page showed no price — for example a sign-in page, a sold-out
  item, or a page Costco changed. The tab stays open so you can look.

**Tabs didn't close.** Only tabs opened by a check close, and only after their price was saved. Make sure
the option is on in the extension's options.

**Costco changed its pages and prices stop being read.** The price is read from the page's product data
(`application/ld+json`), then from `<meta>` tags, then from price elements. Save a product page
(**File → Save Page As…**, "Webpage, Complete") into `test/fixtures/`, add it to `test/extract.test.ts`, and adjust
`src/extract.ts` until the test passes. Then `npm run build:ext` and reload the extension.

**"Something is already using port 4000"** when installing: stop `npm start` in your Terminal first.

## Development

```bash
npm test          # unit and API tests
npm run build     # type-check
npm run lint
npm run build:ext # bundle the extension into extension/dist
```

| Path                                               |                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/main.ts`                                      | Service entry point: server, run timeouts, daily reminder                      |
| `src/server.ts`, `src/routes/`                     | HTTP API and portal files; only this Mac's pages and the extension may call it |
| `src/runs.ts`                                      | A "Check all" run: open tabs, count captures, time out                         |
| `src/reminder.ts`, `src/summary.ts`, `src/notify/` | Notifications                                                                  |
| `src/observations.ts`, `src/compare.ts`            | Saving a captured price and comparing it with history                          |
| `src/store/`                                       | JSON files                                                                     |
| `src/extract.ts`                                   | Reading the price from a product page (used by the extension)                  |
| `extension/`                                       | The Chrome extension                                                           |
| `public/`                                          | The portal page                                                                |
| `scripts/`                                         | Install / uninstall the login service                                          |

# deal-watch

A small app watching the price of a list items defined in your local.
