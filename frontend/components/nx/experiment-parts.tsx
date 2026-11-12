'use client';

import { Badge } from '@/components/nx/evidence';
import { Notice } from '@/components/nx/ui';
import { fmtNum } from '@/components/nx/research-kit';
import type { Experiment } from '@/lib/research/api';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = { OK: 'ok', SUPPORTED: 'ok', MIXED: 'warn', INSUFFICIENT_DATA: 'warn', METHOD_NOT_VALIDATED: 'warn', NOT_SUPPORTED: 'bad' };

/** The verdict as the research run stated it. INSUFFICIENT_DATA and METHOD_NOT_VALIDATED are shown as results, not errors to hide. */
export function VerdictBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'info'}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function IntegrityBadge({ e }: { e: Pick<Experiment, 'integrity' | 'integrityIssues'> }) {
  return e.integrity === 'verified' ? <Badge tone="ok" title="Every artifact matches its recorded hash.">integrity verified</Badge> : <Badge tone="bad" title={e.integrityIssues.join('; ')}>integrity failed</Badge>;
}

export function ReasonList({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <ul className="small" data-testid="reason-codes">
      {codes.map((c, i) => <li key={i}>{c.length > 220 ? `${c.slice(0, 220)}…` : c}</li>)}
    </ul>
  );
}

export function ModelTable({ models }: { models: Experiment['models'] }) {
  const best = models.filter((m) => m.mae !== null).reduce<number | null>((b, m) => (b === null || (m.mae as number) < b ? (m.mae as number) : b), null);
  return (
    <table className="table" data-testid="model-table">
      <thead><tr><th>Model</th><th className="num">MAE</th><th className="num">sMAPE</th><th className="num">Bias</th><th className="num">Origins</th></tr></thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.id} data-model={m.id}>
            <td>{m.label} {best !== null && m.mae === best && <Badge outline>lowest MAE</Badge>}</td>
            <td className="num mono">{fmtNum(m.mae)}</td><td className="num mono">{fmtNum(m.smape)}</td><td className="num mono">{fmtNum(m.bias)}</td><td className="num mono">{m.n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const FailedIntegrity = ({ issues }: { issues: string[] }) => (
  <Notice tone="bad" title="This run's artifacts fail their recorded hashes">
    No figures are shown because they cannot be trusted. {issues.join('; ')}
  </Notice>
);
