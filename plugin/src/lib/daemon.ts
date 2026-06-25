// Companion daemon discovery (desktop-only: Node fs/os). The daemon writes ~/.qvac-obsidian/daemon.json
// {port, token, pid}; the plugin reads it, health-checks, and connects. If it is down the plugin shows
// an "install/start QVAC" state and (P5) can spawn the bundled companion. A single daemon serves all vaults.
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DaemonInfo { port: number; token: string; pid?: number; }

export function configDir(): string {
  return process.env.QVAC_OBSIDIAN_CONFIG_DIR || join(homedir(), ".qvac-obsidian");
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const j = JSON.parse(readFileSync(join(configDir(), "daemon.json"), "utf8"));
    if (j && typeof j.port === "number" && typeof j.token === "string") return { port: j.port, token: j.token, pid: j.pid };
  } catch { /* */ }
  return null;
}

export async function healthOk(info: DaemonInfo): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health?t=${encodeURIComponent(info.token)}`);
    if (r.ok) return await r.json();
  } catch { /* */ }
  return null;
}

export function wsUrl(info: DaemonInfo): string {
  return `ws://127.0.0.1:${info.port}?t=${encodeURIComponent(info.token)}`;
}
