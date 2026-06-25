// Training driver: runs the battle-tested S0 runner (spike/finetune.js) as a child
// process and streams its progress to the app. Reusing the runner keeps the hardware
// guard, the NaN guard, and the 1.7B no-intermediate-checkpoint hang fix in one place.
// On success the produced adapter (fixed name) is copied to a versioned file the user owns.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROGRESS_RE = /epoch (\d+) step (\d+) batch (\d+)\/(\d+) (train|val) loss (\S+) eta (\d+)s/;
// finetune.js prints: "adapter file: <name> (<MB> MB) -> <path relative to RECIPE_ROOT>"
// Capture MB (group 1) and the path after "-> " to end of line (group 2, allows spaces).
const ADAPTER_RE = /adapter file: .+ \(([\d.]+) MB\) -> (.+)$/;
const STATUS_RE = /^status: (\w+)/;

export class Trainer {
  // root = the training data dir (adapters/, train/ land here). script = absolute path to finetune.js.
  constructor(root, script) {
    this.root = root;
    this.script = script;
    this.child = null;
    this.running = false;
  }

  isRunning() { return this.running; }

  // opts: { baseKey, mode, dataset, trainPath, evalPath, ctx, epochs, lr }
  // onEvent({type, ...}) gets: progress, log, done, error.
  start(opts, onEvent) {
    if (this.running) throw new Error("a training run is already active");
    const { baseKey = "1.7b", mode = "causal", dataset = "vault", trainPath, evalPath, ctx = 256, epochs = 1, lr } = opts;
    const args = [this.script || "finetune.js", "--base", baseKey, "--mode", mode, "--data", dataset, "--ctx", String(ctx), "--epochs", String(epochs)];
    if (trainPath) args.push("--train", trainPath);
    if (evalPath) args.push("--eval", evalPath);
    if (lr) args.push("--lr", String(lr));

    this.running = true;
    const started = Date.now();
    fs.mkdirSync(this.root, { recursive: true });
    // QVAC_TRAIN_ROOT makes finetune.js write under this.root (the data dir), keeping its ROOT and
    // the Trainer's root identical so the printed adapter path resolves correctly.
    const child = spawn("node", args, { cwd: this.root, env: { ...process.env, QVAC_TRAIN_ROOT: this.root } });
    this.child = child;

    let adapterRel = null, adapterMB = null, status = null, lastLoss = null, lastVal = null;
    const handleLine = (line) => {
      if (!line.trim()) return;
      onEvent({ type: "log", line });
      const p = line.match(PROGRESS_RE);
      if (p) {
        const isVal = p[5] === "val";
        const loss = /^[\d.]+$/.test(p[6]) ? Number(p[6]) : null; // "NaN"/"undefined" -> null
        if (isVal) lastVal = loss; else lastLoss = loss;
        onEvent({
          type: "progress",
          epoch: Number(p[1]), step: Number(p[2]),
          batch: Number(p[3]), totalBatches: Number(p[4]),
          phase: p[5], loss, etaSec: Number(p[7]),
          trainLoss: lastLoss, valLoss: lastVal,
          elapsedSec: Math.round((Date.now() - started) / 1000),
        });
        return;
      }
      const a = line.match(ADAPTER_RE);
      if (a) { adapterMB = Number(a[1]); adapterRel = a[2].trim(); }
      const s = line.match(STATUS_RE);
      if (s) status = s[1];
    };

    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const l of parts) handleLine(l);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (code) => {
      if (buf) handleLine(buf);
      this.running = false; this.child = null;
      let versioned = null;
      const ok = status === "COMPLETED";
      if (ok) {
        try {
          // Prefer the path finetune.js printed; fall back to the known results dir
          // (so a parse miss still versions the adapter).
          let src = adapterRel ? path.join(this.root, adapterRel) : null;
          if (!src || !fs.existsSync(src)) {
            const fallback = path.join(this.root, "train", `results-${dataset}-${baseKey}`, "trained-lora-adapter.gguf");
            if (fs.existsSync(fallback)) src = fallback;
          }
          if (src && fs.existsSync(src)) {
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
            const dir = path.join(this.root, "adapters");
            fs.mkdirSync(dir, { recursive: true });
            versioned = path.join(dir, `${baseKey}-${stamp}.gguf`);
            fs.copyFileSync(src, versioned);
          } else {
            onEvent({ type: "log", line: `adapter not found (looked at ${adapterRel || "?"} + results dir)` });
          }
        } catch (e) { onEvent({ type: "log", line: `adapter copy failed: ${e.message}` }); }
      }
      onEvent({
        type: "done",
        ok, exitCode: code, status,
        adapter: versioned ? path.relative(this.root, versioned) : null,
        adapterAbs: versioned,
        adapterMB,
        trainLoss: lastLoss, valLoss: lastVal,
        elapsedSec: Math.round((Date.now() - started) / 1000),
      });
    });
    child.on("error", (e) => { this.running = false; this.child = null; onEvent({ type: "error", message: e.message }); });
    return { pid: child.pid, args };
  }

  stop() {
    if (this.child) { try { this.child.kill("SIGKILL"); } catch { /* */ } }
    this.running = false; this.child = null;
  }

  // List previously trained adapters (versioned), newest first.
  listAdapters() {
    const dir = path.join(this.root, "adapters");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".gguf"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        const baseKey = f.split("-")[0];
        return { file: `adapters/${f}`, abs: path.join(dir, f), baseKey, sizeMB: Number((st.size / 2 ** 20).toFixed(1)), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
}
