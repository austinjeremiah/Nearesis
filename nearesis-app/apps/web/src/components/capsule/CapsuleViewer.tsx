"use client";
import "../../lib/zod-config.ts"; // jitless zod: no eval probe under the strict CSP
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, HonestyBanner, ProvenanceChip } from "@nearesis/ui";
import { Claim, ClaimLegend } from "../thesis/ClaimTag.tsx";
import { CapsuleResponseRecord } from "@nearesis/contracts";
import { type CapsuleResponse, type CapsuleView, type ClaimClass, proofStatus } from "../thesis/model.ts";

/** Capsule contract claim classes -> the dashboard's five display classes. */
const CLASS_OF: Record<CapsuleView["claims"][number]["claimClass"], ClaimClass> = {
  observed_fact: "observed",
  derived_statistic: "derived",
  agent_interpretation: "interpretation",
  hypothesis: "hypothesis",
  unsupported: "unsupported",
};
/** Export hrefs in the record are kernel API paths; the browser reaches them through the same-origin BFF. */
const exportHref = (href: string) => (href.startsWith("/v1/capsules/") ? `/api/k/${href.slice(4)}` : null);
import s from "../thesis/thesis.module.css";

/**
 * Research capsule presentation. Verification results are displayed exactly as recorded by Engine A's verifier; the
 * browser performs no verification of its own and never upgrades a status.
 */
