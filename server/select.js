// Auto-select the vault docs worth training a voice LoRA on.
// The app does this automatically (Thomas's ask): embed every note, score each by
// how central it is to the owner's recurring themes (cosine to the corpus centroid)
// and how dense its local neighborhood is, then drop boilerplate / code / stubs.
// An optional LLM pass refines the top candidates. Everything stays on-device.
import fs from "node:fs";
import path from "node:path";
import { cosine } from "./models.js";

// Strip YAML front-matter and collapse fenced code so we score the PROSE, not the syntax.
function stripForScoring(text) {
  let t = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const codeChars = (t.match(/```[\s\S]*?```/g) || []).join("").length;
  t = t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return { prose: t, codeRatio: text.length ? codeChars / text.length : 0 };
}

// Meta / boilerplate docs (templates, indexes, guides, logs, trackers) are central
// to a corpus by construction, so centrality-based scoring wrongly ranks them top.
// They are NOT the owner's distinctive voice: exclude them from voice candidates.
const META_RE = /(^|\/)(_?template|_?index|_?readme|.*guide|_?tracker|build-log|changelog|todo|memory|second-brain|status|_state|state)\b/i;
export function isMeta(relPath) {
  const base = relPath.split("/").pop().replace(/\.(md|markdown|txt)$/i, "");
  return META_RE.test(relPath) || META_RE.test(base);
}

