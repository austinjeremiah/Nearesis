/**
 * SYNTHETIC fixtures for the design lab. Deterministic (seeded), labelled as synthetic everywhere they are shown.
 * They mirror the shape of the canvas scenarios in apps/web (read-only reference) without importing from it.
 */
import type { ChartSpec } from "@nearesis/ui";

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1);
const iso = (t: number) => new Date(t).toISOString();

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function volumeSpec(): ChartSpec {
  const r = rng(11);
  const rows: ChartSpec["rows"] = [];
  let v = 4.2;
  for (let d = 0; d < 41; d++) {
    v = Math.max(1, v + (r() - 0.46) * 0.9);
    const gap = d >= 24 && d <= 27;
    rows.push([
      iso(T0 + d * DAY),
      gap ? null : Math.round(v * 100) / 100,
      gap ? null : Math.round((v * 0.62 + r() * 0.4) * 100) / 100,
    ]);
  }
  return {
    kind: "area",
    title: "Settled volume",
    columns: [
      { name: "intents.day", unit: null },
      { name: "intents.settled_volume", unit: "USD m" },
      { name: "intents.net_volume", unit: "USD m" },
    ],
    rows,
    x: { field: "intents.day", type: "time" },
    y: [
      { field: "intents.settled_volume", unit: "USD m" },
      { field: "intents.net_volume", unit: "USD m" },
    ],
    gaps: [{ from: iso(T0 + 24 * DAY), to: iso(T0 + 27 * DAY), reason: "source outage" }],
    markers: [
      { id: "m1", kind: "threshold", value: 6, op: "gt", label: "> 6" },
      { id: "m2", kind: "time_range", start: iso(T0 + 8 * DAY), end: iso(T0 + 12 * DAY), label: "campaign" },
    ],
  };
}

export function chainBarSpec(): ChartSpec {
  const chains = ["NEAR", "Ethereum", "Solana", "Arbitrum", "Base", "Bitcoin", "TON"];
  const r = rng(5);
  return {
    kind: "bar",
    title: "Intents by origin chain",
    columns: [
      { name: "intents.origin_chain", unit: null },
      { name: "intents.count", unit: "intents" },
    ],
    rows: chains.map((c, i) => [c, Math.round((1 - i * 0.12) * 9000 * (0.7 + r() * 0.5))]),
    x: { field: "intents.origin_chain", type: "category" },
    y: [{ field: "intents.count", unit: "intents" }],
  };
}

export function fillLatencySpec(): ChartSpec {
  const r = rng(23);
  const rows: ChartSpec["rows"] = [];
  for (let d = 0; d < 40; d++)
    rows.push([
      iso(T0 + d * DAY),
      Math.round((92 + Math.sin(d / 5) * 4 + r() * 2) * 10) / 10,
      Math.round(2200 + Math.cos(d / 6) * 400 + r() * 150),
    ]);
  return {
    kind: "line",
    title: "Fill rate and latency",
    columns: [
      { name: "solver.day", unit: null },
      { name: "solver.fill_rate", unit: "%" },
      { name: "solver.p95_latency", unit: "ms" },
    ],
    rows,
    x: { field: "solver.day", type: "time" },
    y: [
      { field: "solver.fill_rate", unit: "%", side: "left" },
      { field: "solver.p95_latency", unit: "ms", side: "right" },
    ],
  };
}

export function heatmapSpec(): ChartSpec {
  const hours = ["00", "04", "08", "12", "16", "20"];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const r = rng(31);
  const rows: ChartSpec["rows"] = [];
  for (const d of days)
    for (const h of hours) rows.push([h, d, Math.round(40 + r() * 60 + (h === "12" || h === "16" ? 40 : 0))]);
  return {
    kind: "heatmap",
    title: "Hourly volume",
    columns: [
      { name: "hour", unit: null },
      { name: "weekday", unit: null },
      { name: "volume", unit: "USD k" },
    ],
    rows,
    x: { field: "hour", type: "category" },
    y: [{ field: "weekday" }],
    value: { field: "volume", unit: "USD k" },
  };
}

export function candlestickSpec(): ChartSpec {
  const r = rng(77);
  let p = 5.1;
  const rows: ChartSpec["rows"] = [];
  for (let d = 0; d < 30; d++) {
    const open = p;
    const close = Math.max(3, open + (r() - 0.5) * 0.5);
    const hi = Math.max(open, close) + r() * 0.2;
    const lo = Math.min(open, close) - r() * 0.2;
    p = close;
    rows.push([iso(T0 + d * DAY), +open.toFixed(3), +close.toFixed(3), +lo.toFixed(3), +hi.toFixed(3)]);
  }
  return {
    kind: "candlestick",
    title: "NEAR/USDC",
    columns: [
      { name: "ts", unit: null },
      { name: "open", unit: "USDC" },
      { name: "close", unit: "USDC" },
      { name: "low", unit: "USDC" },
      { name: "high", unit: "USDC" },
    ],
    rows,
    x: { field: "ts", type: "time" },
    y: [{ field: "close", unit: "USDC" }],
  };
}

/** n-point series with injected one-point spikes so downsampling can be checked for spike preservation. */
export function bigSeries(n: number, seed = 3): { rows: Array<[number, number]>; spikes: number[] } {
  const r = rng(seed);
  const rows: Array<[number, number]> = [];
  const spikes: number[] = [];
  const step = Math.floor((40 * DAY) / n) || 1;
  let v = 100;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * 2;
    rows.push([T0 + i * step, v]);
  }
  for (let k = 1; k <= 5; k++) {
    const i = Math.floor((n * k) / 6);
    rows[i] = [rows[i]![0], 100 + 400 * k];
    spikes.push(i);
  }
  return { rows, spikes };
}

export function bigScatter(n: number, seed = 9): Array<[number, number]> {
  const r = rng(seed);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const x = r() * 1000;
    out.push([x, x * 0.4 + (r() - 0.5) * 200]);
  }
  return out;
}

export function tableRows(): { columns: ChartSpec["columns"]; rows: ChartSpec["rows"] } {
  const r = rng(41);
  const pairs = ["NEAR/USDC", "ETH/USDC", "SOL/USDC", "BTC/NEAR", "ARB/USDC", "TON/NEAR"];
  return {
    columns: [
      { name: "pair", unit: null },
      { name: "volume", unit: "USD" },
      { name: "fills", unit: null },
      { name: "avg_slippage", unit: "bps" },
    ],
    rows: pairs.map((p) => [
      p,
      Math.round(r() * 900_000),
      Math.round(r() * 4000),
      r() < 0.15 ? null : +(r() * 12).toFixed(2),
    ]),
  };
}
