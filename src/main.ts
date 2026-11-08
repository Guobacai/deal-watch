// `npm start`: run the local service on 127.0.0.1.
import { loadConfig } from "./config";
import { MacNotifier } from "./notify/macos";
import type { Notifier } from "./notify/types";
import { openInChrome } from "./openTabs";
import { Reminder } from "./reminder";
import { RunManager } from "./runs";
import { buildServer } from "./server";
import { HistoryRepository } from "./store/history";
import { ItemRepository } from "./store/items";
import { StateRepository } from "./store/state";
import { findDrops, summaryNotification } from "./summary";

const cfg = loadConfig();
const portalUrl = `http://127.0.0.1:${cfg.port}`;
const items = new ItemRepository(cfg.itemsPath);
const history = new HistoryRepository(cfg.historyPath);
const state = new StateRepository(cfg.statePath);
const notifier: Notifier = cfg.notifications ? new MacNotifier() : { notify: async () => undefined };

const runs = new RunManager({
  items,
  history,
  state,
  openTabs: openInChrome,
  timeoutMs: cfg.runTimeoutMs,
  onFinish: (s) => {
    app.log.info(`Check finished: ${s.ok} saved, ${s.failed} failed, ${s.missed} missed (run ${s.id})`);
    // A notification that fails is logged; it never affects the run.
    findDrops(s, history)
      .then((drops) => notifier.notify(summaryNotification(s, drops, portalUrl)))
      .catch((e) => app.log.error(e, "Couldn't send the summary notification"));
  },
});
const app = buildServer({ port: cfg.port, items, history, runs, dedupeWindowMs: cfg.dedupeWindowMs, logger: true });

const reminder = new Reminder({
  items,
  state,
  runs,
  notifier,
  reminderMinutes: cfg.reminderMinutes,
  portalUrl,
  log: (msg, err) => (err ? app.log.error(err, msg) : app.log.info(msg)),
});

// Every 15 s: time out runs whose items never reported (also covers a run left over from before a restart).
const runTicker = setInterval(() => {
  runs.tick().catch((e) => app.log.error(e));
}, 15_000);
// Every minute: send the daily reminder if it's due. Timers pause while the Mac sleeps,
// so after waking the next tick sends a reminder that was missed.
const reminderTicker = setInterval(() => void reminder.tick(), 60_000);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  clearInterval(runTicker);
  clearInterval(reminderTicker);
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: "127.0.0.1", port: cfg.port });
  const hh = String(Math.floor(cfg.reminderMinutes / 60)).padStart(2, "0");
  const mm = String(cfg.reminderMinutes % 60).padStart(2, "0");
  app.log.info(
    `Costco Price Watcher running at ${portalUrl} (data in ${cfg.dataDir}). ` +
      `Daily reminder at ${hh}:${mm}${cfg.notifications ? "" : " (notifications off)"}.`,
  );
  void reminder.tick();
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
