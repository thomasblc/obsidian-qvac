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
