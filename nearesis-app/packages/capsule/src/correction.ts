import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCapsule } from "./build.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { readManifest } from "./verify.ts";

/**
 * Metric correction workflow (V18, ch.17 "Post-deployment incident playbook": freeze publication, invalidate the affected
 * semantic version, identify dependent capsules, halt corresponding monitors, publish a correction event, rerun from raw
 * snapshots).
 *
 * State lives in one directory so it is durable and inspectable:
 *   registry.json       semantic metric versions and their status
 *   capsule-index.json  capsule id, dir, hash, metric versions, status, supersededBy
 *   monitors.json       monitor id, metric, version, state
 *   publication.json    frozen metric versions and published capsules
 *   events.jsonl        APPEND-ONLY, hash-chained. A correction is a compensating event; no event is ever edited or removed.
 *
 * Monitors are reached through this file-backed registry. Wiring `halt` to the kernel's `monitor.rule_disable` command is a
 * separate adapter (see INTEGRATION_QUEUE), so this module proves the workflow, not the kernel integration.
 */
export interface EventRecord {
  id: string;
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
  /** Ids of earlier events this event corrects or builds on. */
  lineage: string[];
  prevHash: string;
  hash: string;
}
export interface IndexedCapsule {
  capsuleId: string;
  dir: string;
  capsuleHash: string;
  metricVersions: Record<string, string>;
  status: "current" | "superseded";
  supersededBy: string | null;
}
export interface MonitorState {
  id: string;
  metric: string;
  version: string;
  state: "active" | "halted";
  haltReason: string | null;
}
export interface MetricVersion {
  metric: string;
  version: string;
  status: "current" | "incorrect";
  correctedBy: string | null;
}
export interface EvaluationRow {
  monitorId: string;
  at: string;
  status: "task_created" | "no_trigger" | "skipped_halted";
}

export class PublicationFrozenError extends Error {
  constructor(
    readonly capsuleId: string,
    readonly reason: string,
  ) {
    super(`publication of ${capsuleId} is blocked: ${reason}`);
  }
}

const GENESIS = "0".repeat(64);

