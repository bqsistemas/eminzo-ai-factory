// Markdown helper shared by job.js and the scope parser: the lines of one `## Section`.

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Lines of the markdown section whose heading starts with `title` (any level, case-insensitive,
 * a trailing `:` or text is fine) as `{ text, n }` (n is the 1-based line number), ignoring
 * headings inside code fences and fence markers. An unclosed fence must not hide the heading,
 * so when no heading is found outside fences the search repeats ignoring fences. null: no such section.
 */
export function sectionLines(text, title) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const want = title.toLowerCase();
  for (const honorFences of [true, false]) {
    let fenced = false;
    let level = 0;
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (FENCE.test(raw)) { fenced = !fenced; if (honorFences) continue; }
      const h = honorFences && fenced ? null : raw.match(HEADING);
      if (level) {
        if (h && h[1].length <= level) break;
        if (!(honorFences && fenced) || !HEADING.test(raw)) out.push({ text: raw, n: i + 1 }); // `# ...` inside a fence is a comment, not content
      } else if (h && h[2].toLowerCase().startsWith(want)) {
        level = h[1].length;
      }
    }
    if (level) return out;
  }
  return null;
}
