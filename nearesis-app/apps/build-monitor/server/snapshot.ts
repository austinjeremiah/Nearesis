import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  AgentRecord,
  CoordinationEvent,
  EngineStatus,
  HEARTBEAT_TIMEOUT_MS,
  TaskBoard,
  TestResult,
} from "@nearesis/contracts";
import type { z } from "zod";
import type { CommitInfo } from "./git.ts";
import type { MonitorPaths } from "./paths.ts";

export const GATES = ["G00", "G01", "G02", "G03", "G04", "G05"] as const;
export const UPSTREAM: Record<string, string[]> = {
  G00: [],
  G01: ["G00"],
  G02: ["G00"],
  G03: ["G02"],
  G04: ["G01", "G03"],
  G05: ["G03", "G04"],
};
export const TOTAL_PHASES = 13;
export const EVENT_TAIL = 200;
const DEFAULT_LIMITS = { ENGINE_A: 4, ENGINE_B: 2 } as const;

export interface InvalidEntry {
  path: string;
  error: string;
}
type Read<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "invalid"; error: string };

function fmtZod(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function readParsed<T>(path: string, schema: z.ZodType<T>): Read<T> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: "invalid", error: `invalid JSON: ${(e as Error).message}` };
  }
  const r = schema.safeParse(raw);
  return r.success ? { kind: "ok", value: r.data } : { kind: "invalid", error: fmtZod(r.error) };
}

function readRawJson(path: string): { raw: unknown } | null {
  try {
    return { raw: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch {
    return null;
  }
}

function listFiles(dir: string, match: (name: string) => boolean, recursive = false, cap = 500): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) walk(p);
      } else if (e.isFile() && match(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export type EffectiveStatus = z.infer<typeof AgentRecord>["status"] | "INVALID";

export interface AgentView {
  agentId: string;
  file: string;
  record: AgentRecord | null;
  effectiveStatus: EffectiveStatus;
  heartbeatAgeMs: number | null;
  valid: boolean;
  error?: string;
}

/** RUNNING only when the record says RUNNING and the heartbeat is within the timeout. */
export function effectiveStatus(rec: AgentRecord, nowMs: number): { status: EffectiveStatus; ageMs: number } {
  const ageMs = nowMs - Date.parse(rec.heartbeatAt);
  if (rec.status === "RUNNING" && !(ageMs <= HEARTBEAT_TIMEOUT_MS)) return { status: "STALE", ageMs };
  return { status: rec.status, ageMs };
}

export type EngineState = "NOT_STARTED" | "ACTIVE" | "STALE" | "INVALID" | "MISSING";
export interface EngineView {
  state: EngineState;
  status: EngineStatus | null;
  heartbeatAgeMs: number | null;
  error?: string;
  /** Most recent commit known from agent records / engine status; null if unreported. */
  lastCommit: { sha: string; source: string } | null;
}

export type Verdict = "PASS" | "FAIL" | "BLOCKED_DEPENDENCY" | "NOT_RUN";
export interface TestView {
  testId: string;
  gate: string;
  name: string;
  indexStatus: string;
  implemented: boolean;
  latestVerdict: Verdict;
  latestRunId: string | null;
  executedAt: string | null;
  evidencePath: string | null;
  passCondition: string;
  owner: string;
  /** false = historical (excluded from gates and milestone). Missing field means true. */
  required: boolean;
  supersededBy: string | null;
  latestCommit: string | null;
  /** Evidence commit is not among the recent commits (HEAD has moved on or commit unknown). */
  staleEvidence: boolean;
  history: HistoryItem[];
}
export interface GateView {
  gate: string;
  passed: number;
  total: number;
  implemented: number;
  executed: number;
  failed: number;
  blocked: number;
  /** Upstream gates that are not PASS (lock). */
  lockedBy: string[];
  verdict: "PASS" | "FAIL" | "BLOCKED" | "PENDING" | "WAITING_UPSTREAM";
  upstream: string[];
}
export interface ReportItem {
  path: string;
  name: string;
  mtime: string;
  title?: string;
  status?: string;
}
export interface WaitingItem {
  kind: "BLOCKER" | "QUEUE";
  id: string;
  title: string;
  severity: string | null;
  owner: string | null;
  status: string;
  path: string | null;
  since: string;
  line?: number;
}

const STATUS_WORDS = /status\s*:\s*\**\s*([A-Za-z_]+)/gi;
/** Tolerant parse of a blocker markdown file. The last `Status:` mention wins (Resolution sections). */
export function parseBlocker(text: string): {
  id: string;
  title: string;
  severity: string | null;
  owner: string | null;
  status: string;
} {
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const m = /^(BLK-[0-9A-Za-z-]+?)\s*[:\u2014\u2013-]\s+(.*)$/.exec(h1);
  const field = (name: string): string | null => {
    const r = new RegExp(`^[\\s>*-]*\\**${name}\\**\\s*:\\**\\s*(.+)$`, "im").exec(text);
    return r?.[1]?.replace(/\*+/g, "").trim() ?? null;
  };
  let status = "OPEN";
  for (const x of text.matchAll(STATUS_WORDS)) status = (x[1] ?? "OPEN").toUpperCase();
  return {
    id: m?.[1] ?? "",
    title: m?.[2] ?? h1,
    severity: field("Severity"),
    owner: field("Owner"),
    status,
  };
}

const needsHuman = (w: { owner: string | null; severity: string | null }): boolean =>
  /human|owner/i.test(w.owner ?? "") || /release_stop|phase_stop/i.test(w.severity ?? "");

/** `[OPEN]` entries in INTEGRATION_QUEUE.md (format: `- [OPEN] ts engine type - summary - paths`). */
/** First sentence of `text`, hard-capped at `max` characters. */
export function firstSentence(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const one = m?.[1] && m[1].length >= 12 ? m[1] : flat;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function parseQueue(text: string): { id: string; title: string; line: number; ts: string | null }[] {
  const out: { id: string; title: string; line: number; ts: string | null }[] = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*[-*]\s*\[OPEN\]\s*(.*)$/.exec(line);
    if (!m) return;
    const rest = m[1] ?? "";
    const parts = rest.split(/\s+[\u2014\u2013-]\s+/);
    const head = (parts[0] ?? "").trim();
    const tm = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)\s+(.*)$/.exec(head);
    out.push({
      id: (tm ? tm[2] : head) || "queue",
      title: firstSentence(parts.slice(1).join(" - ").trim() || rest),
      line: i + 1,
      ts: tm?.[1] ?? null,
    });
  });
  return out;
}

