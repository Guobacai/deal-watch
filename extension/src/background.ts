// Background service worker: receives captures from Costco tabs and delivers them to the local service.
// It makes no requests to Costco and opens no pages.
import { CaptureQueue, postCapture, type Capture, type DeliverResult } from "./queue";
import { getCloseRunTabs, getServiceUrl, shouldCloseTab, type CaptureOutcome, type Message } from "./settings";

const QUEUE_KEY = "pendingCaptures";

const queue = new CaptureQueue(
  {
    load: async () => ((await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] as Capture[] | undefined) ?? [],
    save: async (list) => chrome.storage.local.set({ [QUEUE_KEY]: list }),
  },
  async (c) => postCapture(await getServiceUrl(), c),
);

async function updateBadge() {
  const n = await queue.size();
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#b26b00" });
  await chrome.action.setTitle({ title: n > 0 ? `${n} price(s) waiting for the local service` : "Costco Price Watcher" });
}

function toOutcome(r: DeliverResult): CaptureOutcome {
  switch (r.kind) {
    case "queued":
      return { outcome: "queued", queued: r.queued, error: r.error };
    case "rejected":
      return { outcome: "rejected", error: r.error };
    case "unreachable": // deliver() never returns this (it queues instead), but keep the switch exhaustive
      return { outcome: "queued", queued: 1, error: r.error };
    case "delivered": {
      const body = r.body as { watched?: boolean; saved?: boolean; comparison?: unknown } | null;
      if (!body?.watched) return { outcome: "unwatched" };
      return { outcome: body.saved ? "saved" : "duplicate", comparison: body.comparison };
    }
  }
}

async function flush() {
  const result = await queue.flush();
  await updateBadge();
  return result;
}

chrome.runtime.onMessage.addListener((msg: Message, _sender: chrome.runtime.MessageSender, sendResponse) => {
  (async () => {
    if (msg.type === "capture") {
      const result = await queue.deliver(msg.capture);
      await updateBadge();
      const outcome = toOutcome(result);
      const tabId = _sender.tab?.id;
      if (tabId !== undefined && shouldCloseTab(!!msg.runTab, msg.capture.price !== null, outcome.outcome, await getCloseRunTabs())) {
        // Leave the "saved" note up for a moment, then close the tab the run opened.
        setTimeout(() => void chrome.tabs.remove(tabId).catch(() => undefined), 1500);
        return { ...outcome, closingTab: true };
      }
      return outcome;
    }
    if (msg.type === "flush") return flush();
    if (msg.type === "status") return { queued: await queue.size(), serviceUrl: await getServiceUrl() };
  })().then(sendResponse, (e: Error) => sendResponse({ outcome: "rejected", error: e.message }));
  return true; // keep the channel open for the async response
});

// Retry queued captures every minute, and when Chrome starts.
chrome.alarms.create("flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "flush") void flush();
});
chrome.runtime.onStartup.addListener(() => void flush());
chrome.runtime.onInstalled.addListener(() => void updateBadge());