export class CorrectionWorkflow {
  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
  }
  private path = (f: string): string => join(this.dir, f);
  private read<T>(f: string, empty: T): T {
    return existsSync(this.path(f)) ? (JSON.parse(readFileSync(this.path(f), "utf8")) as T) : empty;
  }
  private save(f: string, v: unknown): void {
    writeFileSync(this.path(f), `${JSON.stringify(v, null, 1)}\n`);
  }

  // ---- events ----
  events(): EventRecord[] {
    return existsSync(this.path("events.jsonl"))
      ? readFileSync(this.path("events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as EventRecord)
      : [];
  }
  append(type: string, payload: Record<string, unknown>, lineage: string[] = []): EventRecord {
    const all = this.events();
    const prev = all[all.length - 1];
    const body = {
      id: `evt-${String(all.length + 1).padStart(4, "0")}`,
      seq: all.length + 1,
      type,
      at: this.clock().toISOString(),
      payload,
      lineage,
      prevHash: prev?.hash ?? GENESIS,
    };
    const rec: EventRecord = { ...body, hash: sha256Hex(canonicalJson(body)) };
    appendFileSync(this.path("events.jsonl"), `${JSON.stringify(rec)}\n`);
    return rec;
  }
  /** The chain is intact when every event hashes to its recorded hash and links to its predecessor. */
  verifyEventChain(): { ok: boolean; brokenAt: string | null } {
    let prev = GENESIS;
    for (const e of this.events()) {
      const { hash, ...body } = e;
      if (e.prevHash !== prev || sha256Hex(canonicalJson(body)) !== hash)
        return { ok: false, brokenAt: e.id };
      prev = hash;
    }
    return { ok: true, brokenAt: null };
  }

  // ---- registry, index, monitors ----
  registerMetric(metric: string, version: string): void {
    const r = this.read<MetricVersion[]>("registry.json", []);
    r.push({ metric, version, status: "current", correctedBy: null });
    this.save("registry.json", r);
    this.append("metric.registered", { metric, version });
  }
  metrics = (): MetricVersion[] => this.read<MetricVersion[]>("registry.json", []);
  index = (): IndexedCapsule[] => this.read<IndexedCapsule[]>("capsule-index.json", []);
  monitors = (): MonitorState[] => this.read<MonitorState[]>("monitors.json", []);
  private frozen = (): string[] =>
    this.read<{ frozen: string[]; published: string[] }>("publication.json", { frozen: [], published: [] })
      .frozen;
  published = (): string[] =>
    this.read<{ frozen: string[]; published: string[] }>("publication.json", { frozen: [], published: [] })
      .published;

  indexCapsule(capsuleDir: string): IndexedCapsule {
    const m = readManifest(capsuleDir);
    if (!m) throw new Error("cannot index: manifest is invalid");
    const entry: IndexedCapsule = {
      capsuleId: m.capsuleId,
      dir: capsuleDir,
      capsuleHash: m.capsuleHash,
      metricVersions: m.metricVersions ?? {},
      status: "current",
      supersededBy: null,
    };
    this.save("capsule-index.json", [...this.index(), entry]);
    this.append("capsule.indexed", {
      capsuleId: entry.capsuleId,
      capsuleHash: entry.capsuleHash,
      metricVersions: entry.metricVersions,
    });
    return entry;
  }
  registerMonitor(id: string, metric: string, version: string): void {
    this.save("monitors.json", [
      ...this.monitors(),
      { id, metric, version, state: "active", haltReason: null } satisfies MonitorState,
    ]);
    this.append("monitor.registered", { id, metric, version });
  }

  // ---- publication gate ----
  publishBlockReason(capsuleId: string): string | null {
    const c = this.index().find((x) => x.capsuleId === capsuleId);
    if (!c) return "unknown capsule";
    if (c.status === "superseded") return `superseded by ${c.supersededBy}`;
    const bad = Object.entries(c.metricVersions).find(([m, v]) => this.frozen().includes(`${m}@${v}`));
    return bad ? `depends on frozen metric ${bad[0]}@${bad[1]}` : null;
  }
  publish(capsuleId: string): EventRecord {
    const why = this.publishBlockReason(capsuleId);
    if (why) throw new PublicationFrozenError(capsuleId, why);
    const pub = this.read<{ frozen: string[]; published: string[] }>("publication.json", {
      frozen: [],
      published: [],
    });
    pub.published.push(capsuleId);
    this.save("publication.json", pub);
    return this.append("capsule.published", { capsuleId });
  }

  // ---- the correction ----
  declareIncorrect(o: { metric: string; version: string; correctedVersion: string; reason: string }): {
    frozen: string;
    impactedCapsules: string[];
    haltedMonitors: string[];
    correctionEvent: EventRecord;
  } {
    const key = `${o.metric}@${o.version}`;
    // 1. freeze publication (first, so nothing can slip through while the rest runs)
    const pub = this.read<{ frozen: string[]; published: string[] }>("publication.json", {
      frozen: [],
      published: [],
    });
    if (!pub.frozen.includes(key)) pub.frozen.push(key);
    this.save("publication.json", pub);
    // 2. invalidate the semantic version
    const reg = this.metrics().map((r) =>
      r.metric === o.metric && r.version === o.version
        ? { ...r, status: "incorrect" as const, correctedBy: o.correctedVersion }
        : r,
    );
    this.save("registry.json", reg);
    // 3. dependent capsules (exactly those computed under this metric version)
    const impacted = this.index()
      .filter((c) => c.metricVersions[o.metric] === o.version)
      .map((c) => c.capsuleId);
    // 4. halt the monitors on that metric version, and only those
    const halted: string[] = [];
    this.save(
      "monitors.json",
      this.monitors().map((mo) => {
        if (mo.metric === o.metric && mo.version === o.version && mo.state === "active") {
          halted.push(mo.id);
          return { ...mo, state: "halted" as const, haltReason: `metric ${key} corrected` };
        }
        return mo;
      }),
    );
    // 5. one compensating event, lineage to the original events about this metric and its capsules
    const lineage = this.events()
      .filter(
        (e) =>
          (e.type === "metric.registered" &&
            e.payload.metric === o.metric &&
            e.payload.version === o.version) ||
          (e.type === "capsule.published" && impacted.includes(String(e.payload.capsuleId))) ||
          (e.type === "capsule.indexed" && impacted.includes(String(e.payload.capsuleId))),
      )
      .map((e) => e.id);
    const correctionEvent = this.append(
      "metric.corrected",
      {
        metric: o.metric,
        incorrectVersion: o.version,
        correctedVersion: o.correctedVersion,
        reason: o.reason,
        impactedCapsules: impacted,
        haltedMonitors: halted,
      },
      lineage,
    );
    return { frozen: key, impactedCapsules: impacted, haltedMonitors: halted, correctionEvent };
  }

  /** Rerun every impacted capsule from its raw snapshot under the corrected metric version. Old capsules are kept. */
  rerun(o: {
    metric: string;
    incorrectVersion: string;
    correctedVersion: string;
    snapshotDirs: Record<string, string>;
    outRoot: string;
  }): Array<{ oldId: string; newId: string; newHash: string; dir: string }> {
    const out: Array<{ oldId: string; newId: string; newHash: string; dir: string }> = [];
    for (const old of this.index().filter(
      (c) => c.metricVersions[o.metric] === o.incorrectVersion && c.status === "current",
    )) {
      const snap = o.snapshotDirs[old.capsuleId];
      if (!snap) throw new Error(`no raw snapshot recorded for ${old.capsuleId}`);
      const newId = `${old.capsuleId}-r${o.correctedVersion.replace(/\./g, "-")}`;
      const dir = join(o.outRoot, newId);
      const m = buildCapsule({
        snapshotDir: snap,
        outDir: dir,
        capsuleId: newId,
        metricVersions: { ...old.metricVersions, [o.metric]: o.correctedVersion },
      });
      const entry = this.indexCapsule(dir);
      const idx = this.index().map((c) =>
        c.capsuleId === old.capsuleId ? { ...c, status: "superseded" as const, supersededBy: newId } : c,
      );
      this.save("capsule-index.json", idx);
      this.append(
        "capsule.superseded",
        { capsuleId: old.capsuleId, supersededBy: newId, newCapsuleHash: m.capsuleHash },
        this.events()
          .filter((e) => e.payload.capsuleId === old.capsuleId)
          .map((e) => e.id),
      );
      out.push({ oldId: old.capsuleId, newId, newHash: entry.capsuleHash, dir });
    }
    return out;
  }

  // ---- monitors ----
  evaluations = (): EvaluationRow[] => this.read<EvaluationRow[]>("evaluations.json", []);
  /**
   * One monitor evaluation. The halted state is re-read from the registry at the side-effect point, after the (possibly
   * slow) evaluation, so a halt that lands while an evaluation is in flight still prevents the task.
   */
  async runMonitor(
    id: string,
    evaluate: () => Promise<boolean>,
    createTask: () => void,
  ): Promise<EvaluationRow["status"]> {
    const triggered = await evaluate();
    const state = this.monitors().find((m) => m.id === id)?.state ?? "halted";
    const status: EvaluationRow["status"] =
      state === "halted" ? "skipped_halted" : triggered ? "task_created" : "no_trigger";
    if (status === "task_created") createTask();
    this.save("evaluations.json", [
      ...this.evaluations(),
      { monitorId: id, at: this.clock().toISOString(), status } satisfies EvaluationRow,
    ]);
    return status;
  }

  /** Historical capsules must still exist and keep their recorded hash. */
  historicalIntact(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    for (const c of this.index()) {
      const m = existsSync(c.dir) ? readManifest(c.dir) : null;
      if (!m) problems.push(`${c.capsuleId}: capsule directory is missing or invalid`);
      else if (m.capsuleHash !== c.capsuleHash) problems.push(`${c.capsuleId}: hash changed`);
    }
    return { ok: problems.length === 0, problems };
  }
}