export interface GraphNode {
  id: string;
  title: string;
  status: string;
  layer: number;
  order: number;
  owner: string;
  phase: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
  layers: string[][];
  missingDeps: { task: string; dep: string }[];
}

export function buildGraph(tasks: TaskBoard["tasks"]): Graph {
  const ids = new Set(tasks.map((t) => t.id));
  const missingDeps: Graph["missingDeps"] = [];
  const edges: Graph["edges"] = [];
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (ids.has(d)) edges.push({ from: d, to: t.id });
      else missingDeps.push({ task: t.id, dep: d });
    }
  }
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = (id: string): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let l = 0;
    for (const d of byId.get(id)?.dependsOn ?? []) if (ids.has(d)) l = Math.max(l, depth(d) + 1);
    visiting.delete(id);
    layerOf.set(id, l);
    return l;
  };
  const layers: string[][] = [];
  for (const t of tasks) {
    const l = depth(t.id);
    (layers[l] ??= []).push(t.id);
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];
  const nodes: GraphNode[] = tasks.map((t) => {
    const layer = layerOf.get(t.id) ?? 0;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      layer,
      order: (layers[layer] ?? []).indexOf(t.id),
      owner: t.owner,
      phase: t.phase,
    };
  });
  return { nodes, edges, layers, missingDeps };
}

/** Parse EVENTS.jsonl; malformed or schema-invalid lines are reported, never dropped silently. */
export function parseEvents(
  text: string,
  path = "EVENTS.jsonl",
): { events: CoordinationEvent[]; invalid: InvalidEntry[] } {
  const events: CoordinationEvent[] = [];
  const invalid: InvalidEntry[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      invalid.push({ path: `${path}:${i + 1}`, error: `invalid JSON: ${(e as Error).message}` });
      return;
    }
    const r = CoordinationEvent.safeParse(raw);
    if (r.success) events.push(r.data);
    else invalid.push({ path: `${path}:${i + 1}`, error: fmtZod(r.error) });
  });
  return { events, invalid };
}

interface IndexEntry {
  testId: string;
  gate: string;
  name?: string;
  status?: string;
  passCondition?: string;
  owner?: string;
  testFiles?: unknown;
  required?: boolean;
  supersededBy?: string;
}

