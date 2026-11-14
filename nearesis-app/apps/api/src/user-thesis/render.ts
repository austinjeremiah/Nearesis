import type { ThesisDocument } from "./generate.ts";

type RenderSection = Pick<ThesisDocument["sections"][number], "id" | "title" | "markdown"> & {
  /** Absent in documents written before references were numbered (their pointers are inline). */
  references?: string[];
};

/** THESIS.md rendered from the document only (no ids of the owning organisation, workspace or user). */
export function renderThesisMarkdown(o: {
  title: string;
  doc: Pick<ThesisDocument, "version" | "generatedAt" | "origin"> & { sections: RenderSection[] };
}): string {
  const { doc } = o;
  const head = [
    `# THESIS: ${o.title.replace(/\s+/g, " ").trim()}`,
    `Version ${doc.version}; generated from stored results only (frozen at ${doc.generatedAt}). Capsule ${String(doc.origin.capsuleId)}.`,
  ];
  return `${[
    ...head,
    ...doc.sections.map((s) => {
      const refs = s.references ?? [];
      const list = refs.length ? `\n\nReferences\n\n${refs.map((r, i) => `${i + 1}. ${r}`).join("\n")}` : "";
      return `## ${s.title}\n\n${s.markdown}${list}`;
    }),
  ].join("\n\n")}\n`;
}
