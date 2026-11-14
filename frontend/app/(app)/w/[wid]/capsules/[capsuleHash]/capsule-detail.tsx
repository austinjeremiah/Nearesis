'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionBar } from '@/components/nx/section';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, Notice, Select } from '@/components/nx/ui';
import { ApiRequestError } from '@/lib/api/errors';
import { ApiErrorState } from '@/components/nx/states';
import { formatUtc } from '@/lib/format';
import { caps, metricsApi, type BundleResult, type CapsuleView, type VerifyReport } from '@/lib/ws6/api';
import { ActionError, Hash, Json, Slot, useAction } from '@/components/ws6/common';
import { AnchorReadbackBlock, KeyBadge, PublicationVersionCard } from '@/components/ws8/publication-trust';
import '../capsules.css';
import { LocalBadge, OutlayerBadge, PublicationBadge } from '@/components/ws6/capsule-bits';
import { OutlayerProofCard } from '@/components/ws6/outlayer-proof-card';

const bff = (href: string) => href.replace(/^\/v1\//, '/api/k/');

async function sha256Hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ExportRow({ e }: { e: CapsuleView['exports'][number] }) {
  const [res, setRes] = useState<{ ok: boolean; actual: string; header: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function check() {
    setErr(null);
    try {
      const r = await fetch(bff(e.href), { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const actual = await sha256Hex(await r.arrayBuffer());
      const header = r.headers.get('x-capsule-sha256');
      setRes({ ok: actual === e.sha256 && (header === null || header === actual), actual, header });
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'download failed');
    }
  }
  return (
    <li className="row gap2 wrap" data-testid="export-row">
      <a className="link" href={bff(e.href)} target="_blank" rel="noreferrer">
        {e.label}
      </a>
      <Hash value={e.sha256} />
      <Button size={undefined} onClick={() => void check()} data-testid="export-check">
        Verify download hash
      </Button>
      {res && <Badge tone={res.ok ? 'ok' : 'bad'}>{res.ok ? 'hash matches' : 'hash mismatch'}</Badge>}
      {err && <Badge tone="bad">{err}</Badge>}
    </li>
  );
}

function BundleBlock({ b }: { b: BundleResult }) {
  return (
    <div className="col gap2" data-testid="bundle-result">
      <Notice tone={b.hardened ? 'ok' : 'warn'} title={b.hardened ? 'Signed with a hardened key' : 'Signed with a plaintext development key'}>
        Signing source: {b.signingSource}. {b.hardened ? 'The key is held encrypted or in a keychain.' : 'This signature is not a production trust signal.'}
      </Notice>
      <KeyValues
        rows={[
          { k: 'Manifest hash', v: <Hash value={b.manifestHash} /> },
          { k: 'Bundle hash', v: <Hash value={b.bundleHash} /> },
          { k: 'Capsule hash', v: <Hash value={b.capsuleHash} /> },
          { k: 'Version', v: <span className="mono">{b.version}</span> },
          {
            k: 'Manifest signature',
            v: <Badge tone={b.signature === 'valid' ? 'ok' : 'bad'} title="Re-verified by the API after signing">{b.signature ?? 'unsigned'}</Badge>,
          },
          {
            k: 'Signing key',
            v: b.signingKey ? (
              <span className="row gap2" data-testid="bundle-key">
                <span className="mono small" data-testid="key-fingerprint" title={b.signingKey.fingerprint}>{b.signingKey.fingerprint}</span>
                <KeyBadge k={b.signingKey} />
                <Badge tone={b.signingKey.trusted ? 'ok' : 'warn'}>{b.signingKey.trusted ? 'trusted' : 'not trusted'}</Badge>
              </span>
            ) : <span className="dim" data-testid="key-fingerprint">not recorded</span>,
          },
          { k: 'Append-only log', v: <span className="mono small">{b.anchor.log.replace(/_/g, ' ')}{b.anchor.entryHash ? ` ${b.anchor.entryHash.slice(0, 16)}…` : ''}</span> },
          {
            k: 'Testnet commitment',
            v: b.anchor.testnet ? (
              <span className="mono small">{b.anchor.testnet.network} {b.anchor.testnet.txHash} ({b.anchor.testnet.readback.replace(/_/g, ' ')})</span>
            ) : (
              <Badge outline>{b.anchor.chain.replace(/_/g, ' ')}</Badge>
            ),
          },
        ]}
      />
    </div>
  );
}

function PublicationTrust({ capsuleId, hardened }: { capsuleId: string; hardened: boolean | null }) {
  const ver = useQuery({ queryKey: ['capsule', capsuleId, 'trust'], queryFn: () => caps.verify(capsuleId), staleTime: 30_000 });
  const anchor = useQuery({ queryKey: ['capsule', capsuleId, 'anchor'], queryFn: () => caps.anchor(capsuleId), staleTime: 30_000, retry: false });
  const pubs = ver.data?.publications ?? [];
  const prereg = ver.data?.hashChain?.preregistrationHash ?? null;
  const latest = pubs[pubs.length - 1] ?? null;
  return (
    <div className="col gap3" style={{ marginTop: 12 }} data-testid="publication-trust">
      <div className="label">Signing key and anchor</div>
      {ver.isPending ? (
        <p className="small dim">Reading signing and anchor records.</p>
      ) : ver.isError ? (
        <ApiErrorState error={ver.error} onRetry={() => ver.refetch()} />
      ) : latest ? (
        <PublicationVersionCard v={latest} hardened={hardened} />
      ) : (
        <p className="small dim" data-testid="no-publication-version">This capsule has no signed publication yet, so there is no signing key or anchor to show. Publish or export the signed bundle to create one.</p>
      )}
      {prereg ? (
        <KeyValues rows={[{ k: 'Preregistration hash', v: <Hash value={prereg} /> }]} />
      ) : (
        <p className="small dim" data-testid="no-prereg">No preregistration commitment is recorded for this capsule.</p>
      )}
      <div className="label">Testnet commitment readback</div>
      {anchor.isPending ? (
        <p className="small dim">Reading the testnet commitment.</p>
      ) : anchor.isError ? (
        <ApiErrorState error={anchor.error} />
      ) : (
        <AnchorReadbackBlock r={anchor.data} />
      )}
    </div>
  );
}

export default function CapsuleDetail({ wid, capsuleId }: { wid: string; capsuleId: string }) {
  const view = useQuery({ queryKey: ['capsule', capsuleId], queryFn: () => caps.view(capsuleId) });
  const pub = useQuery({ queryKey: ['capsule', capsuleId, 'publication'], queryFn: () => caps.publication(capsuleId) });
  const metrics = useQuery({ queryKey: ['metrics-all'], queryFn: metricsApi.list });
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [bundle, setBundle] = useState<BundleResult | null>(null);
  const [metricKey, setMetricKey] = useState('');
  const [check, setCheck] = useState<{ ok: boolean } | null>(null);

  const inv = [['capsule', capsuleId], ['capsule', capsuleId, 'publication'], ['capsule-publications']];
  const verify = useAction(() => caps.verify(capsuleId), { onDone: setReport });
  const publish = useAction(() => caps.publish(capsuleId, [...ticked]), { invalidate: inv });
  const unpublish = useAction(() => caps.unpublish(capsuleId), { invalidate: inv });
  const makeBundle = useAction(() => caps.bundle(capsuleId, [...ticked]), { onDone: setBundle });
  const pcheck = useAction(
    async () => {
      setCheck(null);
      return caps.publishCheck(wid, [{ metricKey }]);
    },
    { onDone: () => setCheck({ ok: true }) },
  );

  async function doPublish() {
    const r = await publish.run();
    void r;
  }
  // When the backend names missing acknowledgements, show them as a checklist the person must tick.
  const publishErr = publish.error ?? makeBundle.error;
  const missing = publishErr instanceof ApiRequestError && publishErr.reasonCode === 'ACKNOWLEDGEMENT_REQUIRED' ? publishErr.details.map((d) => d.issue) : null;
  const needed = missing ?? [];

  return (
    <Slot q={view} rows={6}>
      {(r) => {
        if (r.status === 'unavailable') return <EmptyState title="Capsule unavailable" body={r.reason} />;
        const c = r.capsule;
        const isPublic = pub.data?.public ?? false;
        const v = report;
        return (
          <div className="col gap4 caps-scope">
            <div className="row gap2 wrap" data-testid="capsule-badges">
              <LocalBadge v={c.verification.local} />
              <OutlayerBadge v={c.verification.outlayer} />
              <Badge tone={c.sourceLabel === 'SYNTHETIC' ? 'warn' : 'info'} outline>{c.sourceLabel}</Badge>
              <PublicationBadge state={isPublic ? 'published' : pub.data?.record ? 'unpublished' : 'never_published'} />
            </div>
            <h2 className="h3">{c.title}</h2>
            {c.sourceLabel === 'SYNTHETIC' && (
              <Notice tone="warn" title="Synthetic data">No statement in this capsule describes NEAR production activity.</Notice>
            )}

            <section>
              <SectionBar title="Verification" number="001" />
              <div className="grid c3">
                <Card title="Reproducible">
                  <p className="small">{c.verification.local.detail}</p>
                  <LocalBadge v={c.verification.local} />
                  <div className="tiny dim">Checked {formatUtc(c.verification.local.checkedAt)}</div>
                </Card>
                <Card title="Input integrity">
                  <p className="small">The frozen snapshot bytes hash to the recorded data hash.</p>
                  <KeyValues
                    rows={[
                      { k: 'Source snapshot', v: <Hash value={c.hashes.sourceSnapshotHash} /> },
                      { k: 'Result manifest', v: <Hash value={c.hashes.resultManifestHash} /> },
                      { k: 'Semantic model', v: <Hash value={c.hashes.semanticModelHash} /> },
                    ]}
                  />
                </Card>
                <Card title="Attestation (OutLayer)">
                  <p className="small" data-testid="outlayer-detail">{c.verification.outlayer.detail}</p>
                  <OutlayerBadge v={c.verification.outlayer} />
                  <KeyValues
                    rows={[
                      { k: 'Job', v: c.verification.outlayer.jobId ? <span className="mono">{c.verification.outlayer.jobId}</span> : <span className="dim">none</span> },
                      { k: 'Checked', v: c.verification.outlayer.checkedAt ? <span className="mono">{formatUtc(c.verification.outlayer.checkedAt)}</span> : <span className="dim">never</span> },
                    ]}
                  />
                </Card>
              </div>
              <div className="col gap2" style={{ marginTop: 12 }}>
                <div>
                  <Button onClick={() => void verify.run()} pending={verify.pending} data-testid="verify-run">
                    Re-verify locally now
                  </Button>
                </div>
                <ActionError error={verify.error} />
                {v && (
                  <div data-testid="verify-report" data-status={v.status}>
                    <Notice tone={v.status === 'reproduced' ? 'ok' : 'bad'} title={`Local verification: ${v.status}`}>
                      Scope is local only; this is not an OutLayer attestation. Checks: {v.checks.join(', ')}.
                      {v.failures.length > 0 && <Json value={v.failures} />}
                    </Notice>
                    <KeyValues
                      rows={[
                        { k: 'Checked at', v: <span className="mono">{formatUtc(v.checkedAt)}</span> },
                        { k: 'Attestation evidence', v: v.attestation.present ? <Badge tone="info">present</Badge> : <Badge outline>none</Badge> },
                        { k: 'WASM SHA-256', v: <Hash value={v.hashChain.wasmSha256} /> },
                        { k: 'Input SHA-256', v: <Hash value={v.hashChain.inputSha256} /> },
                        { k: 'Results SHA-256', v: <Hash value={v.hashChain.resultsSha256} /> },
                      ]}
                    />
                  </div>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <OutlayerProofCard capsuleId={capsuleId} />
              </div>
              <PublicationTrust capsuleId={capsuleId} hardened={bundle?.hardened ?? null} />
            </section>

            <section>
              <SectionBar title="Claims and results" number="002" />
              <div className="grid c2">
                <Card title="Claims">
                  <ul className="col gap2">
                    {c.claims.map((x) => (
                      <li key={x.id} className="small">
                        <Badge outline>{x.claimClass.replace(/_/g, ' ')}</Badge> {x.text}
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card title="Results">
                  <ul className="col gap2">
                    {c.results.map((x) => (
                      <li key={x.id} className="small">
                        <span className="strong">{x.label}</span>: <span className="mono">{x.value}</span> {x.unit}
                        <div className="tiny dim">{x.computation}</div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
              <Card title="Limitations">
                <ul className="col gap2">
                  {c.limitations.map((l, i) => (
                    <li key={i} className="small">{l}</li>
                  ))}
                </ul>
              </Card>
            </section>

            <section>
              <SectionBar title="Exports" number="003" />
              <Card>
                <ul className="col gap2" style={{ listStyle: 'none', padding: 0 }}>
                  {c.exports.map((e) => (
                    <ExportRow key={e.href} e={e} />
                  ))}
                </ul>
              </Card>
            </section>

            <section>
              <SectionBar title="Publication" number="004" />
              <div className="grid c2">
                <Card title="Publish or withdraw">
                  <KeyValues
                    rows={[
                      { k: 'State', v: <PublicationBadge state={isPublic ? 'published' : pub.data?.record ? 'unpublished' : 'never_published'} /> },
                      { k: 'Badge', v: pub.data?.record?.badge ?? <span className="dim">none</span> },
                      { k: 'Acknowledged', v: pub.data?.record?.acknowledged.length ? pub.data.record.acknowledged.join(', ') : <span className="dim">nothing</span> },
                      { k: 'Recorded', v: pub.data?.record ? <span className="mono">{formatUtc(pub.data.record.at)}</span> : <span className="dim">never</span> },
                    ]}
                  />
                  {needed.length > 0 && (
                    <div className="col gap2" data-testid="ack-checklist">
                      <Notice tone="warn" title="Acknowledge before publishing">
                        This capsule carries cautionary statuses. Publishing is allowed only when each is acknowledged.
                      </Notice>
                      {needed.map((n) => (
                        <label key={n} className="row gap2 small">
                          <input
                            type="checkbox"
                            checked={ticked.has(n)}
                            data-testid={`ack-${n}`}
                            onChange={(e) => {
                              const s = new Set(ticked);
                              if (e.target.checked) s.add(n);
                              else s.delete(n);
                              setTicked(s);
                            }}
                          />
                          <span className="mono">{n}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="row gap2" style={{ marginTop: 8 }}>
                    {!isPublic ? (
                      <Button variant="primary" onClick={() => void doPublish()} pending={publish.pending} data-testid="publish">
                        Publish
                      </Button>
                    ) : (
                      <Button variant="danger" onClick={() => void unpublish.run()} pending={unpublish.pending} data-testid="unpublish">
                        Unpublish
                      </Button>
                    )}
                    <Button onClick={() => void makeBundle.run()} pending={makeBundle.pending} data-testid="export-bundle">
                      Export signed bundle
                    </Button>
                  </div>
                  <ActionError error={publish.error} />
                  <ActionError error={makeBundle.error} />
                  <ActionError error={unpublish.error} />
                  {isPublic && (
                    <p className="small">
                      Public page: <a className="link" href={`/public/${encodeURIComponent(capsuleId)}`} data-testid="public-link">/public/{capsuleId}</a>
                    </p>
                  )}
                </Card>
                <Card title="Metric publication check" subtitle="A non-certified metric cannot back a published capsule.">
                  <div className="row gap2">
                    <Select
                      aria-label="Metric"
                      value={metricKey}
                      onChange={(e) => {
                        setMetricKey(e.target.value);
                        setCheck(null);
                      }}
                      data-testid="check-metric"
                      options={[
                        { value: '', label: 'Choose a metric' },
                        ...(metrics.data?.metrics ?? []).map((m) => ({ value: m.metricKey, label: `${m.metricKey} (${m.status})` })),
                      ]}
                    />
                    <Button onClick={() => void pcheck.run()} pending={pcheck.pending} disabled={!metricKey} disabledReason="Choose a metric" data-testid="check-run">
                      Check
                    </Button>
                  </div>
                  <ActionError error={pcheck.error} />
                  {check?.ok && <Notice tone="ok" title="Metric is certified">This metric may be published.</Notice>}
                </Card>
              </div>
              {bundle && (
                <Card title="Publication manifest">
                  <BundleBlock b={bundle} />
                </Card>
              )}
            </section>
          </div>
        );
      }}
    </Slot>
  );
}
