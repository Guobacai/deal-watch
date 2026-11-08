// Settings page: service address, connection test, and the offline queue.
import { getCloseRunTabs, getServiceUrl, isValidServiceUrl, setCloseRunTabs, setServiceUrl, type Message } from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const urlInput = $<HTMLInputElement>("url");
const status = $("status");

function show(text: string, ok: boolean) {
  status.textContent = text;
  status.className = ok ? "ok" : "bad";
}

const send = <T>(msg: Message) => chrome.runtime.sendMessage(msg) as Promise<T>;

async function refreshQueued() {
  const s = await send<{ queued: number }>({ type: "status" });
  $("queued").textContent = String(s.queued);
}

$("save").addEventListener("click", async () => {
  try {
    await setServiceUrl(urlInput.value);
    show("Saved.", true);
  } catch (e) {
    show((e as Error).message, false);
  }
});

$("test").addEventListener("click", async () => {
  const url = urlInput.value.trim().replace(/\/$/, "");
  if (!isValidServiceUrl(url)) return show("Use http://127.0.0.1:<port> or http://localhost:<port>", false);
  try {
    const res = await fetch(`${url}/api/health`);
    const body = await res.json();
    if (res.ok && body.ok) show("Connected ✓", true);
    else show(`The service answered with HTTP ${res.status}`, false);
  } catch {
    show("Can't reach the service. Is `npm start` running?", false);
  }
});

$("flush").addEventListener("click", async () => {
  const r = await send<{ delivered: number; dropped: number; remaining: number }>({ type: "flush" });
  show(
    r.remaining === 0 ? `Sent ${r.delivered}.` : `Sent ${r.delivered}; ${r.remaining} still waiting (service not reachable).`,
    r.remaining === 0,
  );
  await refreshQueued();
});

const closeTabs = $<HTMLInputElement>("close-tabs");
closeTabs.addEventListener("change", async () => {
  await setCloseRunTabs(closeTabs.checked);
  show(closeTabs.checked ? "Run tabs will close after saving." : "Run tabs will stay open.", true);
});

void (async () => {
  urlInput.value = await getServiceUrl();
  closeTabs.checked = await getCloseRunTabs();
  await refreshQueued();
})();