export const isTestResultFile = (name: string): boolean => /^[^.]+\.json$/.test(name);

export interface HistoryItem {
  runId: string;
  verdict: Verdict;
  executedAt: string;
  commitSha: string;
  path: string;
}

export interface State {
  generatedAt: string;
  heartbeatTimeoutMs: number;
  engines: { A: EngineView; B: EngineView };
  agents: AgentView[];
  declaredAgents: { agentId: string; engine: string; taskId: string; hasRecord: boolean }[];
  limits: {
    ENGINE_A: { active: number; max: number; breach: boolean };
    ENGINE_B: { active: number; max: number; breach: boolean };
  };
  tasks: TaskBoard["tasks"];
  graph: Graph;
  events: CoordinationEvent[];
  tests: TestView[];
  gates: GateView[];
  phases: { total: number; completed: number; current: string | null; blocked: string[] };
  counts: {
    required: number;
    passed: number;
    failed: number;
    blocked: number;
    notRun: number;
    implemented: number;
  };
  milestone: { passed: number; total: number; percent: number; basis: "evidence-based" };
  latestResults: TestResult[];
  commits: CommitInfo[];
  waiting: WaitingItem[];
  reports: {
    phase: ReportItem[];
    blockers: ReportItem[];
    findings: ReportItem[];
    decisions: ReportItem[];
    tests: ReportItem[];
    handoffs: ReportItem[];
  };
  notes: string[];
  invalid: InvalidEntry[];
}

function engineView(
  path: string,
  agents: AgentView[],
  engineId: "ENGINE_A" | "ENGINE_B",
  nowMs: number,
  invalid: InvalidEntry[],
  notes: string[],
): EngineView {
  const r = readParsed(path, EngineStatus);
  // most recent commitSha reported by this engine's agent records
  let best: { sha: string; source: string; at: number } | null = null;
  for (const a of agents) {
    if (a.record?.parentEngine === engineId && a.record.commitSha) {
      const at = Date.parse(a.record.heartbeatAt);
      if (!best || at > best.at) best = { sha: a.record.commitSha, source: `agent ${a.agentId}`, at };
    }
  }
  const agentCommit = best ? { sha: best.sha, source: best.source } : null;
  if (r.kind === "missing") {
    notes.push(`${basename(path)} missing`);
    return { state: "MISSING", status: null, heartbeatAgeMs: null, lastCommit: agentCommit };
  }
  if (r.kind === "invalid") {
    invalid.push({ path, error: r.error });
    return { state: "INVALID", status: null, heartbeatAgeMs: null, error: r.error, lastCommit: agentCommit };
  }
  const s = r.value;
  const lastCommit = agentCommit ?? (s.lastCommit ? { sha: s.lastCommit, source: "engine status" } : null);
  if (!s.initialized || s.heartbeatAt === null) {
    return { state: "NOT_STARTED", status: s, heartbeatAgeMs: null, lastCommit };
  }
  const age = nowMs - Date.parse(s.heartbeatAt);
  return {
    state: age <= HEARTBEAT_TIMEOUT_MS ? "ACTIVE" : "STALE",
    status: s,
    heartbeatAgeMs: age,
    lastCommit,
  };
}

function reportList(bibleDir: string, files: string[], withMeta = false): ReportItem[] {
  return files
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(f).mtimeMs;
      } catch {
        /* vanished */
      }
      const item: ReportItem & { m: number } = {
        path: relative(bibleDir, f),
        name: basename(f),
        mtime: new Date(mtime).toISOString(),
        m: mtime,
      };
      if (withMeta && f.endsWith(".md")) {
        try {
          const text = readFileSync(f, "utf8");
          item.title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
          if (/status\s*:/i.test(text)) item.status = parseBlocker(text).status;
        } catch {
          /* unreadable */
        }
      }
      return item;
    })
    .sort((a, b) => b.m - a.m || a.path.localeCompare(b.path))
    .map(({ m: _m, ...rest }) => rest);
}

const REPORT_EXT = (n: string): boolean => /\.(md|json|jsonl|txt|log|sql)$/i.test(n);