// Classify a note: prose (good voice), code/data (skip), stub (too short).
export function classify(text) {
  const { prose, codeRatio } = stripForScoring(text);
  const words = prose.split(/\s+/).filter(Boolean).length;
  const looksData = /^\s*[{[]/.test(text.trim()) || /<\/?[a-z][\s\S]*>/i.test(text.slice(0, 200));
  if (words < 40) return { kind: "stub", words, codeRatio };
  if (codeRatio > 0.5 || looksData) return { kind: "code", words, codeRatio };
  return { kind: "prose", words, codeRatio };
}

// Build per-note records with the prose used for embedding + scoring.
// Meta docs are reclassified out of "prose" so they are not training candidates.
export function buildRecords(vault) {
  const recs = [];
  for (const f of vault.list()) {
    let text = "";
    try { text = vault.read(f.path); } catch { continue; }
    let cls = classify(text);
    if (cls.kind === "prose" && isMeta(f.path)) cls = { ...cls, kind: "meta" };
    const { prose } = stripForScoring(text);
    recs.push({ path: f.path, title: f.title, text, prose: prose.trim(), ...cls });
  }
  return recs;
}

// Embedding-based auto-selection. Returns records annotated with score + selected,
// sorted by score. selected = prose notes above the adaptive score threshold.
export async function selectByEmbedding(records, mm, { onProgress, topNeighbors = 5 } = {}) {
  const prose = records.filter((r) => r.kind === "prose" && r.prose.length > 0);
  if (prose.length === 0) return records.map((r) => ({ ...r, score: 0, selected: false }));
  // Embed a representative slice of each note (first ~1500 chars keeps the RPC small).
  const vectors = await mm.embedMany(prose.map((r) => r.prose.slice(0, 1500)), { onProgress });
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) centroid[i] += v[i] / vectors.length;

  const scored = prose.map((r, i) => {
    const central = cosine(vectors[i], centroid);
    const sims = [];
    for (let j = 0; j < vectors.length; j++) if (j !== i) sims.push(cosine(vectors[i], vectors[j]));
    sims.sort((a, b) => b - a);
    const density = sims.slice(0, topNeighbors).reduce((a, b) => a + b, 0) / Math.min(topNeighbors, sims.length || 1);
    // For VOICE we want substantial, thematically-clustered PROSE, not the most
    // "average/generic" doc. So rank by local density (recurring themes) + length,
    // with only a light centrality term (just enough to drop true outliers).
    const lengthNorm = Math.min(1, r.words / 600);
    const score = 0.5 * density + 0.4 * lengthNorm + 0.1 * central;
    return { ...r, vec: vectors[i], score: Number(score.toFixed(4)) };
  });

  // Adaptive threshold: select the above-median half by score, never the bottom.
  // The user overrides on the graph (shift-click).
  const sortedScores = scored.map((s) => s.score).sort((a, b) => a - b);
  const median = sortedScores[Math.floor(sortedScores.length / 2)] || 0;
  const threshold = Math.max(0.4, median);

  const byPath = new Map(scored.map((s) => [s.path, s]));
  const out = records.map((r) => {
    const s = byPath.get(r.path);
    if (!s) return { ...r, score: 0, selected: false };
    return { path: s.path, title: s.title, kind: s.kind, words: s.words, score: s.score, selected: s.score >= threshold };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Optional deeper pass: ask the BASE model whether a candidate is the owner's own
// prose worth learning a voice from. Slow (one completion per doc) so it runs only
// on a capped set of borderline candidates when the user clicks "refine".
export async function refineWithLLM(records, mm, { baseKey = "1.7b", limit = 20 } = {}) {
  const cands = records.filter((r) => r.kind === "prose").slice(0, limit);
  const results = [];
  for (const r of cands) {
    const sample = (r.text || "").slice(0, 1200);
    const history = [
      { role: "system", content: "You judge whether a note is the OWNER'S OWN original writing, worth learning their personal writing voice from. Answer strictly YES or NO on the first line, then a 6-word reason." },
      { role: "user", content: `NOTE:\n${sample}\n\nIs this the owner's own prose (not pasted external text, not a list/config/log)?` },
    ];
    try {
      const { contentText } = await mm.chat(history, { baseKey, reasoningBudget: 0 });
      const yes = /^\s*yes/i.test(contentText || "");
      results.push({ path: r.path, llmKeep: yes, llmReason: (contentText || "").split("\n").slice(0, 2).join(" ").slice(0, 80) });
    } catch (e) {
      results.push({ path: r.path, llmKeep: null, llmReason: "llm error" });
    }
  }
  return results;
}

// Build a Causal training dataset (.txt) from the selected note paths.
// Long-form prose -> raw continuation training (assistantLossOnly:false in the runner).
// Holds out ~10% of notes as eval. Returns counts + the file paths written.
export function buildCausalDataset(vault, selectedPaths, outDir, { evalFraction = 0.1 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const docs = [];
  for (const rel of selectedPaths) {
    let text = "";
    try { text = vault.read(rel); } catch { continue; }
    const { prose } = stripForScoring(text);
    const clean = prose.replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length > 100) docs.push(clean);
  }
  // Deterministic split (no Date/Math.random). With <=2 docs a clean hold-out is
  // impossible, so train on everything and validate on the same set (never strand the
  // only doc in eval, which left train empty and falsely failed the "too little text" check).
  const train = [], evalDocs = [];
  if (docs.length <= 2) {
    train.push(...docs);
  } else {
    const everyN = Math.max(3, Math.round(1 / evalFraction));
    docs.forEach((d, i) => (i % everyN === 0 ? evalDocs : train).push(d));
    if (train.length === 0) { train.push(...evalDocs); evalDocs.length = 0; }
    if (evalDocs.length === 0) evalDocs.push(train[train.length - 1]); // reuse, keep train intact
  }
  const evalOut = evalDocs.length ? evalDocs : train;
  const sep = "\n\n<|doc|>\n\n";
  const trainPath = path.join(outDir, "vault.train.txt");
  const evalPath = path.join(outDir, "vault.eval.txt");
  fs.writeFileSync(trainPath, train.join(sep), "utf8");
  fs.writeFileSync(evalPath, evalOut.join(sep), "utf8");
  return {
    trainPath, evalPath,
    trainDocs: train.length, evalDocs: evalOut.length,
    trainChars: train.join(sep).length,
  };
}
