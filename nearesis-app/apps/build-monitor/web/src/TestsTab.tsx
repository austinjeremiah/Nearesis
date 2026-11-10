import { useEffect, useRef, useState } from "react";
import type { State, TestView } from "./types.ts";
import { GATE_NAMES, ageOf, gatePill } from "./util.ts";

export function cellClass(t: TestView): string {
  if (!t.required) return "c-hist";
  if (t.latestVerdict === "PASS") return t.staleEvidence ? "c-pass c-stale" : "c-pass";
  if (t.latestVerdict === "FAIL") return "c-fail";
  if (t.latestVerdict === "BLOCKED_DEPENDENCY") return "c-blocked";
  return t.implemented ? "c-impl" : "c-none";
}

const VERDICT_FILTERS = ["All", "PASS", "FAIL", "BLOCKED_DEPENDENCY", "NOT_RUN"];

export function TestsTab({
  s,
  now,
  focusGate,
  openTest,
}: {
  s: State;
  now: number;
  focusGate: string | null;
  openTest: (t: TestView) => void;
}) {
  const [verdict, setVerdict] = useState("All");
  const [engine, setEngine] = useState("All");
  const [tip, setTip] = useState<{ t: TestView; x: number; y: number } | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const engines = ["All", ...new Set(s.tests.map((t) => t.owner).filter(Boolean))];
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusGate]);
  const keep = (t: TestView): boolean =>
    (verdict === "All" || t.latestVerdict === verdict) && (engine === "All" || t.owner === engine);
  return (
    <section className="card">
      <h2>Test matrix ({s.tests.length})</h2>
      <div className="chips" role="group" aria-label="Filter by verdict">
        {VERDICT_FILTERS.map((v) => (
          <button
            key={v}
            className={`chip ${verdict === v ? "on" : ""}`}
            aria-pressed={verdict === v}
            onClick={() => setVerdict(v)}
          >
            {v.replace("_DEPENDENCY", "")}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Filter by engine">
        {engines.map((e) => (
          <button
            key={e}
            className={`chip ${engine === e ? "on" : ""}`}
            aria-pressed={engine === e}
            onClick={() => setEngine(e)}
          >
            {e.replace("ENGINE_", "Engine ")}
          </button>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="cellkey c-pass" />
          PASS
        </span>
        <span>
          <i className="cellkey c-fail" />
          FAIL
        </span>
        <span>
          <i className="cellkey c-blocked" />
          BLOCKED
        </span>
        <span>
          <i className="cellkey c-pass c-stale" />
          PASS, commit not in recent history
        </span>
        <span>
          <i className="cellkey c-impl" />
          implemented, not run
        </span>
        <span>
          <i className="cellkey c-none" />
          not implemented
        </span>
        <span>
          <i className="cellkey c-hist" />
          historical (not required)
        </span>
      </div>
      {s.tests.length === 0 && <p className="muted">No test index.</p>}
      {s.gates.map((g) => (
        <div
          key={g.gate}
          className={`mrow ${focusGate === g.gate ? "focus" : ""}`}
          ref={focusGate === g.gate ? focusRef : undefined}
          data-testid={`matrix-${g.gate}`}
        >
          <div className="mlabel">
            <b>{g.gate}</b>
            <span className="muted">{GATE_NAMES[g.gate]}</span>
            <span className={`pill pill-${gatePill(g)}`}>
              {g.passed}/{g.total}
            </span>
          </div>
          <div className="cells">
            {s.tests
              .filter((t) => t.gate === g.gate && keep(t))
              .map((t) => (
                <button
                  key={t.testId}
                  className={`cell ${cellClass(t)}`}
                  data-testid={`test-${t.testId}`}
                  aria-label={`${t.testId} ${t.name}: ${t.latestVerdict}${t.implemented ? "" : ", not implemented"}`}
                  onClick={() => openTest(t)}
                  onMouseEnter={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTip(null)}
                  onFocus={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTip({ t, x: r.left, y: r.bottom });
                  }}
                  onBlur={() => setTip(null)}
                >
                  {t.testId}
                </button>
              ))}
          </div>
        </div>
      ))}
      {tip && (
        <div
          className="tip fixed"
          role="tooltip"
          style={{ left: Math.min(tip.x + 12, window.innerWidth - 300), top: tip.y + 14 }}
        >
          <b>{tip.t.testId}</b> {tip.t.name}
          <div className="muted">
            {tip.t.passCondition.slice(0, 140)}
            {tip.t.passCondition.length > 140 ? "…" : ""}
          </div>
          <div>
            {tip.t.latestVerdict}
            {tip.t.executedAt ? ` · ${ageOf(tip.t.executedAt, now)}` : ""}
            {tip.t.latestCommit ? ` · ${tip.t.latestCommit.slice(0, 7)}` : ""}
          </div>
          {!tip.t.implemented && <div className="muted">not implemented</div>}
          {!tip.t.required && (
            <div className="muted">
              historical{tip.t.supersededBy ? `, superseded by ${tip.t.supersededBy}` : ""}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
