/**
 * Evidence-graph side panels backed by the kernel's read routes:
 *  - PublicationPanel (W08): claims excluded from supported publication, each with its missing provenance;
 *  - ImpactPanel (W09): dependents of a metric's version change, ACL-filtered by the server (hidden nodes are simply
 *    absent), with dependency cycles listed;
 *  - EvidenceRecord (W18): the dereferenced item; a tombstone shows metadata only (hash, deletion time, reason).
 */
import { useEffect, useState } from "react";
import type { GraphProjection } from "@nearesis/contracts";
import { ApiError, evidenceApi, getJson } from "../history/client.ts";
import e from "./evidence.module.css";

interface Eligibility {
  graphVersion: number;
  supportedClaimIds: string[];
  publicationEligibleIds: string[];
  unsupportedSection: { label: string; claims: Array<{ claimId: string; label: string; missing: string[] }> };
}

const describe = (err: unknown) => (err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));

export function PublicationPanel({
  workspaceId,
  graphVersion,
  onPick,
}: {
  workspaceId: string;
  graphVersion: number;
  onPick: (id: string) => void;
}) {
  const [el, setEl] = useState<Eligibility | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getJson<Eligibility>(`${evidenceApi(workspaceId)}/publication-eligibility`)
      .then((x) => (setEl(x), setErr(null)))
      .catch((x) => setErr(describe(x)));
  }, [workspaceId, graphVersion]);
  return (
    <section className={e.notice} aria-labelledby="h-pub" data-testid="publication-panel">
      <h3 className={e.h3} id="h-pub">
        Publication
      </h3>
      {err ? (
        <p data-testid="publication-error">Publication eligibility unavailable ({err}).</p>
      ) : !el ? (
        <p className={e.muted}>Checking…</p>
      ) : (
        <>
          <p data-testid="publication-supported">
            {el.supportedClaimIds.length} supported claim(s) may be published as supported.
          </p>
          <div data-testid="publication-unsupported">
            <strong>
              {el.unsupportedSection.label.startsWith("UNSUPPORTED")
                ? "UNSUPPORTED"
                : el.unsupportedSection.label}
            </strong>
            <span className={e.muted}>
              {" "}
              · excluded from supported publication ({el.unsupportedSection.claims.length})
            </span>
            <ul>
              {el.unsupportedSection.claims.map((c) => (
                <li key={c.claimId} data-testid={`unsupported-${c.claimId}`}>
                  <button type="button" className={e.linkBtn} onClick={() => onPick(c.claimId)}>
                    {c.label}
                  </button>
                  {c.missing.length ? (
                    <span className={e.muted}>
                      {" "}
                      missing: <span data-testid="unsupported-missing">{c.missing.join(", ")}</span>
                    </span>
                  ) : (
                    <span className={e.muted}> no supporting evidence path</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

interface Impact {
  metricId: string;
  currentVersion: string | null;
  roots: string[];
  affected: Array<{ nodeId: string; depth: number }>;
  cycles: string[][];
  truncated: boolean;
}

export function ImpactPanel({
  workspaceId,
  graph,
  onPick,
}: {
  workspaceId: string;
  graph: GraphProjection;
  onPick: (id: string) => void;
}) {
  const [metric, setMetric] = useState("");
  const [res, setRes] = useState<Impact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const run = async () => {
    setErr(null);
    setRes(null);
    try {
      setRes(
        await getJson<Impact>(`${evidenceApi(workspaceId)}/impact/${encodeURIComponent(metric.trim())}`),
      );
    } catch (x) {
      setErr(describe(x));
    }
  };
  return (
    <section className={e.notice} aria-labelledby="h-imp" data-testid="impact-panel">
      <h3 className={e.h3} id="h-imp">
        Impact of a metric change
      </h3>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (metric.trim()) void run();
        }}
      >
        <label htmlFor="impact-metric" className="nz-sr-only">
          Metric id
        </label>
        <input
          id="impact-metric"
          className="nz-input"
          placeholder="metric id, e.g. prices.daily_close_price_usd"
          value={metric}
          onChange={(ev) => setMetric(ev.target.value)}
          data-testid="impact-metric"
        />{" "}
        <button type="submit" className="nz-btn" disabled={!metric.trim()} data-testid="impact-run">
          Analyse
        </button>
      </form>
      {err ? <p data-testid="impact-error">Impact unavailable ({err}).</p> : null}
      {res ? (
        <div data-testid="impact-result">
          <p>
            Current version <code className={e.mono}>{res.currentVersion ?? "none recorded"}</code>.{" "}
            <span data-testid="impact-counts">
              {res.roots.length} pinned to an older version, {res.affected.length} affected in total
            </span>
            {res.truncated ? " (walk truncated at the depth limit)" : ""}.
          </p>
          <ol className={e.links} data-testid="impact-affected">
            {[...res.affected]
              .sort((a, b) => a.depth - b.depth || labelOf(a.nodeId).localeCompare(labelOf(b.nodeId)))
              .map((a) => (
                <li key={a.nodeId} data-testid={`impact-node-${a.nodeId}`} data-depth={a.depth}>
                  <button type="button" className={e.linkBtn} onClick={() => onPick(a.nodeId)}>
                    {labelOf(a.nodeId)}
                  </button>{" "}
                  <span className={e.muted}>
                    depth {a.depth}
                    {res.roots.includes(a.nodeId) ? " · pinned to an older version" : ""}
                  </span>
                </li>
              ))}
          </ol>
          {res.cycles.length ? (
            <div data-testid="impact-cycles">
              <strong>Dependency cycles ({res.cycles.length})</strong>
              <ul>
                {res.cycles.map((cy) => (
                  <li key={cy.join(",")} data-testid="impact-cycle">
                    {cy.map(labelOf).join(" → ")} → {labelOf(cy[0]!)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={e.muted} data-testid="impact-no-cycles">
              No dependency cycles.
            </p>
          )}
          <p className={e.muted}>Only nodes you are allowed to see are listed.</p>
        </div>
      ) : null}
    </section>
  );
}

type Deref =
  | {
      nodeId: string;
      tombstone: true;
      kind: string;
      contentHash: string | null;
      deletedAt: string | null;
      reason: string | null;
    }
  | { nodeId: string; tombstone: false; publicAsset: { id: string; contentHash: string; title: string } }
  | {
      nodeId: string;
      tombstone: false;
      kind: string;
      label: string;
      data: unknown;
      rawObjectHash: string | null;
    };

export function EvidenceRecord({ workspaceId, nodeId }: { workspaceId: string; nodeId: string }) {
  const [d, setD] = useState<Deref | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    setErr(null);
    getJson<Deref>(`${evidenceApi(workspaceId)}/evidence/${nodeId}`)
      .then(setD)
      .catch((x) => setErr(describe(x)));
  }, [workspaceId, nodeId]);
  if (err)
    return (
      <p className={e.muted} data-testid="evidence-record-error">
        Stored item unavailable ({err}).
      </p>
    );
  if (!d) return null;
  if (d.tombstone)
    return (
      <div className={e.stateBox} data-state="tombstone" data-testid="evidence-record" data-tombstone="true">
        <strong>Payload deleted (tombstone).</strong> Only metadata is kept.
        <dl>
          <dt>Content hash</dt>
          <dd className={e.mono} data-testid="tombstone-hash">
            {d.contentHash ?? "not recorded"}
          </dd>
          <dt>Deleted</dt>
          <dd data-testid="tombstone-deleted">{d.deletedAt ?? "unknown"}</dd>
          <dt>Reason</dt>
          <dd data-testid="tombstone-reason">{d.reason ?? "not recorded"}</dd>
        </dl>
      </div>
    );
  if ("publicAsset" in d)
    return (
      <p data-testid="evidence-record" data-tombstone="false">
        Public asset <strong>{d.publicAsset.title}</strong>{" "}
        <code className={e.mono}>{d.publicAsset.contentHash.slice(0, 16)}…</code>
      </p>
    );
  return (
    <p className={e.muted} data-testid="evidence-record" data-tombstone="false">
      Stored item
      {d.rawObjectHash ? (
        <>
          {" "}
          with raw payload <code className={e.mono}>{d.rawObjectHash.slice(0, 16)}…</code>
        </>
      ) : null}
      .
    </p>
  );
}
