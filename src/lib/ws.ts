// WebSocket client to the QVAC companion daemon. Request/streaming-frame/final protocol:
// send {id,type,...} -> receive zero or more frames {id,type,...} (no `ok`) -> a final {id,ok,data|error}.
// Uses the global WebSocket (present in the Obsidian renderer AND Node 22+, so this is headless-testable).

import type { Frame, RpcResult } from "./rpc";

type Json = Record<string, unknown>;

interface Pending {
  frames: Frame[];
  onFrame?: (f: Frame) => void;
  resolve: (r: RpcResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  gen: number; // the socket generation this rpc was sent on
}

// A message from the daemon: a streaming frame (no `ok`) or a final result (`ok` present).
interface ServerMessage extends Frame {
  id: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
}

function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : "connection error");
}

// The daemon speaks text frames. Normalize whatever the socket hands us (string in the renderer,
// Buffer/typed-array or ArrayBuffer under Node) to a string without a base-to-string coercion.
function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return "";
}

export class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private gen = 0; // bumped per socket; a dead socket's onclose only fails ITS generation's rpcs
  private pending = new Map<string, Pending>();
  private opening: Promise<void> | null = null;
  onStatus?: (connected: boolean) => void;
  private url: string;

  constructor(url: string) { this.url = url; }

  setUrl(url: string) { if (url !== this.url) { this.url = url; this.close(); } }

  private connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening !== null) return this.opening;
    const gen = ++this.gen; // this connection's generation
    this.opening = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) { this.opening = null; reject(asError(e)); return; }
      this.ws = ws;
      ws.onopen = () => { this.opening = null; this.onStatus?.(true); resolve(); };
      ws.onerror = () => { this.opening = null; this.onStatus?.(false); reject(new Error("companion connection failed")); };
      // Only fail requests that were sent on THIS socket. Otherwise a stale socket's deferred
      // onclose (e.g. after a daemon restart on a new port) would reject the freshly-reconnected
      // socket's in-flight rpcs - a real hang/spurious-error bug.
      ws.onclose = () => { this.onStatus?.(false); this.failGen(gen, "connection closed"); if (this.ws === ws) this.ws = null; };
      ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    });
    return this.opening;
  }

  private onMessage(raw: unknown) {
    let m: ServerMessage;
    try { m = JSON.parse(toText(raw)) as ServerMessage; } catch { return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.ok === undefined) { p.frames.push(m); p.onFrame?.(m); return; } // streaming frame
    clearTimeout(p.timer); this.pending.delete(m.id);
    p.resolve({ ok: m.ok, data: m.data, error: m.error, frames: p.frames });
  }

  private failGen(gen: number, reason: string) {
    for (const [id, p] of this.pending) {
      if (p.gen !== gen) continue;
      clearTimeout(p.timer); this.pending.delete(id); p.reject(new Error(reason));
    }
  }
  private failAll(reason: string) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  async rpc<T = unknown, F extends Frame = Frame>(
    type: string,
    payload: Json = {},
    opts: { onFrame?: (f: F) => void; timeoutMs?: number } = {},
  ): Promise<RpcResult<T>> {
    await this.connect();
    const id = "p" + String(++this.seq);
    const gen = this.gen;
    const onFrame: ((f: Frame) => void) | undefined = opts.onFrame;
    // The pending map is untyped (RpcResult<unknown>); cast the final result to the caller's T.
    const result = await new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(type + " timed out")); }, opts.timeoutMs ?? 120000);
      this.pending.set(id, { frames: [], onFrame, resolve, reject, timer, gen });
      try { this.ws?.send(JSON.stringify({ id, type, ...payload })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(asError(e)); }
    });
    return result as RpcResult<T>;
  }

  close() { try { this.ws?.close(); } catch { /* */ } this.ws = null; this.failAll("closed"); }
}
