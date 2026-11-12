import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { CapsuleManifest } from "@nearesis/contracts";
import { PublicationBlockedError, buildCapsule } from "./build.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.ts";
import { renderMemoPdf } from "./memo.ts";
import type { MemoInput } from "./memo.ts";
import { checkPublication } from "./publication.ts";
import { LIVE_SNAPSHOT_FILE, liveExecutions, liveQueriesDocument, parseLiveSnapshot } from "./live.ts";
import { loadSnapshot } from "./snapshot.ts";
import { treeHashOf } from "./tree.ts";

/**
 * Publication bundle (ch.02 "Required thesis deliverables", V16). Each build is a NEW version directory named from the
 * capsule hash; an existing version directory is never rewritten.
 *
 * Layout: sql/*.sql, sources/*.json, snapshot-manifest.json, DATA.md, METRICS.md, THESIS.md, PREREGISTRATION.md,
 * EXPERIMENTS.md, LIMITATIONS.md, MEMO.pdf, dist/index.html, research-capsules/*.tar.zst, HASHES.json.
 */
export const DELIVERABLES: Array<{ name: string; test: (paths: string[]) => boolean }> = [
  { name: "sql/*.sql", test: (p) => p.some((x) => /^sql\/[^/]+\.sql$/.test(x)) },
  { name: "sources/*.json", test: (p) => p.some((x) => /^sources\/[^/]+\.json$/.test(x)) },
  { name: "snapshot-manifest.json", test: (p) => p.includes("snapshot-manifest.json") },
  { name: "DATA.md", test: (p) => p.includes("DATA.md") },
  { name: "METRICS.md", test: (p) => p.includes("METRICS.md") },
  { name: "THESIS.md", test: (p) => p.includes("THESIS.md") },
  { name: "PREREGISTRATION.md", test: (p) => p.includes("PREREGISTRATION.md") },
  { name: "EXPERIMENTS.md", test: (p) => p.includes("EXPERIMENTS.md") },
  { name: "LIMITATIONS.md", test: (p) => p.includes("LIMITATIONS.md") },
  { name: "MEMO.pdf", test: (p) => p.includes("MEMO.pdf") },
  { name: "dist/index.html", test: (p) => p.includes("dist/index.html") },
  {
    name: "research-capsules/*.tar.zst",
    test: (p) => p.some((x) => /^research-capsules\/[^/]+\.tar\.zst$/.test(x)),
  },
];

export const BLOCK_DATE_PREDICATE = /\bblock_date\b\s*(?:BETWEEN|>=|<=|=|IN\b)/i;

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
    });
}

export function checkBundleInventory(dir: string): { missing: string[]; sqlWithoutBlockDate: string[] } {
  const files = listFiles(dir).filter((f) => statSync(join(dir, f)).size > 0);
  const missing = DELIVERABLES.filter((d) => !d.test(files)).map((d) => d.name);
  const sqlWithoutBlockDate = files
    .filter((f) => /^sql\/.+\.sql$/.test(f))
    .filter((f) => !BLOCK_DATE_PREDICATE.test(readFileSync(join(dir, f), "utf8")));
  return { missing, sqlWithoutBlockDate };
}

export interface BundleHashes {
  version: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  bundleHash: string;
}

export function verifyBundleHashes(dir: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let h: BundleHashes;
  try {
    h = JSON.parse(readFileSync(join(dir, "HASHES.json"), "utf8")) as BundleHashes;
  } catch {
    return { ok: false, problems: ["HASHES.json unreadable"] };
  }
  const actual = listFiles(dir).filter((f) => f !== "HASHES.json");
  for (const f of h.files) {
    try {
      const b = readFileSync(join(dir, f.path));
      if (sha256Hex(b) !== f.sha256 || b.length !== f.bytes) problems.push(`hash mismatch: ${f.path}`);
    } catch {
      problems.push(`missing: ${f.path}`);
    }
  }
  for (const a of actual) if (!h.files.some((f) => f.path === a)) problems.push(`unlisted: ${a}`);
  if (canonicalSha256(h.files) !== h.bundleHash) problems.push("bundleHash does not match the file table");
  return { ok: problems.length === 0, problems };
}

export function listVersions(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((n) => /^v-[0-9a-f]{12}$/.test(n))
      .sort();
  } catch {
    return [];
  }
}

