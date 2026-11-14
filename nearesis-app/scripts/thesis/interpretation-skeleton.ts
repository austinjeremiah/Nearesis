/**
 * Writes thesis/interpretation.md as an EMPTY skeleton (section ids and, per section, the pointers its computed text uses) when
 * the file does not exist. Run after `pnpm thesis:build`: `pnpm exec tsx scripts/thesis/interpretation-skeleton.ts`.
 * The author writes prose under each `## <section-id>` heading; every number needs a `[file#pointer]` right after it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THESIS_DIR } from "./inputs.ts";

const dir = DEFAULT_THESIS_DIR;
const out = join(dir, "interpretation.md");
if (existsSync(out)) {
  console.log("interpretation.md exists; not overwritten");
} else {
  const t = JSON.parse(readFileSync(join(dir, "build", "thesis.json"), "utf8")) as {
    sections: { id: string; title: string; markdown: string }[];
  };
  const lines = [
    "<!--",
    "Authored analysis for the reference thesis. One block per section id; a heading with no text is ignored.",
    "Rules: each number is followed on the same line by a pointer in the form [file#pointer] (see build/FACTS.md for every citable",
    "number with its pointer and meaning). Write numbers to three significant digits, in thousands, millions or billions, or as a",
    "percent of a share; the build checks them against the value behind the pointer and fails otherwise. Forward-looking words",
    "(will, forecast, expect) are allowed; causal words (causes, drives, leads to, caused by, driven by) and hype are not.",
    "Blocks appear at the top of their section, labelled Analysis, above the computed lines.",
    "-->",
    "",
  ];
  for (const s of t.sections) {
    const refs = [...new Set([...s.markdown.matchAll(/\[([^[\]\s|]+#[^[\]\s|]+)\]/g)].map((m) => m[1]!))];
    lines.push(
      `## ${s.id}`,
      "",
      `<!-- ${s.title}. Pointers used by the computed text of this section (${refs.length}):`,
    );
    for (const r of refs.slice(0, 40)) lines.push(`  ${r}`);
    if (refs.length > 40) lines.push(`  ... and ${refs.length - 40} more; see build/FACTS.md`);
    lines.push("-->", "");
  }
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log("wrote", out);
}
