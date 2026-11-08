"use strict";
(() => {
  // extension/src/settings.ts
  var DEFAULT_SERVICE_URL = "http://127.0.0.1:4000";
  function isValidServiceUrl(url) {
    return /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(url.trim());
  }
  async function getServiceUrl() {
    const { serviceUrl } = await chrome.storage.local.get("serviceUrl");
    return typeof serviceUrl === "string" && isValidServiceUrl(serviceUrl) ? serviceUrl.replace(/\/$/, "") : DEFAULT_SERVICE_URL;
  }
  async function setServiceUrl(url) {
    if (!isValidServiceUrl(url)) throw new Error("Use http://127.0.0.1:<port> or http://localhost:<port>");
    await chrome.storage.local.set({ serviceUrl: url.trim().replace(/\/$/, "") });
  }
  async function getCloseRunTabs() {
    const { closeRunTabs } = await chrome.storage.local.get("closeRunTabs");
    return closeRunTabs !== false;
  }
  async function setCloseRunTabs(on) {
    await chrome.storage.local.set({ closeRunTabs: on });
  }

  // extension/src/options.ts
  var $ = (id) => document.getElementById(id);
  var urlInput = $("url");
  var status = $("status");
  function show(text, ok) {
    status.textContent = text;
    status.className = ok ? "ok" : "bad";
  }
  var send = (msg) => chrome.runtime.sendMessage(msg);
  async function refreshQueued() {
    const s = await send({ type: "status" });
    $("queued").textContent = String(s.queued);
  }
  $("save").addEventListener("click", async () => {
    try {
      await setServiceUrl(urlInput.value);
      show("Saved.", true);
    } catch (e) {
      show(e.message, false);
    }
  });
  $("test").addEventListener("click", async () => {
    const url = urlInput.value.trim().replace(/\/$/, "");
    if (!isValidServiceUrl(url)) return show("Use http://127.0.0.1:<port> or http://localhost:<port>", false);
    try {
      const res = await fetch(`${url}/api/health`);
      const body = await res.json();
      if (res.ok && body.ok) show("Connected \u2713", true);
      else show(`The service answered with HTTP ${res.status}`, false);
    } catch {
      show("Can't reach the service. Is `npm start` running?", false);
    }
  });
  $("flush").addEventListener("click", async () => {
    const r = await send({ type: "flush" });
    show(
      r.remaining === 0 ? `Sent ${r.delivered}.` : `Sent ${r.delivered}; ${r.remaining} still waiting (service not reachable).`,
      r.remaining === 0
    );
    await refreshQueued();
  });
  var closeTabs = $("close-tabs");
  closeTabs.addEventListener("change", async () => {
    await setCloseRunTabs(closeTabs.checked);
    show(closeTabs.checked ? "Run tabs will close after saving." : "Run tabs will stay open.", true);
  });
  void (async () => {
    urlInput.value = await getServiceUrl();
    closeTabs.checked = await getCloseRunTabs();
    await refreshQueued();
  })();
})();