export function buildSnapshot(paths: MonitorPaths, now: Date, commits: CommitInfo[] = []): State {
  const nowMs = now.getTime();
  const invalid: InvalidEntry[] = [];
  const notes: string[] = [];

  // ---- agents
  const agentFiles = listFiles(join(paths.coordDir, "agents"), (n) => n.endsWith(".json"));
  if (!existsSync(join(paths.coordDir, "agents")))
    notes.push("coordination/agents missing: no agent records yet");
  const agents: AgentView[] = agentFiles.map((file) => {
    const fallbackId = basename(file, ".json");
    const r = readParsed(file, AgentRecord);
    if (r.kind === "ok") {
      const { status, ageMs } = effectiveStatus(r.value, nowMs);
      return {
        agentId: r.value.agentId,
        file,
        record: r.value,
        effectiveStatus: status,
        heartbeatAgeMs: ageMs,
        valid: true,
      };
    }
    const error = r.kind === "invalid" ? r.error : "file vanished while reading";
    invalid.push({ path: file, error });
    return {
      agentId: fallbackId,
      file,
      record: null,
      effectiveStatus: "INVALID",
      heartbeatAgeMs: null,
      valid: false,
      error,
    };
  });

  const engines = {
    A: engineView(join(paths.coordDir, "ENGINE_A_STATUS.json"), agents, "ENGINE_A", nowMs, invalid, notes),
    B: engineView(join(paths.coordDir, "ENGINE_B_STATUS.json"), agents, "ENGINE_B", nowMs, invalid, notes),
  };

  // ---- registry (limits, declared agents)
  const reg = readRawJson(join(paths.coordDir, "AGENT_REGISTRY.json"));
  const regObj = (reg?.raw ?? {}) as {
    limits?: Partial<Record<"ENGINE_A" | "ENGINE_B", number>>;
    declared?: { agentId?: string; engine?: string; taskId?: string }[];
  };
  const maxA = typeof regObj.limits?.ENGINE_A === "number" ? regObj.limits.ENGINE_A : DEFAULT_LIMITS.ENGINE_A;
  const maxB = typeof regObj.limits?.ENGINE_B === "number" ? regObj.limits.ENGINE_B : DEFAULT_LIMITS.ENGINE_B;
  const live = new Set<EffectiveStatus>(["RUNNING", "BLOCKED", "WAITING"]);
  const activeOf = (e: "ENGINE_A" | "ENGINE_B"): number =>
    agents.filter((a) => a.record?.parentEngine === e && live.has(a.effectiveStatus)).length;
  const limit = (e: "ENGINE_A" | "ENGINE_B", max: number) => {
    const active = activeOf(e);
    return { active, max, breach: active > max };
  };
  const declaredAgents = (Array.isArray(regObj.declared) ? regObj.declared : []).flatMap((d) =>
    typeof d?.agentId === "string"
      ? [
          {
            agentId: d.agentId,
            engine: String(d.engine ?? ""),
            taskId: String(d.taskId ?? ""),
            hasRecord: agents.some((a) => a.agentId === d.agentId),
          },
        ]
      : [],
  );

  // ---- task board
  const tb = readParsed(join(paths.coordDir, "TASK_BOARD.json"), TaskBoard);
  let tasks: TaskBoard["tasks"] = [];
  if (tb.kind === "ok") tasks = tb.value.tasks;
  else if (tb.kind === "invalid")
    invalid.push({ path: join(paths.coordDir, "TASK_BOARD.json"), error: tb.error });
  else notes.push("TASK_BOARD.json missing: no task graph");
  const graph = buildGraph(tasks);

  // ---- events
  const evPath = join(paths.coordDir, "EVENTS.jsonl");
  let events: CoordinationEvent[] = [];
  if (existsSync(evPath)) {
    const parsed = parseEvents(readFileSync(evPath, "utf8"), evPath);
    events = parsed.events.slice(-EVENT_TAIL);
    invalid.push(...parsed.invalid.slice(-20));
  } else notes.push("EVENTS.jsonl missing: no events");

  // ---- tests (evidence-derived)
  const idx = readRawJson(paths.testIndex);
  let entries: IndexEntry[] = [];
  if (!idx) notes.push("TEST_INDEX.json missing or unreadable: no test matrix");
  else {
    const t = (idx.raw as { tests?: unknown }).tests;
    if (Array.isArray(t)) {
      entries = t.filter(
        (x): x is IndexEntry => typeof x?.testId === "string" && typeof x?.gate === "string",
      );
    } else invalid.push({ path: paths.testIndex, error: "tests array missing" });
  }
  const testsDir = join(paths.reportsDir, "TESTS");
  const allResults: TestResult[] = [];
  const latest = new Map<string, { res: TestResult; file: string }>();
  const history = new Map<string, HistoryItem[]>();
  for (const e of entries) {
    // Only `<runId>.json` (no second dot) is a TestResult; `.evidence.json` / `.log.json` are runner sidecars.
    for (const file of listFiles(join(testsDir, e.testId), isTestResultFile)) {
      const r = readParsed(file, TestResult);
      if (r.kind === "invalid") {
        invalid.push({ path: file, error: r.error });
        continue;
      }
      if (r.kind !== "ok") continue;
      if (r.value.testId !== e.testId) {
        invalid.push({ path: file, error: `testId ${r.value.testId} does not match directory ${e.testId}` });
        continue;
      }
      allResults.push(r.value);
      (history.get(e.testId) ?? history.set(e.testId, []).get(e.testId)!).push({
        runId: r.value.runId,
        verdict: r.value.verdict,
        executedAt: r.value.executedAt,
        commitSha: r.value.commitSha,
        path: relative(paths.bibleDir, file),
      });
      const cur = latest.get(e.testId);
      if (!cur || Date.parse(r.value.executedAt) > Date.parse(cur.res.executedAt))
        latest.set(e.testId, { res: r.value, file });
    }
  }
  const tests: TestView[] = entries.map((e) => {
    const l = latest.get(e.testId);
    const indexStatus = e.status ?? "NOT_IMPLEMENTED";
    const hist = (history.get(e.testId) ?? []).sort(
      (a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt),
    );
    const sha = l?.res.commitSha ?? null;
    const hasFiles = Array.isArray(e.testFiles) && e.testFiles.length > 0;
    return {
      testId: e.testId,
      gate: e.gate,
      name: e.name ?? "",
      indexStatus,
      implemented: hasFiles || indexStatus !== "NOT_IMPLEMENTED",
      latestVerdict: l ? l.res.verdict : "NOT_RUN",
      latestRunId: l ? l.res.runId : null,
      executedAt: l ? l.res.executedAt : null,
      evidencePath: l ? relative(paths.bibleDir, l.file) : null,
      passCondition: e.passCondition ?? "",
      owner: e.owner ?? "",
      required: e.required !== false,
      supersededBy: typeof e.supersededBy === "string" ? e.supersededBy : null,
      latestCommit: sha,
      staleEvidence:
        sha !== null &&
        commits.length > 0 &&
        !commits.some((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha)),
      history: hist,
    };
  });

  // only required tests count toward gates and the milestone; historical ones are display-only
  const req = tests.filter((t) => t.required);
  // ---- gates (upstream-aware)
  const gateIds = [...new Set([...GATES, ...tests.map((t) => t.gate)])];
  const own = new Map<string, boolean>();
  const gates: GateView[] = [];
  const pass = new Map<string, boolean>();
  const ordered = [...gateIds].sort();
  const ownPass = (g: string): { passed: number; total: number } => {
    const ts = req.filter((t) => t.gate === g);
    return { passed: ts.filter((t) => t.latestVerdict === "PASS").length, total: ts.length };
  };
  for (const g of ordered)
    own.set(
      g,
      (() => {
        const o = ownPass(g);
        return o.total > 0 && o.passed === o.total;
      })(),
    );
  const resolveGate = (g: string, seen = new Set<string>()): boolean => {
    const c = pass.get(g);
    if (c !== undefined) return c;
    if (seen.has(g)) return false;
    seen.add(g);
    const ok = (own.get(g) ?? false) && (UPSTREAM[g] ?? []).every((u) => resolveGate(u, seen));
    pass.set(g, ok);
    return ok;
  };
  for (const g of ordered) {
    const { passed, total } = ownPass(g);
    const ts = req.filter((t) => t.gate === g);
    const gp = resolveGate(g);
    let verdict: GateView["verdict"];
    if (gp) verdict = "PASS";
    else if (ts.some((t) => t.latestVerdict === "FAIL")) verdict = "FAIL";
    else if (ts.some((t) => t.latestVerdict === "BLOCKED_DEPENDENCY")) verdict = "BLOCKED";
    else if (total > 0 && passed === total) verdict = "WAITING_UPSTREAM";
    else verdict = "PENDING";
    gates.push({
      gate: g,
      passed,
      total,
      implemented: ts.filter((t) => t.implemented).length,
      executed: ts.filter((t) => t.latestVerdict !== "NOT_RUN").length,
      failed: ts.filter((t) => t.latestVerdict === "FAIL").length,
      blocked: ts.filter((t) => t.latestVerdict === "BLOCKED_DEPENDENCY").length,
      lockedBy: (UPSTREAM[g] ?? []).filter((u) => !resolveGate(u)),
      verdict,
      upstream: UPSTREAM[g] ?? [],
    });
  }
  const completed = gates.filter((g) => g.verdict === "PASS").length;
  const firstOpen = gates.find((g) => g.verdict !== "PASS");
  const phases = {
    total: TOTAL_PHASES,
    completed,
    current: firstOpen ? firstOpen.gate : gates.length ? "ALL_GATES_PASS" : null,
    blocked: gates.filter((g) => g.verdict === "BLOCKED" || g.verdict === "FAIL").map((g) => g.gate),
  };
  const passed = req.filter((t) => t.latestVerdict === "PASS").length;
  const counts = {
    required: req.length,
    passed,
    failed: req.filter((t) => t.latestVerdict === "FAIL").length,
    blocked: req.filter((t) => t.latestVerdict === "BLOCKED_DEPENDENCY").length,
    notRun: req.filter((t) => t.latestVerdict === "NOT_RUN").length,
    implemented: req.filter((t) => t.implemented).length,
  };
  const milestone = {
    passed,
    total: req.length,
    percent: req.length ? Math.round((passed / req.length) * 1000) / 10 : 0,
    basis: "evidence-based" as const,
  };
  const latestResults = [...allResults]
    .sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))
    .slice(0, 10);

  // ---- reports
  const rd = paths.reportsDir;
  const phaseDirs: string[] = [];
  try {
    for (const d of readdirSync(rd, { withFileTypes: true })) {
      if (d.isDirectory() && /^PHASE-/.test(d.name)) phaseDirs.push(join(rd, d.name));
    }
  } catch {
    notes.push("reports directory missing");
  }
  const reports = {
    phase: reportList(
      paths.bibleDir,
      phaseDirs.flatMap((d) => listFiles(d, REPORT_EXT, true, 200)),
    ),
    blockers: reportList(paths.bibleDir, listFiles(join(rd, "BLOCKERS"), REPORT_EXT, true), true),
    findings: reportList(paths.bibleDir, listFiles(join(rd, "FINDINGS"), REPORT_EXT, true), true),
    decisions: reportList(paths.bibleDir, listFiles(join(rd, "DECISIONS"), REPORT_EXT, true), true),
    tests: reportList(paths.bibleDir, listFiles(testsDir, REPORT_EXT, true, 300)).slice(0, 300),
    handoffs: reportList(paths.bibleDir, listFiles(join(paths.coordDir, "HANDOFFS"), REPORT_EXT, true), true),
  };

  // ---- waiting on the human: OPEN blockers needing the owner + [OPEN] integration-queue entries
  const waiting: WaitingItem[] = [];
  for (const f of listFiles(join(rd, "BLOCKERS"), (n) => n.endsWith(".md"))) {
    try {
      const b = parseBlocker(readFileSync(f, "utf8"));
      if (b.status !== "OPEN" || !needsHuman(b)) continue;
      waiting.push({
        kind: "BLOCKER",
        id: b.id || basename(f, ".md"),
        title: b.title,
        severity: b.severity,
        owner: b.owner,
        status: b.status,
        path: relative(paths.bibleDir, f),
        since: new Date(statSync(f).mtimeMs).toISOString(),
      });
    } catch {
      /* unreadable blocker */
    }
  }
  const qPath = join(paths.coordDir, "INTEGRATION_QUEUE.md");
  if (existsSync(qPath)) {
    for (const q of parseQueue(readFileSync(qPath, "utf8"))) {
      waiting.push({
        kind: "QUEUE",
        id: q.id,
        title: q.title,
        severity: null,
        owner: null,
        status: "OPEN",
        path: relative(paths.bibleDir, qPath),
        since:
          q.ts && !Number.isNaN(Date.parse(q.ts))
            ? new Date(q.ts).toISOString()
            : new Date(statSync(qPath).mtimeMs).toISOString(),
        line: q.line,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    engines,
    agents,
    declaredAgents,
    limits: { ENGINE_A: limit("ENGINE_A", maxA), ENGINE_B: limit("ENGINE_B", maxB) },
    tasks,
    graph,
    events,
    tests,
    gates,
    phases,
    counts,
    milestone,
    latestResults,
    commits,
    waiting,
    reports,
    notes,
    invalid,
  };
}
