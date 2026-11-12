import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import '../../app.css';
import Wordmark from '@/components/Wordmark';
import { Badge, EvidenceVerdict } from '@/components/nx/evidence';
import { Card, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

export const metadata: Metadata = { title: 'Published research · Nearesis' };

const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@300;400;500;600;700' +
  '&family=Stack+Sans+Notch:wght@300;400;500;600' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

/**
 * Spec 5.25 — public reader.
 *
 * No private shell: no sidebar, no workspace ids, no role controls. Above the
 * fold is the claim, its scope, its evidence quality and its limitations. The
 * page must work without provider keys or an authenticated API, which is why it
 * reads only from the published capsule record.
 */
export default async function PublicReaderPage({
  params,
}: {
  params: Promise<{ publicationId: string }>;
}) {
  const { publicationId } = await params;
  const p = db.publication(publicationId);
  if (!p) notFound();

  const cap = db.capsule(p.capsuleHash);
  const ws = db.workspace(p.workspaceId);
  const claims = db.claims(p.workspaceId);

  return (
    <div className="nx">
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />

      <div style={{ maxWidth: 940, margin: '0 auto', padding: '40px 24px 80px' }}>
        <header className="row between" style={{ borderBottom: '1px solid var(--line-strong)', paddingBottom: 16 }}>
          <Link href="/">
            <Wordmark tone="black" size={24} />
          </Link>
          <span className="label">Published research</span>
        </header>

        <div className="col gap4" style={{ marginTop: 32 }}>
          <span className="label">
            Version {p.version} · {formatUtc(p.publishedAt, false)}
          </span>
          <h1 className="h1">{p.title}</h1>
          <p className="muted" style={{ maxWidth: '70ch' }}>
            {ws?.objective}
          </p>
          <div className="row gap2 wrap">
            <EvidenceVerdict verdict={p.verdict} strength={p.strength} />
            <Badge outline>snapshot {p.snapshotId}</Badge>
            <Badge tone="bad" title="This instance publishes from a frozen fixture snapshot.">
              fixture
            </Badge>
          </div>
        </div>

        <Notice tone="warn" title="Numbers and claims below refer to the frozen snapshot shown">
          Later source updates may differ. Everything here was computed from{' '}
          <span className="mono">{p.snapshotId}</span> and has not been recomputed since.
        </Notice>

        <section className="col gap3" style={{ marginTop: 32 }}>
          <h2 className="h2">Claims</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ minWidth: 260 }}>Claim</th>
                  <th>Verdict</th>
                  <th>Estimate</th>
                  <th>What would change it</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{c.statement}</td>
                    <td>
                      <EvidenceVerdict verdict={c.verdict} strength={c.strength} />
                    </td>
                    <td className="small">{c.estimate}</td>
                    <td className="small">{c.falsification}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="col gap3" style={{ marginTop: 32 }}>
          <h2 className="h2">Limitations</h2>
          <Card>
            <ul style={{ paddingLeft: 16, listStyle: 'disc' }}>
              <li className="small">
                After {db.SETTLEMENT_BOUNDARY} a growing share of 1Click settlement cannot be
                reconstructed from public NEAR transaction hashes. Totals after that date are a
                lower bound.
              </li>
              <li className="small">
                The signer proxy counts accounts, not people. One person may hold many accounts.
              </li>
              <li className="small">
                1Click samples are dry quotes. They are not executed swaps, realized execution
                quality or revenue.
              </li>
              <li className="small">
                A forecast improvement is a prediction result, not evidence of causation.
              </li>
            </ul>
          </Card>
        </section>

        <section className="col gap3" style={{ marginTop: 32 }}>
          <h2 className="h2">Reproducibility</h2>
          <Card>
            <KeyValues
              rows={[
                { k: 'Capsule', v: <span className="mono" style={{ wordBreak: 'break-all' }}>{p.capsuleHash}</span> },
                { k: 'Snapshot', v: <span className="mono">{p.snapshotId}</span> },
                { k: 'Semantic version', v: <span className="mono">{db.SEMANTIC_VERSION}</span> },
                { k: 'Rebuild', v: <span className="mono">pnpm research:rebuild --snapshot {p.snapshotId}</span> },
                {
                  k: 'Reproducible',
                  v: cap ? <Badge tone={cap.reproducible ? 'ok' : 'bad'}>{cap.reproducible ? 'Yes' : 'No'}</Badge> : <span className="unavailable" />,
                },
                {
                  k: 'Input integrity',
                  v: cap ? <Badge tone={cap.inputIntegrity ? 'ok' : 'bad'}>{cap.inputIntegrity ? 'Verified' : 'Mismatch'}</Badge> : <span className="unavailable" />,
                },
                {
                  k: 'External attestation',
                  v: cap ? <Badge tone={cap.attestation === 'verified' ? 'ok' : ''}>{cap.attestation}</Badge> : <span className="unavailable" />,
                },
              ]}
            />
            {cap?.attestation === 'unavailable' && (
              <Notice tone="info" title="Reproducible locally. External compute attestation not available.">
                The rebuild is deterministic and the inputs match their recorded hashes. No enclave
                vouched for the run, and neither check establishes that the source data described
                reality.
              </Notice>
            )}
          </Card>
        </section>

        <section className="col gap3" style={{ marginTop: 32 }}>
          <h2 className="h2">Source index</h2>
          <Card>
            <KeyValues
              rows={db.sources().map((s) => ({
                k: s.name,
                v: (
                  <span className="small">
                    {s.provider} · watermark{' '}
                    <span className="mono">{formatUtc(s.watermark, false)}</span>
                  </span>
                ),
              }))}
            />
          </Card>
        </section>

        <footer
          className="row between"
          style={{ marginTop: 48, paddingTop: 16, borderTop: '1px solid var(--line-strong)' }}
        >
          <span className="tiny dim">
            Capsule {shortHash(p.capsuleHash)} · published {formatUtc(p.publishedAt)}
          </span>
          <Link className="link small" href="/">
            About Nearesis
          </Link>
        </footer>
      </div>
    </div>
  );
}
