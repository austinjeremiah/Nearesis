import type { Registry } from "./types.ts";

/** Deterministic METRICS.md from the registry: sorted by id, no timestamps. */
export function generateMetricsMd(r: Registry): string {
  const L: string[] = [];
  L.push("# Certified metrics", "");
  L.push(
    "<!-- GENERATED from services/analytics/registry by `pnpm --filter @nearesis/analytics metrics:doc`. Do not edit by hand. -->",
    "",
  );
  L.push(
    `- Semantic version: \`${r.semanticVersion}\``,
    `- Content hash: \`${r.contentHash}\``,
    `- Metrics: ${r.metrics.length} (${r.metrics.filter((m) => m.certified).length} certified)`,
    "",
  );
  L.push("| Metric | Unit | Kind | Aggregation | Visibility | Certified |", "|---|---|---|---|---|---|");
  const ms = [...r.metrics].sort((a, b) => a.id.localeCompare(b.id));
  for (const m of ms)
    L.push(
      `| [\`${m.id}\`](#${m.id.replace(/[^a-z0-9_]/g, "")}) | ${m.unit} | ${m.kind} | ${m.aggregationLaw} | ${m.visibility} | ${m.certified ? m.certifiedVersion : "no (unverified)"} |`,
    );
  L.push("");
  for (const m of ms) {
    L.push(`<a id="${m.id.replace(/[^a-z0-9_]/g, "")}"></a>`, `## ${m.id}`, "", `**${m.displayName}**`, "");
    const f = (k: string, v: unknown) =>
      L.push(
        `- ${k}: ${v === null || v === "" ? "n/a" : Array.isArray(v) ? (v.length ? v.map((x) => `\`${x}\``).join(", ") : "none") : String(v)}`,
      );
    f("Kind", m.kind);
    f("Unit", m.unit);
    f("Grain", m.grain);
    f("Aggregation law", m.aggregationLaw);
    f("Denominator", m.denominator);
    f("Zero policy", m.zeroPolicy);
    f("Sources", m.sources);
    f("Transformations", m.transformations);
    f("Expected update lag", m.expectedUpdateLag);
    f("Bot-proxy definition", m.botProxyDefinition);
    f("Visibility", m.visibility);
    f("Segment overlap", m.segmentOverlap);
    f(
      "Certified version",
      m.certified ? m.certifiedVersion : `${m.certifiedVersion} (not certified: unverified)`,
    );
    f("Owner", m.owner);
    f("Doc URI", m.docUri);
    f("Test fixture", m.testFixture);
    f("Uncertainty", m.uncertainty);
    f("Cube member", m.cubeMember);
    if (r.exactScales[m.id] !== undefined) f("Exact decimal scale", r.exactScales[m.id]);
    L.push("");
  }
  return `${L.join("\n")}\n`;
}
