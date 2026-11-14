/**
 * Small in-process TTL memo with in-flight de-duplication, used for the per-source reads (vintage, coverage, gaps,
 * watermarks, row rates) that only change when ingestion lands. Failures are never cached.
 */
export class ReadCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 2000,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.value as Promise<T>;
    if (this.entries.size >= this.maxEntries) {
      for (const [k, v] of this.entries) if (t - v.at >= this.ttlMs) this.entries.delete(k);
      if (this.entries.size >= this.maxEntries) this.entries.clear();
    }
    const value = load();
    this.entries.set(key, { at: t, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
