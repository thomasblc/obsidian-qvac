// Pure incremental-index diff (no Obsidian imports -> unit-testable headless).
// Given the vault's live files (path -> mtime) and the daemon's manifest (path -> {mtime}),
// compute the delta: upsert new/changed notes, drop notes the manifest has but the vault lost.

export interface DiffResult {
  toUpsert: string[];
  toDrop: string[];
}

export function diffManifest(
  local: Record<string, number>,
  remote: Record<string, { mtime: number }>,
): DiffResult {
  const toUpsert: string[] = [];
  const toDrop: string[] = [];
  for (const p of Object.keys(local)) {
    const r = remote[p];
    if (!r || Math.floor(r.mtime) !== Math.floor(local[p])) toUpsert.push(p);
  }
  for (const p of Object.keys(remote)) if (!(p in local)) toDrop.push(p);
  return { toUpsert, toDrop };
}

// Plan a MARKDOWN index sync, keeping OCR'd images OUT of the text diff. The daemon manifest holds
// both markdown and image entries (`sourceType:"image"`); if images leaked into `diffManifest` they'd
// all land in `toDrop` (they're not in the md-only `local`) and then get skipped on re-embed -> image
// search flip-flops every run (the P0). This splits them and, for a "full" rebuild, re-embeds every
// local note while STILL dropping notes that vanished from the vault (the old `remote={}` never dropped).
export interface IndexPlan { toUpsert: string[]; toDrop: string[]; imgRemote: Record<string, { mtime: number }>; }
export function planTextIndex(
  local: Record<string, number>,
  remoteFull: Record<string, { mtime: number; sourceType?: string }>,
  full: boolean,
): IndexPlan {
  const mdRemote: Record<string, { mtime: number }> = {};
  const imgRemote: Record<string, { mtime: number }> = {};
  for (const [p, meta] of Object.entries(remoteFull || {})) {
    if (meta && meta.sourceType === "image") imgRemote[p] = meta; else mdRemote[p] = meta;
  }
  const d = diffManifest(local, mdRemote);
  return { toUpsert: full ? Object.keys(local) : d.toUpsert, toDrop: d.toDrop, imgRemote };
}
