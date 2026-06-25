import { test } from "node:test";
import assert from "node:assert/strict";
import { insertRelatedSection } from "../src/lib/links.ts";

test("P0: a ## Related inside a code fence is not hijacked (no corruption)", () => {
  const fence = "# Note\n```md\n## Related\n- [[Example]]\n```\n";
  const r = insertRelatedSection(fence, "[[Foo]]");
  assert.ok(r.includes("```md\n## Related\n- [[Example]]\n```"), "fenced block untouched");
  assert.match(r, /\n## Related\n- \[\[Foo\]\]\n$/, "fresh section appended outside the fence");
});

test("P0: ## Related at start-of-file is matched (no duplicate section)", () => {
  const r = insertRelatedSection("## Related\n- [[Bar]]\n", "[[Foo]]");
  assert.equal((r.match(/## Related/g) || []).length, 1);
  assert.ok(r.includes("- [[Foo]]") && r.includes("- [[Bar]]"));
});

test("P0: a heading that only starts with 'Related' is not hijacked", () => {
  const r = insertRelatedSection("## Relatedness of things\nsome body\n", "[[Foo]]");
  assert.ok(r.startsWith("## Relatedness of things\nsome body\n"));
  assert.ok(r.includes("\n## Related\n- [[Foo]]"));
});

test("inserts under an existing real ## Related section", () => {
  const r = insertRelatedSection("# Note\nbody\n\n## Related\n- [[Bar]]\n", "[[Foo]]");
  assert.match(r, /## Related\n- \[\[Foo\]\]\n- \[\[Bar\]\]/);
});

test("exact link already present -> unchanged", () => {
  assert.equal(insertRelatedSection("x [[Foo]] y", "[[Foo]]"), "x [[Foo]] y");
});

test("plain note -> appends a new section", () => {
  assert.equal(insertRelatedSection("# Note\nbody", "[[Foo]]"), "# Note\nbody\n\n## Related\n- [[Foo]]\n");
});
