// Shared fixture plumbing. State lives on globalThis so the test and the dynamically imported plugin share it.
import { definePlugin } from "@nearesis/plugin-sdk";

interface Fx {
  imports: Record<string, number>;
  calls: Record<string, number>;
  latches: Record<string, { promise: Promise<void> }>;
  healthFail: Record<string, boolean>;
}
const g = globalThis as unknown as { __nearesisFx?: Fx };
g.__nearesisFx ??= { imports: {}, calls: {}, latches: {}, healthFail: {} };
export const state = g.__nearesisFx;

export function countImport(name: string): void {
  state.imports[name] = (state.imports[name] ?? 0) + 1;
}
const hit = (name: string) => (state.calls[name] = (state.calls[name] ?? 0) + 1);

export function makeEcho(name: string, version: string) {
  const ns = name.replace(/-/g, "_");
  return definePlugin({
    handlers: {
      [`${ns}.say@1`]: (input) => {
        hit(`${name}@${version}`);
        return { echo: (input as { text?: string }).text ?? null, version };
      },
      [`${ns}.slow@1`]: async (input) => {
        hit(`${name}@${version}`);
        const latch = (input as { latch?: string }).latch;
        if (latch) await state.latches[latch]?.promise;
        return { echo: "slow", version };
      },
      [`${ns}.hang@1`]: async (_input, ctx) => {
        hit(`${name}@${version}:hang`);
        await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res()));
        return { echo: "late-success", version };
      },
      [`${ns}.leak@1`]: () => {
        hit(`${name}@${version}`);
        return {
          ok: true,
          apiKey: "sk-live-123",
          nested: { Authorization: "Bearer abc", fine: 1 },
          list: [{ jwt: "x" }],
        };
      },
      [`${ns}.boom@1`]: () => {
        hit(`${name}@${version}`);
        throw new Error("boom with token=abc");
      },
    },
    health: () => {
      if (state.healthFail[name]) throw new Error("injected health failure");
    },
  });
}
