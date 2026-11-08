import { describe, expect, it } from "vitest";
import { CaptureQueue, MAX_QUEUED, postCapture, type Capture, type SendResult } from "../extension/src/queue";

const capture = (n: number): Capture => ({
  url: `https://www.costco.com/p/-/item/${n}`,
  price: n,
  capturedAt: new Date(Date.UTC(2026, 10, 8, 9, n)).toISOString(),
});

function memoryStorage(initial: Capture[] = []) {
  let list = [...initial];
  return { load: async () => [...list], save: async (l: Capture[]) => void (list = [...l]), peek: () => list };
}

/** A fake service that can be switched up/down and records what it received. */
function fakeService() {
  const received: Capture[] = [];
  const state = { up: true, reject: new Set<string>() };
  const send = async (c: Capture): Promise<SendResult> => {
    if (!state.up) return { kind: "unreachable", error: "connection refused" };
    if (state.reject.has(c.url)) return { kind: "rejected", status: 400, error: "bad" };
    received.push(c);
    return { kind: "delivered", status: 201, body: { saved: true } };
  };
  return { send, received, state };
}

describe("CaptureQueue", () => {
  it("delivers right away when the service is up", async () => {
    const storage = memoryStorage();
    const svc = fakeService();
    const q = new CaptureQueue(storage, svc.send);
    expect(await q.deliver(capture(1))).toMatchObject({ kind: "delivered", status: 201 });
    expect(svc.received).toHaveLength(1);
    expect(storage.peek()).toEqual([]);
  });

  it("queues while the service is down and delivers in order once it's back", async () => {
    const storage = memoryStorage();
    const svc = fakeService();
    const q = new CaptureQueue(storage, svc.send);
    svc.state.up = false;
    expect(await q.deliver(capture(1))).toMatchObject({ kind: "queued", queued: 1 });
    expect(await q.deliver(capture(2))).toMatchObject({ kind: "queued", queued: 2 });
    expect(svc.received).toHaveLength(0);

    svc.state.up = true;
    expect(await q.flush()).toEqual({ delivered: 2, dropped: 0, remaining: 0 });
    expect(svc.received.map((c) => c.price)).toEqual([1, 2]);
    expect(await q.size()).toBe(0);
  });

  it("flushes older captures before sending a new one, keeping the order", async () => {
    const svc = fakeService();
    const q = new CaptureQueue(memoryStorage([capture(1), capture(2)]), svc.send);
    expect(await q.deliver(capture(3))).toMatchObject({ kind: "delivered" });
    expect(svc.received.map((c) => c.price)).toEqual([1, 2, 3]);
  });

  it("drops a capture the service rejects (4xx) instead of retrying it forever", async () => {
    const svc = fakeService();
    svc.state.reject.add(capture(2).url);
    const q = new CaptureQueue(memoryStorage([capture(1), capture(2), capture(3)]), svc.send);
    expect(await q.flush()).toEqual({ delivered: 2, dropped: 1, remaining: 0 });
  });

  it("returns a rejection for a new capture without queuing it", async () => {
    const storage = memoryStorage();
    const svc = fakeService();
    svc.state.reject.add(capture(1).url);
    const q = new CaptureQueue(storage, svc.send);
    expect(await q.deliver(capture(1))).toMatchObject({ kind: "rejected", status: 400 });
    expect(storage.peek()).toEqual([]);
  });

  it(`keeps at most ${MAX_QUEUED} captures, dropping the oldest`, async () => {
    const storage = memoryStorage(Array.from({ length: MAX_QUEUED }, (_, i) => capture(i)));
    const svc = fakeService();
    svc.state.up = false;
    const q = new CaptureQueue(storage, svc.send);
    await q.deliver(capture(999));
    const list = storage.peek();
    expect(list).toHaveLength(MAX_QUEUED);
    expect(list[0].price).toBe(1);
    expect(list.at(-1)!.price).toBe(999);
  });

  it("handles captures arriving at the same time without losing any", async () => {
    const storage = memoryStorage();
    const svc = fakeService();
    svc.state.up = false;
    const q = new CaptureQueue(storage, svc.send);
    await Promise.all([1, 2, 3, 4, 5].map((n) => q.deliver(capture(n))));
    expect(storage.peek()).toHaveLength(5);
  });
});

describe("postCapture()", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("posts JSON to /api/observations", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    await postCapture("http://127.0.0.1:4000/", capture(1), fetchFn);
    expect(seen!.url).toBe("http://127.0.0.1:4000/api/observations");
    expect(seen!.init?.method).toBe("POST");
    expect(JSON.parse(seen!.init?.body as string)).toMatchObject({ price: 1 });
  });

  it.each([
    [201, { saved: true }, "delivered"],
    [202, { watched: false }, "delivered"],
    [400, { error: "invalid price" }, "rejected"],
    [403, { error: "forbidden" }, "rejected"],
    [500, { error: "history.json: not valid JSON" }, "unreachable"],
  ])("HTTP %s → %s", async (status, body, kind) => {
    expect((await postCapture("http://127.0.0.1:4000", capture(1), respond(status, body))).kind).toBe(kind);
  });

  it("a network error means unreachable", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await postCapture("http://127.0.0.1:4000", capture(1), fetchFn)).toMatchObject({ kind: "unreachable" });
  });
});
