import { useState } from "react";
import type { ReportItem, State } from "./types.ts";
import { ageOf } from "./util.ts";

export function ReportsTab({ s, now, openFile }: { s: State; now: number; openFile: (p: string) => void }) {
  const [q, setQ] = useState("");
  const groups: [string, ReportItem[]][] = [
    ["Phase reports", s.reports.phase],
    ["Blockers", s.reports.blockers],
    ["Findings", s.reports.findings],
    ["Decisions", s.reports.decisions],
    ["Handoffs", s.reports.handoffs],
    ["Test evidence", s.reports.tests],
  ];
  const needle = q.trim().toLowerCase();
  const match = (r: ReportItem): boolean =>
    !needle || `${r.name} ${r.title ?? ""} ${r.status ?? ""}`.toLowerCase().includes(needle);
  return (
    <section className="card">
      <h2>Reports</h2>
      <input
        className="search"
        type="search"
        placeholder="Search reports"
        aria-label="Search reports"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="grid3">
        {groups.map(([title, items]) => {
          const list = items.filter(match);
          return (
            <details key={title} open={title !== "Test evidence" || needle !== ""}>
              <summary>
                {title} ({list.length})
              </summary>
              {list.length === 0 ? (
                <p className="muted">none</p>
              ) : (
                <ul className="rowlist">
                  {list.slice(0, 80).map((r) => (
                    <li key={r.path}>
                      <button className="rowbtn" onClick={() => openFile(r.path)}>
                        {r.status && <span className={`pill pill-st-${r.status}`}>{r.status}</span>}
                        <span className="grow">{r.title ?? r.name}</span>
                        <span className="muted">{ageOf(r.mtime, now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
