import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Acceptance observation helper. An acceptance test (`*.accept.test.ts`) calls `observe()` once with what it actually
 * measured. `pnpm accept --id X` sets NEARESIS_ACCEPT_OUT, runs the bound test files and turns the observation + exit
 * code into a ch.16 TestResult. A test that cannot reach a live dependency calls `observe({ blocked: "<reason>" ... })`.
 */
export interface Observation {
  testId: string;
  observed: string;
  fixtureHash?: string | null;
  evidence?: Record<string, unknown>;
  blocked?: string;
}

export function observe(o: Observation): void {
  const dir = process.env.NEARESIS_ACCEPT_OUT;
  if (!dir) return; // plain `vitest run` outside the runner
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${o.testId}.observation.json`), JSON.stringify(o, null, 2));
}
