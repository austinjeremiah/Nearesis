"use client";
import { CompareOp, type Condition, type MonitorRule } from "@nearesis/contracts";
import { Button } from "@nearesis/ui";
import { useState } from "react";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { describeCondition, fmtSeconds, SourceDot } from "./shared.tsx";

export interface SourceRef {
  id: string;
  freshness: string;
}
const UNITS = [
  { id: "s", label: "seconds", mult: 1 },
  { id: "m", label: "minutes", mult: 60 },
  { id: "h", label: "hours", mult: 3600 },
  { id: "d", label: "days", mult: 86400 },
] as const;
type Unit = (typeof UNITS)[number]["id"];
const OPS: Record<string, string> = {
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
  eq: "equals",
  ne: "differs from",
};

/** Splits seconds into the largest whole unit so the editor round-trips what the backend stored. */
function splitSeconds(s: number): { n: number; u: Unit } {
  for (const u of [...UNITS].reverse()) if (s !== 0 && s % u.mult === 0) return { n: s / u.mult, u: u.id };
  return { n: s, u: "s" };
}
const toSeconds = (n: number, u: Unit) => n * UNITS.find((x) => x.id === u)!.mult;

function Duration(p: {
  label: string;
  testId: string;
  seconds: number;
  max: number;
  onChange: (s: number) => void;
}) {
  const init = splitSeconds(p.seconds);
  const [n, setN] = useState(String(init.n));
  const [u, setU] = useState<Unit>(init.u);
  const commit = (nn: string, uu: Unit) => {
    const v = Number(nn);
    if (Number.isFinite(v) && v >= 0) p.onChange(Math.min(p.max, Math.round(toSeconds(v, uu))));
  };
  return (
    <label className="nz-field-block">
      {p.label}
      <span className="nz-row">
        <input
          className="nz-input"
          inputMode="numeric"
          data-testid={`${p.testId}-value`}
          value={n}
          onChange={(e) => {
            setN(e.target.value);
            commit(e.target.value, u);
          }}
        />
        <select
          className="nz-input"
          aria-label={`${p.label} unit`}
          data-testid={`${p.testId}-unit`}
          value={u}
          onChange={(e) => {
            setU(e.target.value as Unit);
            commit(n, e.target.value as Unit);
          }}
        >
          {UNITS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function RulesTab(p: {
  store: MonitoringStore;
  sources: SourceRef[];
  metrics: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNotice: (m: string) => void;
}) {
  const { store } = p;
  const rules = store.data.rules;
  const sel = rules.find((r) => r.ruleId === p.selectedId) ?? null;
  const [creating, setCreating] = useState(false);
  return (
    <div className="nz-split" data-testid="rules-tab">
      <div className="nz-split-list">
        <Button
          size="sm"
          data-testid="new-rule"
          onClick={() => {
            setCreating(true);
            p.onSelect(null);
          }}
        >
          New rule
        </Button>
        {rules.length === 0 ? (
          <p className="nz-sb-meta" data-testid="rules-empty">
            No monitor rules yet.
          </p>
        ) : (
          <ul className="nz-list" aria-label="Monitor rules">
            {rules.map((r) => {
              const fr = p.sources.find((s) => s.id === r.sourceId)?.freshness;
              return (
                <li key={r.ruleId}>
                  <div className="nz-list-item" data-testid={`rule-row-${r.ruleId}`} data-enabled={r.enabled}>
                    <button
                      type="button"
                      className="nz-linkbtn nz-grow"
                      aria-current={r.ruleId === p.selectedId ? "true" : undefined}
                      onClick={() => {
                        setCreating(false);
                        p.onSelect(r.ruleId);
                      }}
                    >
                      <b>{r.name}</b>
                      <span className="nz-sb-meta"> {describeCondition(r.condition)}</span>
                      <span className="nz-sb-meta" data-testid={`rule-meta-${r.ruleId}`}>
                        {" "}
                        · {r.dataMaturity === "any" ? "any maturity" : "finalized only"}
                        {r.maxRunsPerDay !== null ? ` · max ${r.maxRunsPerDay} runs/day` : ""}
                        {r.semanticVersion ? ` · semantic ${r.semanticVersion}` : ""}
                      </span>
                    </button>
                    {fr && fr !== "fresh" && (
                      <span className="nz-sb-meta" data-testid={`rule-degraded-${r.ruleId}`}>
                        source {fr}
                      </span>
                    )}
                    <Toggle store={store} rule={r} onNotice={p.onNotice} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="nz-split-detail">
        {creating || sel ? (
          <RuleEditor
            key={creating ? "new" : sel!.ruleId + sel!.version}
            rule={creating ? null : sel}
            store={store}
            sources={p.sources}
            metrics={p.metrics}
            onDone={(id) => {
              setCreating(false);
              if (id !== undefined) p.onSelect(id);
            }}
            onNotice={p.onNotice}
          />
        ) : (
          <p className="nz-sb-meta">Select a rule to edit it, or create one.</p>
        )}
      </div>
    </div>
  );
}

function Toggle({
  store,
  rule,
  onNotice,
}: {
  store: MonitoringStore;
  rule: MonitorRule;
  onNotice: (m: string) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={rule.enabled}
      aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.name}`}
      className="nz-switch"
      data-testid={`rule-toggle-${rule.ruleId}`}
      onClick={async () => {
        const r = await store.act((api) => api.setRuleEnabled(rule.ruleId, !rule.enabled));
        if (!r.ok) onNotice(`${r.reasonCode}: ${r.message}`);
      }}
    >
      {rule.enabled ? "Enabled" : "Disabled"}
    </button>
  );
}

function RuleEditor(p: {
  rule: MonitorRule | null;
  store: MonitoringStore;
  sources: SourceRef[];
  metrics: string[];
  onDone: (id?: string | null) => void;
  onNotice: (m: string) => void;
}) {
  const r = p.rule;
  const simple: Extract<Condition, { kind: "compare" | "zscore" }> | null = r
    ? r.condition.kind === "compare" || r.condition.kind === "zscore"
      ? r.condition
      : null
    : { kind: "compare", metricId: "", op: "gt", value: 0 };
  const [kind, setKind] = useState<"compare" | "zscore">(simple?.kind ?? "compare");
  const [windowDays, setWindowDays] = useState(String(simple?.kind === "zscore" ? simple.windowDays : 30));
  const [absGt, setAbsGt] = useState(String(simple?.kind === "zscore" ? simple.absoluteGt : 3));
  const [maturity, setMaturity] = useState<"finalized_only" | "any">(r?.dataMaturity ?? "finalized_only");
  const [maxRuns, setMaxRuns] = useState(r?.maxRunsPerDay != null ? String(r.maxRunsPerDay) : "");
  const [semVer, setSemVer] = useState(r?.semanticVersion ?? "");
  const [name, setName] = useState(r?.name ?? "");
  const [sourceId, setSourceId] = useState(r?.sourceId ?? p.sources[0]?.id ?? "");
  const [metric, setMetric] = useState(simple?.metricId ?? "");
  const [op, setOp] = useState<string>(simple?.kind === "compare" ? simple.op : "gt");
  const [value, setValue] = useState(String(simple?.kind === "compare" ? simple.value : 0));
  const [freq, setFreq] = useState(r?.frequency.minIntervalSeconds ?? 3600);
  const [debounce, setDebounce] = useState(r?.debounceSeconds ?? 0);
  const [cooldown, setCooldown] = useState(r?.cooldownSeconds ?? 3600);
  const [action, setAction] = useState<"notify" | "investigate">(r?.action ?? "notify");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const v = Number(value);
    if (!name.trim()) return setErr("Name is required.");
    if (!sourceId.trim()) return setErr("Choose the source whose watermark drives this rule.");
    const wd = Number(windowDays);
    const ag = Number(absGt);
    if (simple && kind === "compare" && (!metric.trim() || !Number.isFinite(v)))
      return setErr("Metric and a numeric threshold are required.");
    if (simple && kind === "zscore") {
      if (!metric.trim()) return setErr("Metric is required.");
      if (!Number.isInteger(wd) || wd < 2 || wd > 365) return setErr("History window must be 2 to 365 days.");
      if (!Number.isFinite(ag) || ag <= 0) return setErr("The z-score threshold must be above 0.");
    }
    const runs = maxRuns.trim() === "" ? null : Number(maxRuns);
    if (runs !== null && (!Number.isInteger(runs) || runs < 1 || runs > 1000))
      return setErr("Max agent runs per day must be a whole number from 1 to 1000, or empty for no cap.");
    setErr(null);
    setBusy(true);
    const condition: Condition = simple
      ? kind === "zscore"
        ? { kind: "zscore", metricId: metric.trim(), windowDays: wd, absoluteGt: ag }
        : { kind: "compare", metricId: metric.trim(), op: CompareOp.parse(op), value: v }
      : r!.condition;
    const res = await p.store.act((api) =>
      r
        ? api.updateRule({
            ruleId: r.ruleId,
            name: name.trim(),
            condition,
            frequency: { minIntervalSeconds: freq },
            debounceSeconds: debounce,
            cooldownSeconds: cooldown,
            action,
            dataMaturity: maturity,
            maxRunsPerDay: runs,
          })
        : api.createRule({
            name: name.trim(),
            sourceId: sourceId.trim(),
            condition,
            frequency: { minIntervalSeconds: freq },
            debounceSeconds: debounce,
            cooldownSeconds: cooldown,
            action,
            dataMaturity: maturity,
            ...(runs !== null ? { maxRunsPerDay: runs } : {}),
            ...(semVer.trim() ? { semanticVersion: semVer.trim() } : {}),
            enabled: false,
          }),
    );
    setBusy(false);
    if (!res.ok) {
      setErr(`${res.reasonCode}: ${res.message}`);
      p.onNotice(`${res.reasonCode}: ${res.message}`);
      return;
    }
    p.onDone(undefined);
  };
  return (
    <form
      className="nz-form"
      data-testid="rule-editor"
      aria-label={r ? `Edit rule ${r.name}` : "New rule"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="nz-h3">{r ? "Edit rule" : "New rule"}</h3>
      <label className="nz-field-block">
        Name
        <input
          className="nz-input nz-wide"
          data-testid="rule-name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="nz-field-block">
        Source (its watermark drives evaluation)
        <input
          className="nz-input nz-wide"
          list="mon-sources"
          data-testid="rule-source"
          value={sourceId}
          disabled={r !== null}
          onChange={(e) => setSourceId(e.target.value)}
        />
        <datalist id="mon-sources">
          {p.sources.map((s) => (
            <option key={s.id} value={s.id} />
          ))}
        </datalist>
        {sourceId && (
          <span className="nz-sb-meta">
            <SourceDot freshness={p.sources.find((s) => s.id === sourceId)?.freshness} />{" "}
            {p.sources.find((s) => s.id === sourceId)?.freshness ?? "no watermark seen"}
          </span>
        )}
      </label>
      {simple ? (
        <fieldset className="nz-fieldset">
          <legend>Condition</legend>
          <label className="nz-field-block">
            Kind
            <select
              className="nz-input"
              data-testid="rule-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as "compare" | "zscore")}
            >
              <option value="compare">Compare to a value</option>
              <option value="zscore">Unusual versus recent history (z-score)</option>
            </select>
          </label>
          <div className="nz-row">
            <input
              className="nz-input nz-wide"
              list="mon-metrics"
              aria-label="Metric"
              data-testid="rule-metric"
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
            />
            <datalist id="mon-metrics">
              {p.metrics.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {kind === "compare" ? (
              <>
                <select
                  className="nz-input"
                  aria-label="Comparison"
                  data-testid="rule-op"
                  value={op}
                  onChange={(e) => setOp(e.target.value)}
                >
                  {Object.entries(OPS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <input
                  className="nz-input"
                  aria-label="Value"
                  inputMode="decimal"
                  data-testid="rule-value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </>
            ) : (
              <>
                <label className="nz-field-inline">
                  |z| above
                  <input
                    className="nz-input"
                    inputMode="decimal"
                    data-testid="rule-zscore-threshold"
                    value={absGt}
                    onChange={(e) => setAbsGt(e.target.value)}
                  />
                </label>
                <label className="nz-field-inline">
                  over previous days
                  <input
                    className="nz-input"
                    inputMode="numeric"
                    data-testid="rule-zscore-window"
                    value={windowDays}
                    onChange={(e) => setWindowDays(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
        </fieldset>
      ) : (
        <p className="nz-sb-meta" data-testid="rule-condition-readonly">
          Condition (compound, read-only here): {describeCondition(r!.condition)}
        </p>
      )}
      <div className="nz-row nz-row-wrap">
        <Duration
          label="Evaluate at most every"
          testId="rule-frequency"
          seconds={freq}
          max={86400}
          onChange={setFreq}
        />
        <Duration
          label="Must hold for (debounce)"
          testId="rule-debounce"
          seconds={debounce}
          max={86400}
          onChange={setDebounce}
        />
        <Duration
          label="Cooldown after firing"
          testId="rule-cooldown"
          seconds={cooldown}
          max={30 * 86400}
          onChange={setCooldown}
        />
      </div>
      <p className="nz-sb-meta" data-testid="rule-summary">
        Evaluated at most every {fmtSeconds(freq)}; debounce {fmtSeconds(debounce)}; cooldown{" "}
        {fmtSeconds(cooldown)}.
      </p>
      <label className="nz-field-block">
        Data maturity
        <select
          className="nz-input"
          data-testid="rule-maturity"
          value={maturity}
          onChange={(e) => setMaturity(e.target.value as "finalized_only" | "any")}
        >
          <option value="finalized_only">Finalized data only (provisional watermarks are skipped)</option>
          <option value="any">Any data, including provisional</option>
        </select>
      </label>
      <label className="nz-field-block">
        Max agent runs per UTC day (empty for no cap)
        <input
          className="nz-input"
          inputMode="numeric"
          data-testid="rule-max-runs"
          value={maxRuns}
          onChange={(e) => setMaxRuns(e.target.value)}
        />
      </label>
      <label className="nz-field-block">
        Semantic version the rule was written against
        <input
          className="nz-input"
          data-testid="rule-semver"
          value={semVer}
          disabled={r !== null}
          placeholder="for example 1.2.0"
          onChange={(e) => setSemVer(e.target.value)}
        />
      </label>
      <label className="nz-field-block">
        When it fires
        <select
          className="nz-input"
          data-testid="rule-action"
          value={action}
          onChange={(e) => setAction(e.target.value as "notify" | "investigate")}
        >
          <option value="notify">Notify only</option>
          <option value="investigate">Notify and start a scoped investigation</option>
        </select>
      </label>
      {!r && (
        <p className="nz-sb-meta">
          New rules are created disabled; enable them from the list once the settings look right.
        </p>
      )}
      {err && (
        <p role="alert" className="nz-error" data-testid="rule-error">
          {err}
        </p>
      )}
      <div className="nz-page-actions">
        <Button type="submit" variant="primary" size="sm" data-testid="rule-save" disabled={busy}>
          {r ? "Save changes" : "Create rule"}
        </Button>
        <Button size="sm" onClick={() => p.onDone(r?.ruleId ?? null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
