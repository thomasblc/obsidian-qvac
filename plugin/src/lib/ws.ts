// WebSocket client to the QVAC companion daemon. Request/streaming-frame/final protocol:
// send {id,type,...} -> receive zero or more frames {id,type,...} (no `ok`) -> a final {id,ok,data|error}.
// Uses the global WebSocket (present in the Obsidian renderer AND Node 22+, so this is headless-testable).

export type Frame = any;
export interface RpcResult { ok: boolean; data?: any; error?: string; frames: Frame[]; }

interface Pending {
  frames: Frame[];
  onFrame?: (f: Frame) => void;
  resolve: (r: RpcResult) => void;
  reject: (e: Error) => void;
  timer: any;
  gen: number; // the socket generation this rpc was sent on
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
    if (this.opening) return this.opening;
    const gen = ++this.gen; // this connection's generation
    this.opening = new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) { this.opening = null; return reject(e as Error); }
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

  private onMessage(raw: any) {
    let m: any; try { m = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
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

  async rpc(type: string, payload: any = {}, opts: { onFrame?: (f: Frame) => void; timeoutMs?: number } = {}): Promise<RpcResult> {
    await this.connect();
    const id = "p" + ++this.seq;
    const gen = this.gen;
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(type + " timed out")); }, opts.timeoutMs ?? 120000);
      this.pending.set(id, { frames: [], onFrame: opts.onFrame, resolve, reject, timer, gen });
      try { this.ws!.send(JSON.stringify({ id, type, ...payload })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  close() { try { this.ws?.close(); } catch { /* */ } this.ws = null; this.failAll("closed"); }
}
