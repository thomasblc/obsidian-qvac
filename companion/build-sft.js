// Records -> SFT JSONL (HF chat format, one {"messages":[...]} object per line).
// The OWNER's lines become the assistant role, everyone else's the user role, so with
// assistantLossOnly:true the model learns to produce the owner's replies only (recipe
// hard rule 5: model the owner, never a third party).
import fs from "node:fs";
import path from "node:path";

// Rough token estimate for budget trimming: ~3 chars per token in French chat, plus the
// chat-template overhead per message. The trainer SKIPS samples over its contextLength,
// so every row must fit the budget or it silently never trains.
const estTokens = (messages) => messages.reduce((s, m) => s + Math.ceil(m.content.length / 3) + 10, 0);

// records: [{ author, text, ts? }] in conversation order, one conversation per array.
// Returns rows: [{ messages: [{role, content}, ...] }]
export function buildSftRows(conversations, { owner, systemPrompt, maxContextTurns = 6, minOwnerChars = 2, maxChars = 1200, tokenBudget = 440 } = {}) {
  if (!owner) throw new Error("owner name required");
  const rows = [];
  for (const records of conversations) {
    // 1. merge consecutive messages from the same author into one turn
    const turns = [];
    for (const r of records) {
      const text = String(r.text || "").trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && last.author === r.author) last.text += "\n" + text;
      else turns.push({ author: r.author, text });
    }
    // 2. every owner turn that has at least one preceding other-party turn becomes a row:
    //    context = up to maxContextTurns preceding turns, target = the owner turn
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.author !== owner) continue;
      if (t.text.length < minOwnerChars || t.text.length > maxChars) continue;
      const ctx = [];
      for (let j = Math.max(0, i - maxContextTurns); j < i; j++) {
        const c = turns[j];
        if (c.text.length > maxChars) continue;
        ctx.push({ role: c.author === owner ? "assistant" : "user", content: c.text });
      }
      // a usable SFT row needs the immediately preceding turn to be the other party
      if (!ctx.length || ctx[ctx.length - 1].role !== "user") continue;
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push(...ctx, { role: "assistant", content: t.text });
      // trim oldest context turns until the row fits the token budget; the last user turn
      // plus the target must remain (else drop the row entirely)
      while (estTokens(messages) > tokenBudget && messages.length > (systemPrompt ? 3 : 2)) messages.splice(systemPrompt ? 1 : 0, 1);
      if (estTokens(messages) > tokenBudget) continue;
      if (messages[messages.length - 2].role !== "user") continue;
      rows.push({ messages });
    }
  }
  return rows;
}

// Seeded shuffle (mulberry32): chronological chat data made the training loss climb and
// diverge; shuffling decorrelates eras. Seeded so re-runs produce the identical dataset.
export function seededShuffle(rows, seed = 42) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// Deterministic split so re-runs are stable: every Nth row goes to eval.
export function splitTrainEval(rows, evalFraction = 0.1) {
  const every = Math.max(2, Math.round(1 / evalFraction));
  const train = [], evals = [];
  rows.forEach((r, i) => ((i + 1) % every === 0 ? evals : train).push(r));
  return { train, evals };
}

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows.length;
}
