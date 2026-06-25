// Pure content transform for inserting a wikilink under a "## Related" section.
// Extracted so the corruption edge cases (review-pass P0s) stay regression-tested without Obsidian:
//  - a "## Related" line inside a fenced code block must NOT be treated as the section heading
//  - a "## Related" at start-of-file must be found (no duplicate section appended)
//  - a heading that merely starts with "Related" (e.g. "## Relatedness") must NOT be hijacked
// `link` is the full wikilink string, e.g. "[[Some Note]]".
export function insertRelatedSection(content: string, link: string): string {
  if (content.includes(link)) return content; // exact link already present
  const lines = content.split("\n");
  let inFence = false, headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^## Related[ \t]*$/.test(lines[i])) { headingLine = i; break; }
  }
  if (headingLine >= 0) { lines.splice(headingLine + 1, 0, `- ${link}`); return lines.join("\n"); }
  return content + (content.endsWith("\n") ? "" : "\n") + `\n## Related\n- ${link}\n`;
}
