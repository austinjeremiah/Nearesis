/**
 * Deterministic mock-inference composer harness for PERF06 (no paid call, no network). The "model" is a provider that
 * waits a DECLARED fixed latency and returns a fixed four-panel plan; everything else on the path is real: the near-thesis
 * composer, the kernel tool gateway, the semantic layer (Cube) behind canvas.preview, the approval, the progressive apply
 * and the SSE stream. The cold/warm distinction is made by the plan's query windows: every cold run asks for windows no
 * earlier run asked for (semantic cache miss), a warm run repeats the windows of an earlier cold run (cache hit).
 */
import type { z } from "zod";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";

export const C01_PROMPT = "investigate NEAR Intents activity after the private-settlement change";
const MEASURES = [
  ["Completed 1Click swaps per day", "line", "intents.oneclick_completed_swap_count"],
  ["Private-settlement swaps per day", "bar", "intents.oneclick_private_settlement_swap_count"],
  ["1Click volume (USD) per day", "line", "intents.oneclick_volume_usd"],
  ["1Click completion rate", "line", "intents.oneclick_completion_rate"],
] as const;

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 10); // 2026-11-10, the last fixture day
/** The query window of window variant `v`: 28 days ending `v` days before the end of the fixture data (v = 0..39). */
export const windowFor = (v: number) => ({
  from: new Date(END - (28 + v) * DAY).toISOString().replace(".000Z", "Z"),
  to: new Date(END - v * DAY).toISOString().replace(".000Z", "Z"),
});

/** The prompt carries the window variant as `[window=N]`; the composer passes it through to the provider untouched. */
export const promptFor = (variant: number) => `${C01_PROMPT} [window=${variant}]`;

export class MockComposerProvider implements InferenceProvider {
  readonly id = "mock";
  readonly calls: Array<{ variant: number; startedAt: number; ms: number }> = [];
  constructor(readonly latencyMs: number) {}
  async health() {
    return { ok: true, detail: `mock composer, fixed latency ${this.latencyMs} ms (unattested_dev)` };
  }
  async listModels() {
    return [{ id: "mock-composer-1", attestation: "unsupported" as const, outputModes: ["json_schema"] }];
  }
  async generateStructured<T>(a: { prompt: string; schema: z.ZodType<T> }): Promise<StructuredResult<T>> {
    const startedAt = performance.now();
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const m = /\[window=(\d+)\]/.exec(a.prompt);
    const variant = m ? Number(m[1]) : 0;
    const w = windowFor(variant);
    const out = {
      rationale: "Compare completed, private-settlement and volume series, plus completion rate.",
      panels: MEASURES.map(([title, mark, measure]) => ({
        title,
        mark,
        measures: [measure],
        grain: "day",
        ...w,
      })),
    };
    this.calls.push({ variant, startedAt, ms: performance.now() - startedAt });
    return {
      output: a.schema.parse(out),
      provider: this.id,
      model: "mock-composer-1",
      requestId: `mock-${this.calls.length}`,
      usage: { inputTokens: 0, outputTokens: 0 },
      evidence: null,
      rawResponseSha256: "0".repeat(64),
    };
  }
  // eslint-disable-next-line require-yield
  async *streamText(): AsyncIterable<string> {
    return;
  }
  async verifyResponse(): Promise<VerificationResult> {
    return { verified: false, status: "unattested_dev", checks: [] };
  }
}
