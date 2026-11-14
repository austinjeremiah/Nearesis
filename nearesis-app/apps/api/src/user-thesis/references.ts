/**
 * Moves provenance pointers out of the prose. The generator writes every number with `[file#pointer]` tags (the grounding
 * scan reads exactly those). This turns the tags of one section into numbered markers `[1]`, `[2]` and returns the list of
 * exact pointers in marker order, so THESIS.md stays readable and the JSON document keeps every exact pointer.
 */
const TAG = /\[([^[\]\s|]+#[^[\]\s|]*)\]/g;

export function numberReferences(markdown: string): { markdown: string; references: string[] } {
  const refs: string[] = [];
  const indexOf = (r: string): number => {
    let i = refs.indexOf(r);
    if (i < 0) {
      refs.push(r);
      i = refs.length - 1;
    }
    return i + 1;
  };
  let fence = false;
  const lines = markdown.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    const found = [...line.matchAll(TAG)].map((m) => m[1]!);
    if (!found.length) return line;
    const markers = [...new Set(found)].map((r) => `[${indexOf(r)}]`).join("");
    const bare = line.replace(TAG, "").replace(/\s+$/g, "").replace(/ {2,}/g, " ");
    return bare.endsWith("|") ? `${bare.slice(0, -1).trimEnd()} ${markers} |` : `${bare} ${markers}`;
  });
  return { markdown: lines.join("\n"), references: refs };
}
