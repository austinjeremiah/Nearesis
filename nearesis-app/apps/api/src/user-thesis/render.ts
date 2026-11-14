import type { ThesisDocument } from "./generate.ts";

/** THESIS.md rendered from the document only (no ids of the owning organisation, workspace or user). */
export function renderThesisMarkdown(o: {
  title: string;
  doc: Pick<ThesisDocument, "version" | "generatedAt" | "sections" | "origin">;
}): string {
  const { doc } = o;
  const head = [
    `# THESIS: ${o.title.replace(/\s+/g, " ").trim()}`,
    `Version ${doc.version}; generated from stored results only (frozen at ${doc.generatedAt}). Capsule ${String(doc.origin.capsuleId)}.`,
  ];
  return `${[...head, ...doc.sections.map((s) => `## ${s.title}\n\n${s.markdown}`)].join("\n\n")}\n`;
}
