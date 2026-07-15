// Companion daemon discovery (desktop-only: Node fs/os). The daemon writes ~/.qvac-obsidian/daemon.json
// {port, token, pid}; the plugin reads it, health-checks, and connects. If it is down the plugin shows
// an "install/start QVAC" state and (P5) can spawn the bundled companion. A single daemon serves all vaults.
import { readFileSync, homedir, join, envVar } from "./node";

export interface DaemonInfo { port: number; token: string; pid?: number; }

export function configDir(): string {
  return envVar("QVAC_OBSIDIAN_CONFIG_DIR") ?? join(homedir(), ".qvac-obsidian");
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const j = JSON.parse(readFileSync(join(configDir(), "daemon.json"), "utf8")) as Partial<DaemonInfo>;
    if (typeof j.port === "number" && typeof j.token === "string") return { port: j.port, token: j.token, pid: j.pid };
  } catch { /* */ }
  return null;
}

// NOTE: no HTTP `fetch()` health check here on purpose. The Obsidian renderer CORS-blocks a plain
// fetch to a localhost server (origin app://obsidian.md), so liveness + all RPC go over WebSocket
// (see main.ts checkHealth -> ws.rpc("health")). A raw fetch() here is both dead and a red flag
// for community-plugin review, so it is intentionally omitted.
export function wsUrl(info: DaemonInfo): string {
  return `ws://127.0.0.1:${info.port}?t=${encodeURIComponent(info.token)}`;
}
