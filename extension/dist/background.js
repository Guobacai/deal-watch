"use strict";
(() => {
  // extension/src/queue.ts
  var MAX_QUEUED = 200;
  var CaptureQueue = class {
    constructor(storage, send) {
      this.storage = storage;
      this.send = send;
    }
    storage;
    send;
    chain = Promise.resolve();
    /** Try to send now; if the service is unreachable, keep it for later. Flushes older captures first. */
    deliver(capture) {
      return this.exclusive(async () => {
        await this.flushLocked();
        const pending = await this.storage.load();
        if (pending.length > 0) return this.enqueue(pending, capture, "older captures are still waiting");
        const result = await this.send(capture);
        if (result.kind === "unreachable") return this.enqueue(pending, capture, result.error);
        return result;
      });
    }
    /** Send queued captures oldest-first; stops at the first one that still can't be delivered. */
    flush() {
      return this.exclusive(() => this.flushLocked());
    }
    async size() {
      return (await this.storage.load()).length;
    }
    async flushLocked() {
      const pending = await this.storage.load();
      let delivered = 0;
      let dropped = 0;
      while (pending.length > 0) {
        const result = await this.send(pending[0]);
        if (result.kind === "unreachable") break;
        pending.shift();
        if (result.kind === "delivered") delivered++;
        else dropped++;
      }
      if (delivered || dropped) await this.storage.save(pending);
      return { delivered, dropped, remaining: pending.length };
    }
    async enqueue(pending, capture, error) {
      const list = [...pending, capture].slice(-MAX_QUEUED);
      await this.storage.save(list);
      return { kind: "queued", error, queued: list.length };
    }
    exclusive(fn) {
      const next = this.chain.then(fn, fn);
      this.chain = next.catch(() => void 0);
      return next;
    }
  };
  async function postCapture(serviceUrl, capture, fetchFn = fetch) {
    let res;
    try {
      res = await fetchFn(`${serviceUrl.replace(/\/$/, "")}/api/observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(capture)
      });
    } catch (e) {
      return { kind: "unreachable", error: `service not reachable (${e.message})` };
    }
    const body = await res.json().catch(() => null);
    if (res.ok) return { kind: "delivered", status: res.status, body };
    const error = body?.error ?? `HTTP ${res.status}`;
    if (res.status >= 500) return { kind: "unreachable", error };
    return { kind: "rejected", status: res.status, error };
  }

  // extension/src/settings.ts
  var DEFAULT_SERVICE_URL = "http://127.0.0.1:4000";
  function isValidServiceUrl(url) {
    return /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(url.trim());
  }
  async function getServiceUrl() {
    const { serviceUrl } = await chrome.storage.local.get("serviceUrl");
    return typeof serviceUrl === "string" && isValidServiceUrl(serviceUrl) ? serviceUrl.replace(/\/$/, "") : DEFAULT_SERVICE_URL;
  }
  async function getCloseRunTabs() {
    const { closeRunTabs } = await chrome.storage.local.get("closeRunTabs");
    return closeRunTabs !== false;
  }
  var shouldCloseTab = (isRunTab, gotPrice, outcome, enabled) => enabled && isRunTab && gotPrice && (outcome === "saved" || outcome === "duplicate");

  // extension/src/background.ts
  var QUEUE_KEY = "pendingCaptures";
  var queue = new CaptureQueue(
    {
      load: async () => (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] ?? [],
      save: async (list) => chrome.storage.local.set({ [QUEUE_KEY]: list })
    },
    async (c) => postCapture(await getServiceUrl(), c)
  );
  async function updateBadge() {
    const n = await queue.size();
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b26b00" });
    await chrome.action.setTitle({ title: n > 0 ? `${n} price(s) waiting for the local service` : "Costco Price Watcher" });
  }
  function toOutcome(r) {
    switch (r.kind) {
      case "queued":
        return { outcome: "queued", queued: r.queued, error: r.error };
      case "rejected":
        return { outcome: "rejected", error: r.error };
      case "unreachable":
        return { outcome: "queued", queued: 1, error: r.error };
      case "delivered": {
        const body = r.body;
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
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === "capture") {
        const result = await queue.deliver(msg.capture);
        await updateBadge();
        const outcome = toOutcome(result);
        const tabId = _sender.tab?.id;
        if (tabId !== void 0 && shouldCloseTab(!!msg.runTab, msg.capture.price !== null, outcome.outcome, await getCloseRunTabs())) {
          setTimeout(() => void chrome.tabs.remove(tabId).catch(() => void 0), 1500);
          return { ...outcome, closingTab: true };
        }
        return outcome;
      }
      if (msg.type === "flush") return flush();
      if (msg.type === "status") return { queued: await queue.size(), serviceUrl: await getServiceUrl() };
    })().then(sendResponse, (e) => sendResponse({ outcome: "rejected", error: e.message }));
    return true;
  });
  chrome.alarms.create("flush", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "flush") void flush();
  });
  chrome.runtime.onStartup.addListener(() => void flush());
  chrome.runtime.onInstalled.addListener(() => void updateBadge());
})();
