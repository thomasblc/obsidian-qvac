// Regression for Wave-0 0.5: a stale socket's onclose must fail ONLY the requests sent on that
// socket, not the in-flight requests of a freshly-reconnected socket (daemon-restart-on-new-port).
import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal fake WebSocket we can drive by hand. Exposes the last instance so the test can fire events.
class FakeWS {
  static OPEN = 1; static instances: FakeWS[] = [];
  readyState = 0; onopen: any; onclose: any; onerror: any; onmessage: any; sent: string[] = [];
  constructor(_url: string) { FakeWS.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
}

const flush = () => new Promise((r) => setTimeout(r, 0)); // drain all pending microtasks

test("0.5: an old socket's onclose does not reject the new socket's in-flight rpc", async () => {
  (globalThis as any).WebSocket = FakeWS as any;
  // ws.ts uses window.setTimeout (popout-window safe); in Node, point window at the global.
  (globalThis as any).window = globalThis;
  FakeWS.instances = [];
  const { WsClient } = await import("../src/lib/ws.ts");
  const c = new WsClient("ws://x");

  // gen 1: open, start an rpc, then the socket dies -> that rpc rejects.
  let rejected1 = false;
  const p1 = c.rpc("chat", {}, { timeoutMs: 5000 }); p1.catch(() => { rejected1 = true; });
  await flush(); FakeWS.instances[0].open(); await flush();
  assert.equal(FakeWS.instances[0].sent.length, 1, "gen-1 rpc was sent before close");
  FakeWS.instances[0].close(); await flush();
  assert.equal(rejected1, true, "gen-1 rpc rejects when its own socket closes");

  // gen 2: reconnect, start a fresh rpc.
  let settled2 = false;
  const p2 = c.rpc("chat", {}, { timeoutMs: 5000 }); p2.then(() => { settled2 = true; }, () => { settled2 = true; });
  await flush(); FakeWS.instances[1].open(); await flush();

  // Fire the OLD (gen-1) socket's onclose AGAIN. It must NOT touch the gen-2 rpc.
  FakeWS.instances[0].onclose && FakeWS.instances[0].onclose();
  await flush();
  assert.equal(settled2, false, "gen-2 rpc is untouched by a stale socket's close");

  // finish gen 2 cleanly (final reply frame)
  const id = JSON.parse(FakeWS.instances[1].sent[0]).id;
  FakeWS.instances[1].onmessage({ data: JSON.stringify({ id, ok: true, data: { contentText: "hi" } }) });
  const r = await p2;
  assert.equal(r.ok, true);
});
