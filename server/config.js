// Companion config + paths. Everything lives under ~/.qvac-obsidian (overridable via
// QVAC_OBSIDIAN_CONFIG_DIR so tests isolate from the real one). Nothing leaves the machine.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CONFIG_DIR = process.env.QVAC_OBSIDIAN_CONFIG_DIR || path.join(os.homedir(), ".qvac-obsidian");

// Per-vault data dir (holds that vault's index.json + vectors.bin). The id is sanitized so a
// crafted value can never escape CONFIG_DIR.
export function vaultDir(vaultId) {
  const safe = String(vaultId || "default").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "default";
  return path.join(CONFIG_DIR, "vaults", safe);
}

// Stable id for a vault = short sha1 of its absolute root path (the plugin computes the same).
export function vaultIdForPath(absPath) {
  return crypto.createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 16);
}

// Per-boot bearer token. Written 0600 so only this user can read it; the desktop plugin reads
// it via Node fs and sends ?t= (WS) / Authorization (HTTP). Persisted so a daemon restart keeps
// the same token (the plugin re-reads it). Token auth, not an Origin allowlist: any Electron app
// shares the app://obsidian.md origin and Origin is spoofable.
export function ensureToken() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const f = path.join(CONFIG_DIR, "token");
  try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t; } catch { /* */ }
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

// daemon.json = discovery file. The plugin reads {port, token}, health-checks, and connects;
// if the daemon is down it spawns one. A single shared daemon serves all vaults.
export function daemonFile() { return path.join(CONFIG_DIR, "daemon.json"); }
export function writeDaemonFile({ port, token }) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(daemonFile(), JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }, null, 2));
}
export function removeDaemonFile() { try { fs.unlinkSync(daemonFile()); } catch { /* */ } }