// ---- deterministic tar + zstd (no host tar: sorted names, mtime 0, owner 0) ----
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
export function tarZstOf(dir: string): Buffer {
  const parts: Buffer[] = [];
  for (const f of listFiles(dir)) {
    const data = readFileSync(join(dir, f));
    if (Buffer.byteLength(f) > 99) throw new Error(`tar: path too long: ${f}`);
    parts.push(tarHeader(f, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zstdCompressSync(Buffer.concat(parts));
}

// ---- build ----
export interface BundleOptions {
  snapshotDir: string;
  researchBundleDir?: string;
  /** Versions are created under this directory, one per capsule hash. */
  root: string;
}
export interface BundleResult {
  dir: string;
  version: string;
  capsuleHash: string;
  created: boolean;
  memo: MemoInput;
  /** The capsule manifest this bundle was built from (results, snapshot, hashes): the publish manifest's lineage source. */
  manifest: CapsuleManifest;
}

const write = (root: string, rel: string, data: string | Buffer): void => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const fenced = (lines: string[]): string => ["```", ...lines, "```"].join("\n");
const num = (v: unknown): string => String(v);

export function buildPublicationBundle(o: BundleOptions): BundleResult {
  const work = mkdtempSync(join(tmpdir(), "bundle-"));
  try {
    const capDir = join(work, "capsule");
    const m = buildCapsule({
      snapshotDir: o.snapshotDir,
      outDir: capDir,
      ...(o.researchBundleDir ? { researchBundleDir: o.researchBundleDir } : {}),
    });
    const { descriptor, raw: snapRaw } = loadSnapshot(o.snapshotDir);
    const liveFile = snapRaw.get(LIVE_SNAPSHOT_FILE);
    const live = descriptor.label === "LIVE" && liveFile ? parseLiveSnapshot(liveFile) : null;
    if (descriptor.label === "LIVE" && !live)
      throw new Error("a LIVE snapshot must carry its executed queries (raw/live-snapshot.json)");
    const version = `v-${m.capsuleHash.slice(0, 12)}`;
    const target = join(o.root, version);
    const research = o.researchBundleDir
      ? (JSON.parse(readFileSync(join(o.researchBundleDir, "research_run.json"), "utf8")) as Record<
          string,
          unknown
        >)
      : null;
    const out = join(work, "bundle");
    const r = (id: string): string | undefined => m.results.find((x) => x.id === id)?.value;
    const cite = (...ids: string[]): string => ids.map((i) => `[R:${i}]`).join("");

    // sql: documented query definitions with block_date partition filters (not executed for a frozen fixture)
    const synthetic =
      descriptor.label === "SYNTHETIC"
        ? "-- SYNTHETIC fixture: this documents the live query definition; it was not executed against production data.\n"
        : "";
    const sql: Record<string, string> = {
      "q-series-daily": `${synthetic}-- Daily series behind chart one. Parameterised UTC dates; partition filter on block_date.\nSELECT block_date, SUM(amount_usd) AS intents_volume_usd, COUNT(DISTINCT signer_id) AS active_signers\nFROM \`near_public.intents_daily\`\nWHERE block_date BETWEEN @from_date AND @to_date\nGROUP BY block_date\nORDER BY block_date;\n`,
      "q-research-primary": `${synthetic}-- Daily organic actions used by the primary forecast comparison (chart two).\nSELECT block_date, COUNT(*) AS organic_actions\nFROM \`near_public.actions\`\nWHERE block_date BETWEEN @from_date AND @to_date\n  AND signer_id NOT IN UNNEST(@intents_generated_accounts)\nGROUP BY block_date\nORDER BY block_date;\n`,
      "q-lag-correlation": `${synthetic}-- Aligned daily pairs for the lag correlation (chart three).\nSELECT a.block_date, a.intents_volume_usd, b.active_signers\nFROM \`near_public.intents_daily\` AS a\nJOIN \`near_public.intents_daily\` AS b ON b.block_date = DATE_ADD(a.block_date, INTERVAL @lag_days DAY)\nWHERE a.block_date BETWEEN @from_date AND @to_date\nORDER BY a.block_date;\n`,
    };
    if (live) {
      // LIVE: only queries that were executed. Each file is the executed text with its parameters and result hash.
      for (const q of liveExecutions(live))
        write(
          out,
          `sql/${q.queryId}.sql`,
          `-- EXECUTED against ${q.database} at snapshot freeze ${live.frozenAt}; snapshot ${live.snapshotId}.\n-- Parameters: s=${q.params.s}, e=${q.params.e} (UTC dates, inclusive).\n-- Result: ${q.resultFile}, ${q.rows} rows, sha256 ${q.resultSha256}.\n${q.sql};\n`,
        );
    } else for (const [id, text] of Object.entries(sql)) write(out, `sql/${id}.sql`, text);

    write(
      out,
      "sources/snapshot.json",
      `${JSON.stringify({ snapshotId: descriptor.snapshotId, label: descriptor.label, dataset: descriptor.dataset, frozenAt: descriptor.frozenAt, files: descriptor.files, retrieval: live ? `live read from ${live.database} at freeze ${live.frozenAt}; executed queries in sources/queries.json` : "frozen fixture; no live retrieval", dataHash: m.snapshot.dataHash }, null, 2)}\n`,
    );
    if (live) write(out, "sources/queries.json", liveQueriesDocument(live));
    write(out, "snapshot-manifest.json", readFileSync(join(capDir, "snapshot", "snapshot.json")));
    for (const [from, to] of [
      ["THESIS.md", "THESIS.md"],
      ["DATA.md", "DATA.md"],
      ["LIMITATIONS.md", "LIMITATIONS.md"],
    ] as const)
      write(out, to, readFileSync(join(capDir, "exports", from)));
    write(out, "dist/index.html", readFileSync(join(capDir, "exports", "site", "index.html")));

    write(
      out,
      "METRICS.md",
      `${[
        "# Metrics",
        "",
        "| Result | Value | Unit | Citation |",
        "| --- | --- | --- | --- |",
        ...m.results.map((x) => `| ${x.label} | ${x.value} | ${x.unit ?? ""} | ${cite(x.id)} |`),
        "",
        "## Computations",
        "",
        fenced(m.results.map((x) => `${x.id}: ${x.computation}`)),
      ].join("\n")}\n`,
    );
    const pre = research?.preregistration as Record<string, unknown> | undefined;
    write(
      out,
      "PREREGISTRATION.md",
      `${[
        "# Preregistration",
        "",
        pre
          ? live
            ? `Preregistration hash recorded in the research run: ${num(pre.hash)}. This is a POST-HOC registration: the frozen fixture-evaluation parameters were applied unchanged to this live window; the live-study fields are not frozen, and no chain commitment exists for this preregistration document in this capsule.`
            : `Preregistration hash recorded in the research run: ${num(pre.hash)}. No chain commitment was made for this fixture build.`
          : "This build ran no research experiment and has no preregistration.",
        "",
        "## Frozen block",
        "",
        fenced(pre ? JSON.stringify(pre, null, 1).split("\n") : ["none"]),
      ].join("\n")}\n`,
    );
    const verdict = research?.verdict as Record<string, unknown> | undefined;
    write(
      out,
      "EXPERIMENTS.md",
      `${[
        "# Experiments",
        "",
        research
          ? live
            ? `Experiment verdict: ${r("research-status") ?? "unknown"} ${cite("research-status")}, exploratory. Only ${r("research-n-origins")} scored development origins exist against a preregistered minimum of ${r("research-min-origins")} ${cite("research-n-origins", "research-min-origins")}, so the run supports no conclusion. The forecast comparisons are METHOD_NOT_VALIDATED (every candidate nests the baseline) and no statistical significance is claimed.`
            : `Experiment verdict: ${r("research-status") ?? "unknown"} ${cite("research-status")}. ${(Array.isArray(verdict?.reasons) ? (verdict.reasons as string[]) : []).join(" ")}`
          : "No experiment was run for this build.",
        "",
        "## Run summary",
        "",
        fenced(
          research
            ? JSON.stringify(
                {
                  experimentId: research.experimentId,
                  status: research.status,
                  claimScope: research.claimScope,
                  hypothesis: research.hypothesis,
                  uncertainty: research.uncertainty,
                },
                null,
                1,
              ).split("\n")
            : ["none"],
        ),
      ].join("\n")}\n`,
    );

    // memo: three findings, each a number with its interval from result artifacts
    const findings: MemoInput["findings"] = [];
    if (live) {
      // LIVE: direction-neutral, exploratory wording. Numbers are the cited results' values, never rounded or restated.
      if (r("research-delta-mae") && r("research-delta-mae-lo") && r("research-delta-mae-hi"))
        findings.push({
          text: `Exploratory, no conclusion: the change in out-of-sample forecast error from adding lagged Intents volume is ${r("research-delta-mae")} (bootstrap interval ${r("research-delta-mae-lo")} to ${r("research-delta-mae-hi")} log1p units; negative means higher error than the baseline). The interval contains zero and the comparison method is not validated for this nested comparison, so no significance is claimed.`,
          cites: ["research-delta-mae", "research-delta-mae-lo", "research-delta-mae-hi"],
          number: r("research-delta-mae")!,
          range: [r("research-delta-mae-lo")!, r("research-delta-mae-hi")!],
        });
      if (r("research-n-origins") && r("research-min-origins"))
        findings.push({
          text: `The verdict is ${r("research-status")}: ${r("research-n-origins")} scored development origins against a preregistered minimum of ${r("research-min-origins")}. The run is exploratory and post-hoc registered.`,
          cites: ["research-status", "research-n-origins", "research-min-origins"],
          number: r("research-n-origins")!,
          range: [r("research-n-origins")!, r("research-min-origins")!],
        });
      if (r("n"))
        findings.push({
          text: `The aligned live window covers ${r("n")} consecutive days of Intents volume and organic NEAR transactions; the correlations in THESIS.md are descriptive only.`,
          cites: ["n"],
          number: r("n")!,
          range: [r("n")!, r("n")!],
        });
    } else if (r("research-delta-mae") && r("research-delta-mae-lo") && r("research-delta-mae-hi"))
      findings.push({
        text: `Out-of-sample forecast error fell by ${r("research-delta-mae")} (bootstrap interval ${r("research-delta-mae-lo")} to ${r("research-delta-mae-hi")} log1p units) when lagged Intents volume was added.`,
        cites: ["research-delta-mae", "research-delta-mae-lo", "research-delta-mae-hi"],
        number: r("research-delta-mae")!,
        range: [r("research-delta-mae-lo")!, r("research-delta-mae-hi")!],
      });
    const lagIds = m.results.filter((x) => /^lag-\d+-pearson$/.test(x.id)).map((x) => x.id);
    if (!live && r("pearson") && lagIds[0] && /^-?\d/.test(r(lagIds[0]) ?? "")) {
      const a = Number(r("pearson"));
      const b = Number(r(lagIds[0]));
      const [lo, hi] = a <= b ? [r("pearson")!, r(lagIds[0])!] : [r(lagIds[0])!, r("pearson")!];
      findings.push({
        text: `Same-day and lagged correlation between the two series range from ${lo} to ${hi}.`,
        cites: ["pearson", lagIds[0]],
        number: r("pearson")!,
        range: [lo, hi],
      });
    }
    if (!live && r("x-growth") && r("y-growth")) {
      const [lo, hi] =
        Number(r("x-growth")) <= Number(r("y-growth"))
          ? [r("x-growth")!, r("y-growth")!]
          : [r("y-growth")!, r("x-growth")!];
      findings.push({
        text: `From the first to the last day the two series changed by between ${lo}% and ${hi}%.`,
        cites: ["x-growth", "y-growth"],
        number: r("x-growth")!,
        range: [lo, hi],
      });
    }
    if (!live && findings.length < 3 && r("n"))
      findings.push({
        text: `The aligned window covers ${r("n")} days.`,
        cites: ["n"],
        number: r("n")!,
        range: [r("n")!, r("n")!],
      });
    const memo: MemoInput = {
      title: `${descriptor.label === "SYNTHETIC" ? "SYNTHETIC: " : live ? "LIVE, EXPLORATORY (INSUFFICIENT_DATA): " : ""}Research memo: ${descriptor.claimId}`,
      bull: live
        ? "Bull case: if lagged Intents volume does carry information about later organic NEAR activity, a longer pre-regime history would show it as a lower out-of-sample error than the baseline; this run cannot show that."
        : "Bull case: lagged Intents volume carries information about later organic NEAR activity that a plain baseline lacks, and the improvement survives out-of-sample.",
      bear: live
        ? "Bear case: the development sample is below the preregistered minimum, the registration is post-hoc, the comparison method is not validated for nested models, private settlement is unobserved, and the observed error is not lower with Intents volume."
        : "Bear case: the signal is predictive only, the window is short, private settlement after the regime change is unobserved, and a fixture run supports no live claim.",
      falsification: live
        ? "Falsification: the reading fails if a properly registered study with enough origins shows no lower error, or if a validated comparison cannot separate the models; the lockbox holdout is sealed and was not opened."
        : "Falsification: the reading fails if the interval for the improvement includes zero, if the placebo test is not passed, or if a lockbox holdout shows no gain.",
      findings: findings.slice(0, 3),
      charts: live
        ? [
            {
              queryId: "q-swaps",
              queryIds: ["q-swaps", "q-account_daily_activity"],
              title: "Intents volume and organic transactions, indexed",
              alt: `Two indexed lines for ${descriptor.series.x.name} and ${descriptor.series.y.name}`,
              kind: "lines",
            },
            {
              queryId: "q-account_daily_activity",
              queryIds: ["q-account_daily_activity", "q-price", "q-swaps"],
              title: "Primary error change with interval (exploratory)",
              alt: "Point estimate with a 95 percent interval that contains zero",
              kind: "interval",
            },
            {
              queryId: "q-swaps",
              queryIds: ["q-swaps", "q-account_daily_activity"],
              title: "Descriptive correlation by lag",
              alt: "Bars for same-day and lagged correlation",
              kind: "bars",
            },
          ]
        : [
            {
              queryId: "q-series-daily",
              title: "Intents volume and signers, indexed",
              alt: `Two indexed lines for ${descriptor.series.x.name} and ${descriptor.series.y.name}`,
              kind: "lines",
            },
            {
              queryId: "q-research-primary",
              title: "Primary improvement with interval",
              alt: "Point estimate with a 95 percent interval",
              kind: "interval",
            },
            {
              queryId: "q-lag-correlation",
              title: "Correlation by lag",
              alt: "Bars for same-day and lagged correlation",
              kind: "bars",
            },
          ],
      series: [
        { name: descriptor.series.x.name, values: loadSeries(o.snapshotDir, "x") },
        { name: descriptor.series.y.name, values: loadSeries(o.snapshotDir, "y") },
      ],
      interval: research
        ? {
            point: Number(r("research-delta-mae")),
            lo: Number(r("research-delta-mae-lo")),
            hi: Number(r("research-delta-mae-hi")),
          }
        : null,
      bars: [
        { label: "same-day", value: Number(r("pearson") ?? 0) },
        ...lagIds.slice(0, 1).map((id) => ({
          label: id.replace(/-pearson$/, "").replace("lag-", "lag "),
          value: Number(r(id)),
        })),
      ],
    };
    write(out, "MEMO.pdf", renderMemoPdf(memo));

    // publication gate: every number in every markdown deliverable and in the memo text is cited and matches a result
    const memoLines = [
      memo.bull,
      memo.bear,
      memo.falsification,
      ...memo.findings.map((f) => `${f.text} ${f.cites.map((c) => `[R:${c}]`).join("")}`),
    ];
    for (const [file, text] of [
      ["THESIS.md", readFileSync(join(out, "THESIS.md"), "utf8")],
      ["METRICS.md", readFileSync(join(out, "METRICS.md"), "utf8")],
      ["EXPERIMENTS.md", readFileSync(join(out, "EXPERIMENTS.md"), "utf8")],
      ["PREREGISTRATION.md", readFileSync(join(out, "PREREGISTRATION.md"), "utf8")],
      ["MEMO.pdf", memoLines.join("\n")],
    ] as const) {
      const c = checkPublication(text, m.results);
      if (!c.ok) throw new PublicationBlockedError(file, c.violations);
    }

    write(out, `research-capsules/${m.capsuleId}.tar.zst`, tarZstOf(capDir));
    const files = listFiles(out).map((p) => ({
      path: p,
      sha256: sha256Hex(readFileSync(join(out, p))),
      bytes: statSync(join(out, p)).size,
    }));
    const hashes: BundleHashes = { version, files, bundleHash: canonicalSha256(files) };
    write(out, "HASHES.json", `${canonicalJson(hashes)}\n`);

    // a version directory is created once and never rewritten
    mkdirSync(o.root, { recursive: true });
    let created = true;
    try {
      statSync(target);
      created = false;
      const same = JSON.stringify(treeHashOf(out)) === JSON.stringify(treeHashOf(target));
      if (!same) throw new Error(`version ${version} already exists with different content`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      created = true;
    }
    if (created) {
      mkdirSync(target, { recursive: true });
      for (const f of listFiles(out)) write(target, f, readFileSync(join(out, f)));
    }
    return { dir: target, version, capsuleHash: m.capsuleHash, created, memo, manifest: m };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function loadSeries(snapshotDir: string, which: "x" | "y"): number[] {
  const { descriptor, raw } = loadSnapshot(snapshotDir);
  const csv = raw.get(descriptor.series.file)!.toString("utf8").split("\n").filter(Boolean);
  const head = csv[0]!.split(",");
  const i = head.indexOf(descriptor.series[which].column);
  return csv.slice(1).map((l) => Number(l.split(",")[i]));
}
