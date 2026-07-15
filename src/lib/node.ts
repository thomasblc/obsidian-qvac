// Typed wrappers around the Node built-ins this desktop-only plugin uses. The Obsidian review
// sandbox lints the raw `fs`/`os`/`path`/`crypto` modules as `any` (they are typed by @types/node
// locally, but not in that environment), which produced a wall of no-unsafe-* warnings. Casting the
// modules to explicit minimal signatures once, here, keeps every call site fully type-safe in both.
// Wrapped as arrow functions (not extracted method references) so `this` binding is never an issue.

import * as fsMod from "fs";
import * as osMod from "os";
import * as pathMod from "path";
import * as cryptoMod from "crypto";

interface Hash {
  update(data: string): Hash;
  digest(encoding: string): string;
}

const fs = fsMod as unknown as { readFileSync(path: string, encoding: string): string };
const os = osMod as unknown as { homedir(): string };
const path = pathMod as unknown as { join(...parts: string[]): string };
const crypto = cryptoMod as unknown as { createHash(algorithm: string): Hash };

export const readFileSync = (p: string, encoding: string): string => fs.readFileSync(p, encoding);
export const homedir = (): string => os.homedir();
export const join = (...parts: string[]): string => path.join(...parts);
export const createHash = (algorithm: string): Hash => crypto.createHash(algorithm);

// Read a process env var without tripping unsafe-member-access on an `any`-typed `process`.
export function envVar(name: string): string | undefined {
  return (process as unknown as { env: Record<string, string | undefined> }).env[name];
}
