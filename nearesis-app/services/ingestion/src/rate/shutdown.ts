/**
 * Process-wide registry of held leases and a graceful-shutdown installer: on SIGTERM/SIGINT every registered lease is
 * released (so a restart does not wait out the TTL), then the process exits after a bounded grace period.
 */
export interface Releasable {
  release(): Promise<void>;
}
const held = new Set<Releasable>();
export const trackLease = (l: Releasable): void => void held.add(l);
export const untrackLease = (l: Releasable): void => void held.delete(l);
export const heldLeaseCount = (): number => held.size;

/** Releases every tracked lease (errors swallowed: the TTL is the fallback). Returns how many were attempted. */
export async function releaseAllLeases(): Promise<number> {
  const all = [...held];
  await Promise.allSettled(all.map((l) => l.release()));
  return all.length;
}

export interface ShutdownOptions {
  log: (m: string) => void;
  /** Called synchronously on the first signal so loops stop after the current step. */
  onStop: () => void;
  /** Extra cleanup after leases are released (close pools). Errors are ignored. */
  cleanup?: () => Promise<void>;
  /** Time the current step gets to finish before leases are released and the process exits. Default 15 s. */
  graceMs?: number;
  exit?: (code: number) => void;
  /** Signals to hook (tests pass none and call `trigger`). */
  signals?: NodeJS.Signals[];
}

export function installGracefulShutdown(o: ShutdownOptions): {
  trigger(sig: string): Promise<void>;
  isStopping(): boolean;
} {
  let stopping = false;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const trigger = async (sig: string): Promise<void> => {
    if (stopping) {
      o.log(`${sig}: second signal, releasing leases and exiting now`);
      await releaseAllLeases();
      exit(130);
      return;
    }
    stopping = true;
    o.log(`${sig}: stopping after the current step (grace ${(o.graceMs ?? 15_000) / 1000}s)`);
    o.onStop();
    const t = setTimeout(() => {
      void (async () => {
        const n = await releaseAllLeases();
        o.log(`grace elapsed: released ${n} lease(s), exiting`);
        await o.cleanup?.().catch(() => undefined);
        exit(0);
      })();
    }, o.graceMs ?? 15_000);
    t.unref();
  };
  for (const s of o.signals ?? (["SIGINT", "SIGTERM"] as const)) process.on(s, () => void trigger(s));
  return { trigger, isStopping: () => stopping };
}
