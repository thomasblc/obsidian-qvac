// Wave-0 daemon regressions (no SDK worker needed). Run: node server/_verify_wave0.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const ok = (name) => { console.log("  ok -", name); pass++; };

// isolate config in a throwaway dir (CONFIG_DIR is read at import time)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qvac-w0-"));
process.env.QVAC_OBSIDIAN_CONFIG_DIR = TMP;

const { safeVaultId, vaultDir, ensureToken, writeDaemonFile, daemonFile, CONFIG_DIR } = await import("./config.js");

// --- 0.3: vaultId path-traversal sanitized ---
assert.equal(safeVaultId("../../etc/passwd"), "etcpasswd");
assert.equal(safeVaultId("a/b/../c"), "abc");
assert.equal(safeVaultId(""), "default");
assert.ok(!path.relative(CONFIG_DIR, vaultDir("../../../../tmp/evil")).startsWith(".."), "vaultDir stays under CONFIG_DIR");
ok("0.3 vaultId sanitized (no path traversal)");

// --- 0.2: token + daemon.json are 0600, config dir 0700 ---
const tok = ensureToken();
assert.equal(fs.statSync(path.join(TMP, "token")).mode & 0o777, 0o600, "token is 0600");
assert.equal(fs.statSync(TMP).mode & 0o777, 0o700, "config dir is 0700");
writeDaemonFile({ port: 1234, token: tok });
assert.equal(fs.statSync(daemonFile()).mode & 0o777, 0o600, "daemon.json is 0600 (token no longer world-readable)");
ok("0.2 token files 0600 + config dir 0700");

// --- 0.12: evalFraction:0 puts EVERY doc in train (no stranded doc[0]) ---
const { buildCausalDataset } = await import("./select.js");
const files = { "a.md": "A".repeat(400), "b.md": "B".repeat(400), "c.md": "C".repeat(400) };
const vault = { read: (rel) => files[rel] };
const outDir = path.join(TMP, "ds");
const ds = buildCausalDataset(vault, Object.keys(files), outDir, { evalFraction: 0 });
const trainTxt = fs.readFileSync(ds.trainPath, "utf8");
for (const k of ["A", "B", "C"]) assert.ok(trainTxt.includes(k.repeat(400)), `${k} present in train (not stranded in eval)`);
assert.equal(ds.trainDocs, 3, "all 3 docs in train");
ok("0.12 evalFraction:0 -> all docs train (doc[0] not stranded)");

// --- 0.7: mm.pause() rejects a load path BEFORE it can collide with the training lock ---
const { ModelManager } = await import("./models.js");
const mm = new ModelManager({});
mm.pause();
await assert.rejects(() => mm.embedMany(["x"]), /training/i, "embed rejects while paused");
await assert.rejects(() => mm.ensureLLM({ baseKey: "4b" }), /training/i, "llm load rejects while paused");
mm.resume();
ok("0.7 pause gate rejects load paths (no worker collision with training)");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[WAVE0] ${pass}/4 groups passed`);
process.exit(0);
