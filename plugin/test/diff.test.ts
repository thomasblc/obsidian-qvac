// Pure unit test for the incremental-index diff. Run: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert";
import { diffManifest } from "../src/lib/diff.ts";

test("new + changed notes are upserted, missing are dropped", () => {
  const local = { "a.md": 100, "b.md": 200, "c.md": 300 };
  const remote = { "a.md": { mtime: 100 }, "b.md": { mtime: 150 }, "x.md": { mtime: 1 } };
  const { toUpsert, toDrop } = diffManifest(local, remote);
  assert.deepStrictEqual(toUpsert.sort(), ["b.md", "c.md"]); // b changed (200!=150), c is new
  assert.deepStrictEqual(toDrop, ["x.md"]);                  // x gone from the vault
});

test("identical manifests produce no work", () => {
  const local = { "a.md": 100, "b.md": 200 };
  const remote = { "a.md": { mtime: 100 }, "b.md": { mtime: 200 } };
  const { toUpsert, toDrop } = diffManifest(local, remote);
  assert.deepStrictEqual(toUpsert, []);
  assert.deepStrictEqual(toDrop, []);
});

test("empty remote indexes everything", () => {
  const local = { "a.md": 100, "b.md": 200 };
  const { toUpsert, toDrop } = diffManifest(local, {});
  assert.deepStrictEqual(toUpsert.sort(), ["a.md", "b.md"]);
  assert.deepStrictEqual(toDrop, []);
});

test("sub-second mtime jitter does not retrigger (floor compare)", () => {
  const local = { "a.md": 100.9 };
  const remote = { "a.md": { mtime: 100.1 } };
  assert.deepStrictEqual(diffManifest(local, remote).toUpsert, []);
});
