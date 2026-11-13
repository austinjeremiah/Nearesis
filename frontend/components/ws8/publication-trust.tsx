import { Badge } from '@/components/nx/evidence';
import { KeyValues } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';

/**
 * Publication trust facts from the API: the signing key (fingerprint and trusted-key registry status), whether the key
 * is hardened, and the anchor (append-only log entry plus testnet transaction). Presentational only, so it renders in
 * server and client components. A missing fact says so; nothing is inferred.
 */
export type SigningKey = {
  fingerprint: string;
  keyId: string;
  keyStatus: 'active' | 'revoked' | string;
  revokedAt: string | null;
  trusted: boolean;
  trustReason: string;
} | null;

export type PublicationVersion = {
  version: string;
  manifestHash: string;
  bundleHash: string;
  capsuleHash: string;
  signature: { alg: string; signedAt: string } | null;
  key: SigningKey;
  verification: { ok: boolean; signature: string; problems: string[] } | null;
  anchor: {
    log: { seq: number; anchoredAt: string; entryHash: string; prevHash: string } | null;
    chain: { network: string; contract: string; txHash: string; viewTimestampNs: string; logSeq: number } | null;
  } | null;
};

export type AnchorReadback = {
  capsuleId: string;
  manifestHash: string | null;
  status: 'verified' | 'mismatch' | 'not_committed' | 'unavailable' | string;
  reason?: string;
  anchor?: PublicationVersion['anchor'];
  readback?: { network: string; contract: string; txHash: string; finality: string; succeeded: boolean; receiver: string; committedHash: string; viewPresent: boolean; viewTimestampNs: string; equal: boolean } | null;
};

const short = (h: string, n = 16) => `${h.slice(0, n)}…`;

export function KeyBadge({ k }: { k: SigningKey }) {
  if (!k) return <span data-testid="key-registry-status" data-status="unknown"><Badge tone="warn">unknown: no key recorded</Badge></span>;
  const status = k.keyStatus === 'active' ? 'active' : k.keyStatus === 'revoked' ? 'revoked' : 'unknown';
  return (
    <span data-testid="key-registry-status" data-status={status}>
      <Badge tone={status === 'active' ? 'ok' : status === 'revoked' ? 'bad' : 'warn'} title={k.trustReason}>
        {status}
      </Badge>
    </span>
  );
}

export function PublicationVersionCard({ v, hardened, testId = 'publication-version' }: { v: PublicationVersion; hardened?: boolean | null; testId?: string }) {
  const k = v.key;
  const a = v.anchor;
  return (
    <div data-testid={testId} data-version={v.version} className="col gap2">
      <KeyValues
        rows={[
          { k: 'Version', v: <span className="mono">{v.version}</span> },
          { k: 'Manifest hash', v: <span className="mono small" title={v.manifestHash}>{short(v.manifestHash, 24)}</span> },
          { k: 'Signature', v: v.verification ? <Badge tone={v.verification.ok ? 'ok' : 'bad'}>{v.verification.signature}</Badge> : <Badge outline>unsigned</Badge> },
          { k: 'Signed', v: <span className="mono small">{formatUtc(v.signature?.signedAt ?? null)}{v.signature ? ` (${v.signature.alg})` : ''}</span> },
          { k: 'Signing key fingerprint', v: k ? <span className="mono small" data-testid="key-fingerprint" title={k.fingerprint}>{k.fingerprint}</span> : <span className="dim" data-testid="key-fingerprint">not recorded</span> },
          { k: 'Trusted-key registry', v: <span className="row gap2"><KeyBadge k={k} /><span data-testid="key-trusted" data-trusted={String(!!k?.trusted)}><Badge tone={k?.trusted ? 'ok' : 'warn'}>{k?.trusted ? 'trusted' : 'not trusted'}</Badge></span><span className="small dim">{k?.trustReason ?? ''}</span></span> },
          ...(k?.revokedAt ? [{ k: 'Revoked at', v: <span className="mono small">{formatUtc(k.revokedAt)}</span> }] : []),
          ...(hardened === undefined || hardened === null ? [] : [{ k: 'Key custody', v: <span data-testid="key-hardened" data-hardened={String(hardened)}><Badge tone={hardened ? 'ok' : 'warn'}>{hardened ? 'hardened' : 'not hardened (development key)'}</Badge></span> }]),
          {
            k: 'Anchor log entry',
            v: a?.log ? (
              <span className="col gap1" data-testid="anchor-log">
                <span className="mono small" title={a.log.entryHash} data-testid="anchor-entry-hash">{a.log.entryHash}</span>
                <span className="small dim">#{a.log.seq} at {formatUtc(a.log.anchoredAt)}</span>
              </span>
            ) : <span className="dim" data-testid="anchor-log">not anchored</span>,
          },
          {
            k: 'Testnet transaction',
            v: a?.chain ? (
              <span className="col gap1" data-testid="anchor-chain">
                <span className="mono small" data-testid="anchor-tx">{a.chain.network} {a.chain.txHash}</span>
                <span className="small dim">contract {a.chain.contract}</span>
              </span>
            ) : <span data-testid="anchor-chain"><Badge outline>not committed to a chain</Badge></span>,
          },
        ]}
      />
    </div>
  );
}

export function AnchorReadbackBlock({ r }: { r: AnchorReadback }) {
  const tone = r.status === 'verified' ? 'ok' : r.status === 'mismatch' ? 'bad' : 'warn';
  return (
    <div className="col gap2" data-testid="anchor-readback" data-status={r.status}>
      <div className="row gap2"><Badge tone={tone}>{r.status.replace(/_/g, ' ')}</Badge><span className="small dim">Read back from the testnet contract; read-only.</span></div>
      {r.reason && <p className="small">{r.reason}</p>}
      {r.readback && (
        <KeyValues
          rows={[
            { k: 'Transaction', v: <span className="mono small">{r.readback.txHash}</span> },
            { k: 'Finality', v: <span className="mono small">{r.readback.finality}{r.readback.succeeded ? ', succeeded' : ', failed'}</span> },
            { k: 'Committed hash', v: <span className="mono small" title={r.readback.committedHash}>{r.readback.committedHash}</span> },
            { k: 'Equals manifest hash', v: <Badge tone={r.readback.equal ? 'ok' : 'bad'}>{r.readback.equal ? 'equal' : 'different'}</Badge> },
            { k: 'View present', v: r.readback.viewPresent ? 'yes' : 'no' },
          ]}
        />
      )}
    </div>
  );
}
