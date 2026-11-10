import { useState } from "react";
import type { GateView } from "./types.ts";
import { GATE_NAMES, OUTSIDE_PHASES, gatePill, pct, useWidth } from "./util.ts";

const TRACK_H = 24;
const GRID = [0, 0.25, 0.5, 0.75, 1];

interface Tip {
  g: GateView;
  x: number;
  y: number;
}

/** Nested-bar phase completion: outer = implemented, middle = executed, inner = passed at a commit. */
export function PhaseChart({ gates }: { gates: GateView[] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const narrow = width < 520;
  const trackW = Math.max(120, width - (narrow ? 170 : 470));

  const move = (g: GateView, e: React.MouseEvent | React.FocusEvent): void => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const cx = "clientX" in e ? e.clientX : box.left + 40;
    const cy = "clientY" in e ? e.clientY : box.top + 40;
    setTip({
      g,
      x: Math.min(Math.max(8, cx - box.left + 12), Math.max(8, box.width - 230)),
      y: Math.max(0, cy - box.top + 14),
    });
  };

  return (
    <div className="chart-wrap" ref={wrapRef} onMouseLeave={() => setTip(null)}>
      <div className="legend">
        <span>
          <i className="sw sw-impl" />
          Implemented (test file bound)
        </span>
        <span>
          <i className="sw sw-exec" />
          Executed (any verdict recorded)
        </span>
        <span>
          <i className="sw sw-pass" />
          Passed at a commit
        </span>
        <span>
          <i className="sw sw-fail" />
          Failed
        </span>
        <span>
          <i className="sw sw-blocked" />
          Blocked dependency
        </span>
      </div>
      <div
        role="img"
        aria-label="Phase completion: implemented, executed and passed share of tests per gate"
        className="rows"
      >
        {gates.map((g) => {
          const pill = gatePill(g);
          const bar = (n: number): number => pct(n, g.total) * trackW;
          return (
            <div
              key={g.gate}
              className={`prow ${g.lockedBy.length ? "locked" : ""}`}
              data-testid={`phase-row-${g.gate}`}
              tabIndex={0}
              onMouseMove={(e) => move(g, e)}
              onFocus={(e) => move(g, e)}
              onBlur={() => setTip(null)}
            >
              <div className="plabel">
                <b>{g.gate}</b>
                {!narrow && <span className="muted"> {GATE_NAMES[g.gate] ?? ""}</span>}
              </div>
              <svg width={trackW} height={TRACK_H + 4} aria-hidden="true" className="ptrack">
                {GRID.map((v) => (
                  <line key={v} x1={v * trackW} x2={v * trackW} y1={0} y2={TRACK_H + 4} className="grid" />
                ))}
                <rect x={0} y={2} width={bar(g.implemented)} height={TRACK_H} rx={4} className="b-impl" />
                <rect x={0} y={7} width={bar(g.executed)} height={TRACK_H - 10} rx={3} className="b-exec" />
                <g data-testid={`inner-${g.gate}`} data-passed={g.passed} data-total={g.total}>
                  <rect
                    x={0}
                    y={10}
                    width={bar(g.passed)}
                    height={TRACK_H - 16}
                    rx={2}
                    className="b-pass"
                    data-testid={`pass-bar-${g.gate}`}
                  />
                  {g.failed > 0 && (
                    <rect
                      x={bar(g.passed)}
                      y={10}
                      width={Math.max(3, bar(g.failed))}
                      height={TRACK_H - 16}
                      className="b-fail"
                    />
                  )}
                  {g.blocked > 0 && (
                    <rect
                      x={bar(g.passed + g.failed)}
                      y={10}
                      width={Math.max(3, bar(g.blocked))}
                      height={TRACK_H - 16}
                      className="b-blocked"
                    />
                  )}
                </g>
              </svg>
              <div className="pmeta">
                <span className="count">
                  {g.passed}/{g.total}
                </span>
                <span className={`pill pill-${pill}`}>{pill}</span>
                {g.lockedBy.length > 0 && (
                  <span className="lock" title={`Complete ${g.lockedBy.join(", ")} first`}>
                    <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
                      <rect x="1" y="5" width="9" height="6.5" rx="1.5" fill="currentColor" />
                      <path
                        d="M3 5V3.5a2.5 2.5 0 015 0V5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                    </svg>
                    {narrow ? "" : ` waits on ${g.lockedBy.join(", ")}`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {OUTSIDE_PHASES.map((p) => (
          <div key={p} className="prow outside" data-testid={`phase-outside-${p}`}>
            <div className="plabel">
              <b>{p}</b>
              {!narrow && <span className="muted"> outside milestone</span>}
            </div>
            <svg width={trackW} height={TRACK_H + 4} aria-hidden="true" className="ptrack">
              {GRID.map((v) => (
                <line key={v} x1={v * trackW} x2={v * trackW} y1={0} y2={TRACK_H + 4} className="grid" />
              ))}
            </svg>
            <div className="pmeta">
              <span className="muted">{narrow ? "n/a" : "not in the 87-test milestone"}</span>
            </div>
          </div>
        ))}
        <div className="axis" style={{ marginLeft: narrow ? 52 : 178, width: trackW }}>
          {(narrow ? [0, 0.5, 1] : GRID).map((v) => (
            <span key={v} style={{ left: `${v * 100}%` }}>
              {v * 100}%
            </span>
          ))}
        </div>
      </div>
      {tip && (
        <div className="tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <b>
            {tip.g.gate} {GATE_NAMES[tip.g.gate]}
          </b>
          <div>
            Total {tip.g.total} · implemented {tip.g.implemented}
          </div>
          <div>
            Executed {tip.g.executed} · passed {tip.g.passed}
          </div>
          <div>
            Failed {tip.g.failed} · blocked {tip.g.blocked}
          </div>
          <div className="muted">
            Needs: {tip.g.upstream.join(", ") || "nothing"}
            {tip.g.lockedBy.length ? ` (waiting on ${tip.g.lockedBy.join(", ")})` : ""}
          </div>
        </div>
      )}
      <table className="sr-only">
        <caption>Phase completion by gate</caption>
        <thead>
          <tr>
            <th>Gate</th>
            <th>Total</th>
            <th>Implemented</th>
            <th>Executed</th>
            <th>Passed</th>
            <th>Failed</th>
            <th>Blocked</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {gates.map((g) => (
            <tr key={g.gate}>
              <td>{g.gate}</td>
              <td>{g.total}</td>
              <td>{g.implemented}</td>
              <td>{g.executed}</td>
              <td>{g.passed}</td>
              <td>{g.failed}</td>
              <td>{g.blocked}</td>
              <td>{gatePill(g)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
