import type { Kernel } from "@nearesis/kernel";
import { SloRecorder, evaluateAndAlert, kernelAlertSink } from "@nearesis/workflow";

/**
 * SLO recording and burn-rate evaluation for a running API (ch.13 Observability). The recorder is passed to `buildApp`
 * (`sloRecorder`) and flushes every 5 s; the evaluator runs every `intervalMs` (default 60 s) and sends firing
 * multi-window burn alerts through the kernel event path (`kernelAlertSink`), de-duplicated and capped per window.
 * Requires runtime migration 005. Off unless the host calls it (main.ts: NEARESIS_COST_CONTROL=1).
 */
export function startOpsBackground(kernel: Kernel, o: { intervalMs?: number } = {}) {
  const recorder = new SloRecorder(kernel.db.pool);
  recorder.start();
  const sink = kernelAlertSink(kernel);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    recorder
      .flush()
      .then(() => evaluateAndAlert(kernel.db.pool, sink, new Date()))
      .catch(() => undefined)
      .finally(() => (busy = false));
  }, o.intervalMs ?? 60_000);
  timer.unref();
  return {
    recorder,
    stop: async () => {
      clearInterval(timer);
      await recorder.stop();
    },
  };
}