function Verification({ c }: { c: CapsuleView }) {
  const st = proofStatus(c.verification);
  const v = c.verification;
  const last =
    [v.local.checkedAt, v.outlayer.checkedAt]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  return (
    <section className={s.section} aria-labelledby="h-verify">
      <div className={s.sectionHead}>
        <h2 id="h-verify">Verification</h2>
        <span className={s.metricSub} data-testid="last-verified">
          Last verified: {last ?? "never"}
        </span>
      </div>
      <p className={s.sectionNote}>
        Local reproducibility means the same inputs and code rebuilt the same result hash on a machine we
        control. OutLayer-backed proof means a TEE attestation of the computation was cryptographically
        verified. They are different claims; neither proves the source data is correct.
      </p>
      <div className={s.grid2}>
        <div className={s.proof} data-status={st.local} data-testid="proof-local">
          <span className={s.eyebrow}>Local reproducibility</span>
          <span
            className={`${s.proofStatus} ${st.local === "reproduced" ? s.ok : st.local === "mismatch" ? s.bad : s.warn}`}
          >
            {st.local === "reproduced"
              ? "Reproduced locally"
              : st.local === "mismatch"
                ? "Mismatch on rebuild"
                : "Not run"}
          </span>
          <span className={s.metricSub}>Method: {v.local.method}</span>
          <span className={s.metricSub}>Checked: {v.local.checkedAt ?? "never"}</span>
          <span>{v.local.detail}</span>
        </div>
        <div className={s.proof} data-status={st.outlayer} data-testid="proof-outlayer">
          <span className={s.eyebrow}>OutLayer-backed proof</span>
          <span
            className={`${s.proofStatus} ${st.outlayer === "verified" ? s.ok : st.outlayer === "failed" ? s.bad : s.warn}`}
          >
            {st.outlayer === "verified"
              ? "Verified (TEE attestation)"
              : st.outlayer === "failed"
                ? "Verification failed"
                : "Unverified"}
          </span>
          <span className={s.metricSub}>Method: {v.outlayer.method}</span>
          <span className={s.metricSub}>
            Job: <span className={s.mono}>{v.outlayer.jobId ?? "none"}</span> · checked{" "}
            {v.outlayer.checkedAt ?? "never"}
          </span>
          <span>{v.outlayer.detail}</span>
          {st.outlayerNote ? <span className={s.warn}>{st.outlayerNote}</span> : null}
        </div>
      </div>
      <div className={s.card} data-testid="verification-failures">
        <h3 className={s.cardTitle}>Verification failures</h3>
        {v.failures.length ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>At</th>
                <th>Kind</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {v.failures.map((f, i) => (
                <tr key={i}>
                  <td className={s.mono}>{f.at}</td>
                  <td>{f.kind}</td>
                  <td>{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className={s.muted}>No failures recorded.</span>
        )}
      </div>
    </section>
  );
}

function Provenance({ c }: { c: CapsuleView }) {
  const byId = useMemo(() => new Map(c.provenance.map((n) => [n.id, n])), [c]);
  const [sel, setSel] = useState<string | null>(
    c.provenance.find((n) => n.kind === "claim" || n.kind === "result")?.id ?? c.provenance[0]?.id ?? null,
  );
  const lineage = useMemo(() => {
    const out: CapsuleView["provenance"] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      const n = byId.get(id);
      if (!n || seen.has(id) || depth > 30) return;
      seen.add(id);
      out.push(n);
      n.parents.forEach((p) => walk(p, depth + 1));
    };
    if (sel) walk(sel, 0);
    return out;
  }, [sel, byId]);
  const missing = c.provenance.flatMap((n) =>
    n.parents.filter((p) => !byId.has(p)).map((p) => `${n.id} → ${p}`),
  );
  return (
    <section className={s.section} aria-labelledby="h-prov">
      <div className={s.sectionHead}>
        <h2 id="h-prov">Provenance explorer</h2>
      </div>
      <div className={s.tree}>
        <ul className={s.list} aria-label="Provenance nodes">
          {c.provenance.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={s.nodeBtn}
                aria-pressed={sel === n.id}
                onClick={() => setSel(n.id)}
                data-testid={`prov-node-${n.id}`}
              >
                <span className={s.eyebrow}>{n.kind}</span>
                <span>{n.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className={s.card} data-testid="lineage">
          <h3 className={s.cardTitle}>Lineage of the selected node</h3>
          <ol className={s.list}>
            {lineage.map((n) => (
              <li key={n.id}>
                <span className={s.eyebrow}>{n.kind}</span> {n.label}
                <div className={s.mono}>{n.hash ?? "no hash recorded"}</div>
              </li>
            ))}
          </ol>
          {missing.length ? (
            <span className={s.warn} data-testid="lineage-missing">
              Unresolved references: {missing.join(", ")}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function CapsuleViewer({ workspaceId }: { workspaceId: string }) {
  const id = useMemo(() => new URLSearchParams(window.location.search).get("id"), []);
  const [res, setRes] = useState<CapsuleResponse | null>(null);
  const [list, setList] = useState<Array<{
    capsuleId: string;
    title: string;
    label: string;
    createdAt: string;
  }> | null>(null);
  useEffect(() => {
    let live = true;
    const done = (x: CapsuleResponse) => {
      if (!live) return;
      setRes(x);
      (window as unknown as { __capsule?: unknown }).__capsule = { ready: true, res: x };
    };
    void (async () => {
      const lr = await fetch("/api/k/capsules", { cache: "no-store" });
      const capsules = lr.ok ? (((await lr.json()) as { capsules?: typeof list }).capsules ?? []) : [];
      if (live) setList(capsules);
      const target =
        id ?? [...(capsules ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.capsuleId;
      if (!target)
        return done({
          status: "unavailable",
          reason: lr.ok
            ? "No research capsule has been published yet. Nothing here is shown as verified."
            : `Capsule listing failed (${lr.status}).`,
        });
      const r = await fetch(`/api/k/capsules/${encodeURIComponent(target)}`, { cache: "no-store" });
      if (!r.ok) return done({ status: "unavailable", reason: `Capsule request failed (${r.status}).` });
      // The record is validated against the published contract before anything is rendered.
      const parsed = CapsuleResponseRecord.safeParse(await r.json());
      done(
        parsed.success
          ? parsed.data
          : {
              status: "unavailable",
              reason: "Capsule record failed contract validation; nothing is shown as verified.",
            },
      );
    })();
    return () => {
      live = false;
    };
  }, [workspaceId, id]);

  return (
    <main className={s.page} data-testid="capsule-page">
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <a href={`/w/${workspaceId}`}>Workspace</a>
        <span aria-hidden="true">/</span>
        <a href={`/w/${workspaceId}/thesis`}>Investment thesis</a>
        <span aria-hidden="true">/</span>
        <span>Research capsule</span>
      </nav>
      {!res ? (
        <div className="nz-state" role="status" aria-busy="true">
          Loading capsule…
        </div>
      ) : res.status === "unavailable" ? (
        <EmptyState title="No research capsule available" data-testid="capsule-unavailable">
          {res.reason}
        </EmptyState>
      ) : (
        <Capsule c={res.capsule} />
      )}
      {list && list.length > 1 ? (
        <section className={s.section} aria-labelledby="h-all">
          <div className={s.sectionHead}>
            <h2 id="h-all">All capsules</h2>
          </div>
          <ul data-testid="capsule-list">
            {list.map((c) => (
              <li key={c.capsuleId}>
                <a href={`/w/${workspaceId}/capsule?id=${encodeURIComponent(c.capsuleId)}`}>{c.title}</a>{" "}
                <span className={s.metricSub}>
                  {c.label} · {c.createdAt}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function Capsule({ c }: { c: CapsuleView }) {
  const st = proofStatus(c.verification);
  const results = new Map(c.results.map((r) => [r.id, r]));
  return (
    <>
      <header className={s.head}>
        <span className={s.eyebrow}>Research capsule · {c.capsuleId}</span>
        <h1 className={s.question}>{c.title}</h1>
        <div className={s.toolbar}>
          <ProvenanceChip sourceLabel={c.sourceLabel} data-testid="capsule-source" />
          <span className={s.metricSub}>Created {c.createdAt}</span>
          <span
            className={`${s.metricSub} ${st.outlayer === "verified" ? s.ok : s.warn}`}
            data-testid="capsule-status-summary"
          >
            {st.outlayer === "verified" ? "OutLayer-verified" : "Not cryptographically verified"} ·{" "}
            {st.local === "reproduced" ? "locally reproduced" : `local rebuild ${st.local.replace("_", " ")}`}
          </span>
        </div>
        <ClaimLegend />
      </header>
      {c.sourceLabel === "SYNTHETIC" ? (
        <HonestyBanner data-testid="capsule-synthetic">
          SYNTHETIC capsule: built from labelled synthetic fixture data. It demonstrates the method and makes
          no live claim about NEAR.
        </HonestyBanner>
      ) : null}

      <section className={s.section} aria-labelledby="h-claims">
        <div className={s.sectionHead}>
          <h2 id="h-claims">Claims and evidence</h2>
        </div>
        <ul className={s.list}>
          {c.claims.map((cl) => {
            const supported = cl.resultIds.length > 0 && cl.resultIds.every((r) => results.has(r));
            const declared = CLASS_OF[cl.claimClass];
            const cls: ClaimClass = declared === "hypothesis" || supported ? declared : "unsupported";
            return (
              <li key={cl.id}>
                <Claim cls={cls} testId={`capsule-claim-${cl.id}`}>
                  {cl.text}
                  <div className={s.metricSub}>
                    {cl.resultIds.length ? `Results: ${cl.resultIds.join(", ")}` : "No result cited"}
                    {cls === "unsupported" && declared !== "unsupported"
                      ? " · cited result missing from the capsule, shown as unsupported"
                      : ""}
                  </div>
                </Claim>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={s.section} aria-labelledby="h-results">
        <div className={s.sectionHead}>
          <h2 id="h-results">Computation results</h2>
        </div>
        <table className={s.table} data-testid="capsule-results">
          <thead>
            <tr>
              <th>Result</th>
              <th className={s.num}>Value</th>
              <th>Unit</th>
              <th>Computation</th>
            </tr>
          </thead>
          <tbody>
            {c.results.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.label} <span className={s.mono}>({r.id})</span>
                </td>
                <td className={s.num}>{r.value}</td>
                <td>{r.unit ?? ""}</td>
                <td>{r.computation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={s.section} aria-labelledby="h-hashes">
        <div className={s.sectionHead}>
          <h2 id="h-hashes">Data and computation hashes</h2>
        </div>
        <table className={s.table} data-testid="capsule-hashes">
          <tbody>
            {(
              [
                ["Pre-registration", c.hashes.preregistrationHash],
                ["Source snapshot", c.hashes.sourceSnapshotHash],
                ["Semantic model", c.hashes.semanticModelHash],
                ["Analysis code commit", c.hashes.analysisCodeCommit],
                ["Container digest", c.hashes.containerDigest],
                ["Result manifest", c.hashes.resultManifestHash],
              ] as const
            ).map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className={s.mono}>{v ?? <span className={s.warn}>not recorded</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Verification c={c} />
      <Provenance c={c} />

      <section className={s.section} aria-labelledby="h-rebuild">
        <div className={s.sectionHead}>
          <h2 id="h-rebuild">Rebuild and export</h2>
        </div>
        <div className={s.grid2}>
          <div className={s.card}>
            <h3 className={s.cardTitle}>Rebuild instructions</h3>
            <pre className={s.code} data-testid="capsule-rebuild">
              {c.rebuild.command}
            </pre>
            <ol>
              {c.rebuild.steps.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
            <Button onClick={() => void navigator.clipboard?.writeText(c.rebuild.command)}>
              Copy command
            </Button>
          </div>
          <div className={s.card} data-testid="capsule-exports">
            <h3 className={s.cardTitle}>Exportable research package</h3>
            {c.exports.length ? (
              <ul className={s.list}>
                {c.exports.map((e) => (
                  <li key={e.href}>
                    {exportHref(e.href) ? (
                      <a
                        href={exportHref(e.href)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="capsule-export-link"
                      >
                        {e.label}
                      </a>
                    ) : (
                      <span>{e.label} (link withheld: not a capsule export path)</span>
                    )}
                    <div className={s.mono}>{e.sha256 ?? "no checksum recorded"}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className={s.muted}>No exports published.</span>
            )}
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-limits">
        <div className={s.sectionHead}>
          <h2 id="h-limits">Source limitations</h2>
        </div>
        <ul data-testid="capsule-limitations">
          {c.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
