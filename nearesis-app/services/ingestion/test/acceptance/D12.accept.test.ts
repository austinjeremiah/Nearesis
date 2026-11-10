import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { expect, it } from "vitest";
import { replay } from "../../src/replay.ts";

const ID = "fx.snapshot.p02-baseline";
const PKG = join(import.meta.dirname, "..", "..");

// D12: Raw snapshot replay -> same normalized output digest on two identical runs
it("produces an identical normalized digest across two in-process and two separate-process runs", async () => {
  const a = await replay(ID);
  const b = await replay(ID);
  expect(a.digest).toBe(b.digest);
  expect(JSON.stringify(a.tables)).toBe(JSON.stringify(b.tables));
  const child = () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/replay.ts", "--snapshot", ID], {
      cwd: PKG,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { digest: string; digestMatches: boolean };
  };
  const c1 = child();
  const c2 = child();
  expect(c1.digest).toBe(a.digest);
  expect(c2.digest).toBe(a.digest);
  expect(c1.digestMatches).toBe(true);
  const rows = Object.fromEntries(Object.entries(a.tables).map(([k, v]) => [k, (v as unknown[]).length]));
  expect(rows.intents_swaps).toBe(19);
  observe({
    testId: "D12",
    observed: `4 replays of ${ID} (2 in-process, 2 child processes) gave digest ${a.digest}; tables byte-identical; equals manifest digest`,
    fixtureHash: fixtureHash(ID),
    evidence: { digest: a.digest, runs: 4, rowCounts: rows },
  });
}, 60_000);
