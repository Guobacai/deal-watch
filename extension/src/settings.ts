// Extension settings, kept in chrome.storage.local.
export const DEFAULT_SERVICE_URL = "http://127.0.0.1:4000";

/** Only this Mac's own service is allowed (the manifest grants no other hosts). */
export function isValidServiceUrl(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(url.trim());
}

export async function getServiceUrl(): Promise<string> {
  const { serviceUrl } = await chrome.storage.local.get("serviceUrl");
  return typeof serviceUrl === "string" && isValidServiceUrl(serviceUrl) ? serviceUrl.replace(/\/$/, "") : DEFAULT_SERVICE_URL;
}

export async function setServiceUrl(url: string): Promise<void> {
  if (!isValidServiceUrl(url)) throw new Error("Use http://127.0.0.1:<port> or http://localhost:<port>");
  await chrome.storage.local.set({ serviceUrl: url.trim().replace(/\/$/, "") });
}

/** Close tabs opened by "Check all" once their price is saved. On unless turned off in the options. */
export async function getCloseRunTabs(): Promise<boolean> {
  const { closeRunTabs } = await chrome.storage.local.get("closeRunTabs");
  return closeRunTabs !== false;
}

export async function setCloseRunTabs(on: boolean): Promise<void> {
  await chrome.storage.local.set({ closeRunTabs: on });
}

/** Tabs opened by a check run carry this in their #fragment (never sent to Costco). */
export const RUN_TAB_MARK = /(?:^#|&)cpw-run=[\w-]+/;

/** Only a tab opened by a run, and only after its price was saved, is closed. Failures stay open so you can look. */
export const shouldCloseTab = (isRunTab: boolean, gotPrice: boolean, outcome: CaptureOutcome["outcome"], enabled: boolean) =>
  enabled && isRunTab && gotPrice && (outcome === "saved" || outcome === "duplicate");

// Messages between the content script / options page and the background worker.
export type CaptureOutcome =
  | { outcome: "saved" | "duplicate"; comparison?: unknown; closingTab?: boolean }
  | { outcome: "unwatched" }
  | { outcome: "queued"; queued: number; error: string }
  | { outcome: "rejected"; error: string };

export type Message =
  | { type: "capture"; capture: import("./queue").Capture; runTab?: boolean }
  | { type: "flush" }
  | { type: "status" };
