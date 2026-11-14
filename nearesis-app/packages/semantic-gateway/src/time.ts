/** UTC bucket arithmetic. Cube weeks start on Monday; months on the 1st. */
export type Grain = "hour" | "day" | "week" | "month";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function bucketStart(ms: number, grain: Grain): number {
  const d = new Date(ms);
  switch (grain) {
    case "hour":
      return Math.floor(ms / HOUR) * HOUR;
    case "day":
      return Math.floor(ms / DAY) * DAY;
    case "week": {
      const day0 = Math.floor(ms / DAY) * DAY;
      const dow = (new Date(day0).getUTCDay() + 6) % 7; // Monday = 0
      return day0 - dow * DAY;
    }
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

export function nextBucket(startMs: number, grain: Grain): number {
  switch (grain) {
    case "hour":
      return startMs + HOUR;
    case "day":
      return startMs + DAY;
    case "week":
      return startMs + 7 * DAY;
    case "month": {
      const d = new Date(startMs);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
}

/** `YYYY-MM-DDTHH:mm:ss.SSS` (no zone), the key shape Cube uses for time dimensions. */
export const cubeTime = (ms: number) => new Date(ms).toISOString().slice(0, 23);
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Days (UTC, YYYY-MM-DD) in [fromMs, toMs). */
export function daysBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let t = Math.floor(fromMs / DAY) * DAY; t < toMs; t += DAY) out.push(isoDay(t));
  return out;
}

export const DAY_MS = DAY;
