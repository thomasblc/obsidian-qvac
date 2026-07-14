// Vault file layer for Second Self.
// A "vault" is a folder of markdown files. Everything here is
// local file I/O, sandboxed to the vault root: no path may escape it (security).
// The agent never reads message content for display; this module reads files the
// USER points the app at, on the user's own machine. Nothing leaves the device.
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", "train", ".DS_Store"]);
const MD_EXT = new Set([".md", ".markdown", ".txt"]);

export class Vault {
  constructor(root) {
    this.setRoot(root);
  }

  setRoot(root) {
    const abs = path.resolve(root);
    const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (!st || !st.isDirectory()) throw new Error(`vault root is not a directory: ${abs}`);
    this.root = abs;
    this.rootReal = fs.realpathSync(abs); // for symlink-escape confinement
    return this.root;
  }

  // Resolve a vault-relative path and refuse anything that escapes the root, INCLUDING
  // via symlinks: a string-only check passes for a symlink inside the vault that points
  // outside, so we realpath the deepest existing ancestor and re-check against realpath(root).
  _resolve(rel) {
    const p = path.resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes vault root: ${rel}`);
    }
    // realpath the existing portion (the target may not exist yet, e.g. on write/create).
    let existing = p; const tail = [];
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      tail.unshift(path.basename(existing)); existing = path.dirname(existing);
    }
    let realExisting; try { realExisting = fs.realpathSync(existing); } catch { realExisting = existing; }
    const full = tail.length ? path.join(realExisting, ...tail) : realExisting;
    const rootReal = this.rootReal || this.root;
    if (full !== rootReal && !full.startsWith(rootReal + path.sep)) {
      throw new Error(`path escapes vault root (symlink): ${rel}`);
    }
    return full;
  }

  // Recursively list markdown files as vault-relative records.
  list() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isSymbolicLink()) continue; // never follow symlinks out of the vault
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          walk(full);
        } else if (MD_EXT.has(path.extname(e.name).toLowerCase())) {
          let st; try { st = fs.statSync(full); } catch { continue; }
          const rel = path.relative(this.root, full);
          out.push({
            path: rel,
            name: e.name,
            title: this._titleOf(full, e.name),
            dir: path.dirname(rel) === "." ? "" : path.dirname(rel),
            size: st.size,
            mtime: st.mtimeMs,
          });
        }
      }
    };
    walk(this.root);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  // Title = first markdown H1, else the filename without extension.
  _titleOf(full, name) {
    try {
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const head = buf.toString("utf8", 0, n);
      const m = head.match(/^#\s+(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* fall through */ }
    return name.replace(/\.(md|markdown|txt)$/i, "");
  }

  read(rel) {
    return fs.readFileSync(this._resolve(rel), "utf8");
  }

  write(rel, content) {
    const p = this._resolve(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return { path: rel, size: Buffer.byteLength(content, "utf8") };
  }

  create(rel, content = "") {
    const p = this._resolve(rel);
    if (fs.existsSync(p)) throw new Error(`already exists: ${rel}`);
    return this.write(rel, content);
  }

  rename(fromRel, toRel) {
    const from = this._resolve(fromRel);
    const to = this._resolve(toRel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { from: fromRel, to: toRel };
  }

  remove(rel) {
    fs.unlinkSync(this._resolve(rel));
    return { path: rel };
  }

  // Full-text search: score by title hits (heavy) + body hits, return ranked snippets.
  search(query, limit = 50) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (const f of this.list()) {
      let body = "";
      try { body = fs.readFileSync(this._resolve(f.path), "utf8"); } catch { continue; }
      const lc = body.toLowerCase();
      const titleLc = f.title.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const inTitle = titleLc.includes(t) ? 5 : 0;
        const inPath = f.path.toLowerCase().includes(t) ? 3 : 0;
        const bodyHits = lc.split(t).length - 1;
        score += inTitle + inPath + Math.min(bodyHits, 20);
      }
      if (score > 0) {
        results.push({ ...f, score, snippet: this._snippet(body, terms[0]) });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  _snippet(body, term) {
    const lc = body.toLowerCase();
    let i = term ? lc.indexOf(term) : -1;
    if (i < 0) i = 0;
    const start = Math.max(0, i - 60);
    const end = Math.min(body.length, i + 120);
    return (start > 0 ? "..." : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "..." : "");
  }

  // Parse outbound links from one note: [[wikilinks]] and [text](path.md).
  parseLinks(content) {
    const links = new Set();
    for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      links.add(m[1].trim());
    }
    for (const m of content.matchAll(/\]\(([^)]+\.(?:md|markdown|txt))(?:#[^)]*)?\)/gi)) {
      if (!/^https?:/i.test(m[1])) links.add(m[1].trim());
    }
    return [...links];
  }

  // Extract #tags (excluding code fences / headings handled loosely).
  parseTags(content) {
    const tags = new Set();
    for (const m of content.matchAll(/(?:^|\s)#([a-zA-Z][\w\/-]+)/g)) tags.add(m[1].toLowerCase());
    return [...tags];
  }
}
