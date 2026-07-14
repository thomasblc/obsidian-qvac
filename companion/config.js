// Companion config + paths. Everything lives under ~/.qvac-obsidian (overridable via
// QVAC_OBSIDIAN_CONFIG_DIR so tests isolate from the real one). Nothing leaves the machine.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CONFIG_DIR = process.env.QVAC_OBSIDIAN_CONFIG_DIR || path.join(os.homedir(), ".qvac-obsidian");

// Sanitize a client-supplied vaultId to a filesystem-safe token. The ONLY thing that may ever be
// joined onto a server path from `vaultId`, so every path sink (index dir, training dataset dir,
// dataset label) must route through here - a raw `String(vaultId)` is a path-traversal sink.
export function safeVaultId(vaultId) {
  return String(vaultId || "default").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "default";
}

// Per-vault data dir (holds that vault's index.json + vectors.bin). The id is sanitized so a
// crafted value can never escape CONFIG_DIR.
export function vaultDir(vaultId) {
  return path.join(CONFIG_DIR, "vaults", safeVaultId(vaultId));
}

// Stable id for a vault = short sha1 of its absolute root path (the plugin computes the same).
export function vaultIdForPath(absPath) {
  return crypto.createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 16);
}

// Per-boot bearer token. Written 0600 so only this user can read it; the desktop plugin reads
// it via Node fs and sends ?t= (WS) / Authorization (HTTP). Persisted so a daemon restart keeps
// the same token (the plugin re-reads it). Token auth, not an Origin allowlist: any Electron app
// shares the app://obsidian.md origin and Origin is spoofable.
// The config dir holds the bearer token (in `token` AND `daemon.json`). It MUST be 0700 and the
// token files 0600, or any other local user reads the token and fully authenticates. mkdir's mode
// only applies on CREATE, so chmod defensively on every boot (a dir created before this fix is 0755).
function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* */ }
}
export function ensureToken() {
  ensureConfigDir();
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
  ensureConfigDir();
  const f = daemonFile();
  // 0600: daemon.json contains the same bearer token, so it must be no more readable than `token`.
  fs.writeFileSync(f, JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* */ } // tighten a pre-existing 0644 file
}
export function removeDaemonFile() { try { fs.unlinkSync(daemonFile()); } catch { /* */ } }
