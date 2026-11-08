// Delivers captures to the local service, queuing them while it's unreachable.
// No chrome.* calls here, so it can be unit-tested with fakes.

export interface Capture {
  url: string;
  price: number | null;
  name?: string;
  via?: string;
  error?: string;
  capturedAt: string;
}

/** What the service said, or why it couldn't be reached. */
export type SendResult =
  | { kind: "delivered"; status: number; body: unknown } // 2xx
  | { kind: "rejected"; status: number; error: string } // 4xx: the capture itself is bad; retrying won't help
  | { kind: "unreachable"; error: string }; // network error or 5xx: try again later

export interface QueueStorage {
  load(): Promise<Capture[]>;
  save(list: Capture[]): Promise<void>;
}

export type DeliverResult = SendResult | { kind: "queued"; error: string; queued: number };

export const MAX_QUEUED = 200;

export class CaptureQueue {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: QueueStorage,
    private readonly send: (c: Capture) => Promise<SendResult>,
  ) {}

  /** Try to send now; if the service is unreachable, keep it for later. Flushes older captures first. */
  deliver(capture: Capture): Promise<DeliverResult> {
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
  flush(): Promise<{ delivered: number; dropped: number; remaining: number }> {
    return this.exclusive(() => this.flushLocked());
  }

  async size(): Promise<number> {
    return (await this.storage.load()).length;
  }

  private async flushLocked() {
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

  private async enqueue(pending: Capture[], capture: Capture, error: string): Promise<DeliverResult> {
    const list = [...pending, capture].slice(-MAX_QUEUED); // keep the newest if the service is down for a long time
    await this.storage.save(list);
    return { kind: "queued", error, queued: list.length };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** POST a capture to the service and classify the outcome. */
export async function postCapture(serviceUrl: string, capture: Capture, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn(`${serviceUrl.replace(/\/$/, "")}/api/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(capture),
    });
  } catch (e) {
    return { kind: "unreachable", error: `service not reachable (${(e as Error).message})` };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return { kind: "delivered", status: res.status, body };
  const error = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
  if (res.status >= 500) return { kind: "unreachable", error };
  return { kind: "rejected", status: res.status, error };
}
