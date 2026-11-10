/** Release report writer for the milestone demonstration. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, RELEASES, type Recorder } from "./common.ts";

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: APP_ROOT, encoding: "utf8" }).stdout.trim();

export function writeReport(a: {
  rec: Recorder;
  runId: string;
  startedAt: string;
  finished: string;
  commit: string;
  ctx: { orgId?: string; workspaceId?: string; runIdAgent?: string; queryHash?: string };
}): string {
  const { rec } = a;
  const rows = rec.results
    .map((r) => {
      const ev = r.evidence.map((e) => `[${e}](MILESTONE-${a.runId}/${e})`).join(", ") || "none";
      const note = r.status === "BLOCKED" ? ` Owner: ${r.owner}.` : "";
      return `| ${r.n} | ${r.name} | ${r.status} | ${r.mode} | ${(r.ms / 1000).toFixed(1)} s | ${ev} | ${r.detail.replace(/\|/g, "/")}${note} |`;
    })
    .join("\n");
  const count = (s: string) => rec.results.filter((r) => r.status === s).length;
  let gates = "not available";
  try {
    const g = JSON.parse(readFileSync(join(rec.dir, "step17-gates.json"), "utf8")) as {
      source: string;
      summary: Record<string, Record<string, number>>;
      nonPass: string[];
    };
    gates =
      `Source: ${g.source}.\n\n| Gate | Total | PASS | FAIL | BLOCKED_DEPENDENCY | NOT_RUN |\n|---|---|---|---|---|---|\n` +
      Object.entries(g.summary)
        .map(
          ([k, s]) =>
            `| ${k} | ${s.total} | ${s.PASS} | ${s.FAIL} | ${s.BLOCKED_DEPENDENCY} | ${s.NOT_RUN} |`,
        )
        .join("\n") +
      (g.nonPass.length ? `\n\nNon-PASS tests: ${g.nonPass.join(", ")}.` : "");
  } catch {
    /* step 17 has not run yet */
  }
  const md = `# Milestone demonstration (P00-P05), run ${a.runId}

Result: **${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED** of ${rec.results.length} recorded steps.
Command: \`pnpm demo:milestone\` (flags: \`--no-web\`, \`--keep\`, \`--run-gates\`). Started ${a.startedAt}, finished ${a.finished}.
Commit: \`${a.commit}\` (working tree may contain other agents' uncommitted work; the demo only reads it).

Per-run isolation: org \`${a.ctx.orgId ?? "n/a"}\`, workspace \`${a.ctx.workspaceId ?? "n/a"}\` are created fresh each run. Agent run ID: ${a.ctx.runIdAgent ?? "none (step 7 not delivered)"}. Semantic query hash: ${a.ctx.queryHash ?? "n/a"}.

Mode labels: **fixture-backed** = data comes from the sealed \`fx.snapshot.p02-baseline\` replay (no network). **live** = real services (kernel API, Postgres, web app, and, once delivered, live OpenRouter inference under the shared USD 5 ledger). No step is simulated: a step whose dependency has not shipped is BLOCKED with its owner and a matching OPEN entry in \`coordination/INTEGRATION_QUEUE.md\`.

## Steps

| # | Step | Status | Mode | Time | Evidence | Detail |
|---|---|---|---|---|---|---|
${rows}

## Gate status (step 17)

${gates}

## Environment and versions

- Node ${process.version}, pnpm ${run("pnpm", ["-v"])}, ${process.platform}-${process.arch}
- Docker services: ${run("docker", ["ps", "--format", "{{.Names}}={{.Status}}", "--filter", "name=nearesis"]).split("\n").join("; ")}
- Inference provider configured: ${process.env.INFERENCE_PROVIDER ?? "unset"} (not exercised until step 7 is delivered)

## Known limitations

- Steps marked BLOCKED depend on the questions/runs API (A7), the production runtime worker and composer wiring (A6) and the composer/canvas UI (A9). Re-run \`pnpm demo:milestone\` when their integration-ready entries land; the harness probes the endpoint and reports honestly.
- Step 1 starts no worker: no production worker entry exists yet (the workflow worker entry is a test harness). Worker start and the SIGKILL recovery belong to steps 8 and 16.
- Step 17 summarises the latest recorded acceptance evidence by default; pass \`--run-gates\` to execute \`pnpm accept\` for every G00-G05 test (long, writes evidence into the shared reports tree).
- Steps 5-6 load the shared ClickHouse \`nearesis\` database under the shared \`semantic:testlock\`, so other Cube-backed suites are serialized with the demo.

## Links

- Phase reports: \`reports/PHASE-00\` .. \`reports/PHASE-05\`; test evidence \`reports/TESTS/<ID>\`; logs in \`MILESTONE-${a.runId}/logs\`.
`;
  const out = join(RELEASES, `MILESTONE-P00-P05-${a.runId}.md`);
  writeFileSync(out, md);
  return out;
}
