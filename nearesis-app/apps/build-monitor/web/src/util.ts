import { useEffect, useRef, useState } from "react";
import type { GateView, State } from "./types.ts";

export function relAge(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return "telemetry unavailable";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const ageOf = (iso: string, now: number): string => relAge(now - Date.parse(iso));
export const orNA = (v: string | null | undefined): string => (v ? v : "telemetry unavailable");
export const pct = (n: number, d: number): number => (d > 0 ? n / d : 0);

export const GATE_NAMES: Record<string, string> = {
  G00: "Foundation",
  G01: "Kernel",
  G02: "Ingestion",
  G03: "Analytics",
  G04: "Agents",
  G05: "Canvas",
};
export const OUTSIDE_PHASES = ["P06", "P07", "P08", "P09", "P10", "P11", "P12"];

/** Verdict pill for a gate: PASS / PARTIAL / FAIL / BLOCKED / PENDING. */
export function gatePill(g: GateView): "PASS" | "PARTIAL" | "FAIL" | "BLOCKED" | "PENDING" {
  if (g.verdict === "PASS") return "PASS";
  if (g.failed > 0) return "FAIL";
  if (g.blocked > 0) return "BLOCKED";
  if (g.passed > 0) return "PARTIAL";
  return "PENDING";
}

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || 600);
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export type Conn = "live" | "reconnecting" | "disconnected";

export function useMonitorState(): { state: State | null; conn: Conn; lastAt: string | null } {
  const [state, setState] = useState<State | null>(null);
  const [conn, setConn] = useState<Conn>("reconnecting");
  const [lastAt, setLastAt] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource("/api/stream");
    es.onopen = () => {
      clearTimeout(timer);
      setConn("live");
    };
    es.onerror = () => {
      setConn((c) => (c === "disconnected" ? c : "reconnecting"));
      clearTimeout(timer);
      timer = setTimeout(() => setConn("disconnected"), 12_000);
    };
    es.addEventListener("state", (e) => {
      const s = JSON.parse((e as MessageEvent<string>).data) as State;
      setState(s);
      setLastAt(new Date().toISOString());
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  return { state, conn, lastAt };
}

export function useHashRoute(): [string, string | null, (tab: string, sub?: string) => void] {
  const parse = (): [string, string | null] => {
    const [t, sub] = window.location.hash.replace(/^#\/?/, "").split("/");
    return [
      ["overview", "agents", "tests", "tasks", "reports"].includes(t ?? "") ? (t as string) : "overview",
      sub ?? null,
    ];
  };
  const [r, setR] = useState(parse);
  useEffect(() => {
    const h = (): void => setR(parse());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return [r[0], r[1], (tab, sub) => (window.location.hash = `#/${tab}${sub ? `/${sub}` : ""}`)];
}
