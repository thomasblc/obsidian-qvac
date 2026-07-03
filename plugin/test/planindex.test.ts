// Regression for the Wave-0 P0: OCR'd images must NOT be dropped by the markdown index diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTextIndex } from "../src/lib/diff.ts";

test("P0: images (sourceType:image) are kept out of the text drop set", () => {
  const local = { "a.md": 100 };                                // vault has one markdown note
  const remoteFull = {
    "a.md": { mtime: 100 },
    "pic.png": { mtime: 50, sourceType: "image" },              // an OCR'd image lives in the index
  };
  const plan = planTextIndex(local, remoteFull, false);
  assert.deepStrictEqual(plan.toUpsert, []);                    // md unchanged
  assert.deepStrictEqual(plan.toDrop, []);                      // image is NOT dropped by the text diff
  assert.deepStrictEqual(Object.keys(plan.imgRemote), ["pic.png"]); // handed to the OCR loop instead
});

test("markdown deletions still drop; incremental upserts changed/new", () => {
  const local = { "a.md": 200, "new.md": 300 };
  const remoteFull = {
    "a.md": { mtime: 100 },                                     // changed
    "gone.md": { mtime: 100 },                                  // deleted from the vault
    "img.jpg": { mtime: 9, sourceType: "image" },
  };
  const plan = planTextIndex(local, remoteFull, false);
  assert.deepStrictEqual(plan.toUpsert.sort(), ["a.md", "new.md"]);
  assert.deepStrictEqual(plan.toDrop, ["gone.md"]);             // md deletion dropped, image untouched
});

test("full rebuild re-embeds every note AND still drops vanished notes (not remote={})", () => {
  const local = { "a.md": 100, "b.md": 200 };
  const remoteFull = { "a.md": { mtime: 100 }, "b.md": { mtime: 200 }, "dead.md": { mtime: 1 } };
  const plan = planTextIndex(local, remoteFull, true);
  assert.deepStrictEqual(plan.toUpsert.sort(), ["a.md", "b.md"]); // ALL local re-embedded
  assert.deepStrictEqual(plan.toDrop, ["dead.md"]);              // deleted note still dropped on "full"
});
