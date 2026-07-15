// Stable per-vault id = short sha1 of the vault's absolute root path (matches the daemon).
import { createHash } from "./node";

export function vaultId(absRootPath: string): string {
  return createHash("sha1").update(absRootPath).digest("hex").slice(0, 16);
}
