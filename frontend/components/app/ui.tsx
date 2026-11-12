'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import {
  BadgeCheck, Check, CheckCircle2, ChevronDown, Circle, Code2, Copy, Database, Delete, ExternalLink, Info, Loader2,
  ShieldAlert, Store, Timer, XCircle, type LucideIcon,
} from 'lucide-react';
import { countdown, formatFiat, formatToken } from '@/lib/format';
import { useNow } from '@/lib/hooks';

/* ---------------------------------------------------------------- basics */
export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

export function Skeleton({ h = 18, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} />;
}

export function Pill({ tone, icon: Icon, children }: { tone?: 'ok' | 'bad' | 'warn' | 'info' | 'neon' | 'ink'; icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className={`pill ${tone ?? ''}`}>
      {Icon && <Icon size={13} />}
      {children}
    </span>
  );
}

export function Notice({ tone, icon: Icon, children }: { tone: 'ok' | 'bad' | 'warn' | 'info'; icon?: LucideIcon; children: ReactNode }) {
  const I = Icon ?? (tone === 'ok' ? CheckCircle2 : tone === 'bad' ? ShieldAlert : Info);
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <I size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Sheet({ open, onClose, title, icon: Icon, children }: { open: boolean; onClose: () => void; title?: string; icon?: LucideIcon; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const content = (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        {title && (
          <div className="row">
            {Icon && <Icon size={22} />}
            <h2 className="h2">{title}</h2>
          </div>
        )}
        {children}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

export function StateBlock({
  icon: Icon, title, message, tone, action,
}: { icon: LucideIcon; title: string; message?: string; tone?: 'ok' | 'bad' | 'warn'; action?: ReactNode }) {
  return (
    <div className={`state ${tone ?? ''}`}>
      <div className="big">
        <Icon size={34} />
      </div>
      <h2 className="h2">{title}</h2>
      {message && <p className="muted">{message}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- money */
export function TokenChip({ symbol, chain }: { symbol: string; chain?: string | null }) {
  return (
    <span className="tchip">
      <span className={`dot ${symbol}`}>{symbol.slice(0, 1)}</span>
      <span>{symbol}</span>
      {chain && <span className="chainbadge">{chain}</span>}
    </span>
  );
}

export function Amount({
  value, decimals, symbol, size = 'lg', chip = true,
}: { value: string | bigint | null | undefined; decimals: number; symbol: string; size?: 'xl' | 'lg' | 'md'; chip?: boolean }) {
  return (
    <span className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <span className={`amount ${size}`}>{formatToken(value, decimals)}</span>
      {chip ? <TokenChip symbol={symbol} /> : <span className="h3">{symbol}</span>}
    </span>
  );
}

export function FiatLine({ usd, rate, currency }: { usd: number; rate: number | null; currency: string }) {
  if (rate === null || !Number.isFinite(usd)) return null;
  return <span className="muted small">≈ {formatFiat(usd, rate, currency)}</span>;
}

export function MerchantAvatar({ logoUrl, name, small }: { logoUrl?: string | null; name?: string | null; small?: boolean }) {
  const initials = (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <div className={`avatar ${small ? 'sm' : ''}`} aria-hidden>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" onError={(e) => ((e.currentTarget.style.display = 'none'))} />
      ) : initials ? (
        initials
      ) : (
        <Store size={20} />
      )}
    </div>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Pill tone="ok" icon={BadgeCheck}>Verified merchant</Pill>
  ) : (
    <Pill tone="bad" icon={ShieldAlert}>Not verified</Pill>
  );
}

export function IndexedTag() {
  return (
    <span className="pill" title="Read from the Envio indexer">
      <Database size={12} /> Indexed by Envio
    </span>
  );
}

/* ---------------------------------------------------------------- QR + copy */
export function QrView({ payload, size = 260 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(payload, { margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((u) => live && setSrc(u))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [payload, size]);
  return (
    <div className="qrbox" style={{ minWidth: size + 28, minHeight: size + 28 }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} width={size} height={size} alt="QR code" />
      ) : (
        <Spinner size={28} />
      )}
    </div>
  );
}

export function CopyButton({ text, label, small }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${small === false ? '' : 'sm'} ghost`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          toast.success('Copied');
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Could not copy');
        }
      }}
      aria-label={label ?? 'Copy'}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label}
    </button>
  );
}

export function Countdown({ until, onExpire, label }: { until: number; onExpire?: () => void; label?: string }) {
  const now = useNow();
  const left = until - now;
  useEffect(() => {
    if (left <= 0) onExpire?.();
  }, [left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const tone = left < 30 ? 'bad' : left < 120 ? 'warn' : undefined;
  return (
    <Pill tone={tone} icon={Timer}>
      {label ? `${label} ` : ''}
      {countdown(left)}
    </Pill>
  );
}

/* ---------------------------------------------------------------- steps + details */
export type StepState = 'done' | 'active' | 'todo' | 'error';
export function StepList({ steps }: { steps: { label: string; state: StepState; icon?: LucideIcon }[] }) {
  return (
    <div className="steps">
      {steps.map((s, i) => {
        const I = s.state === 'done' ? CheckCircle2 : s.state === 'active' ? Loader2 : s.state === 'error' ? XCircle : s.icon ?? Circle;
        return (
          <div key={i} className={`step ${s.state}`}>
            <span className="ic">
              <I size={22} className={s.state === 'active' ? 'spin' : undefined} />
            </span>
            <span className="lb">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TechDetails({ rows }: { rows: { label: string; value?: string | null; href?: string }[] }) {
  const items = rows.filter((r) => r.value);
  if (!items.length) return null;
  return (
    <details className="tech">
      <summary>
        <Code2 size={15} /> Technical details <ChevronDown size={15} className="chev" />
      </summary>
      <div className="card" style={{ marginTop: 6 }}>
        {items.map((r) => (
          <div className="kv" key={r.label}>
            <span className="k">{r.label}</span>
            <span className="v row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              <span className="mono">{r.value}</span>
              <CopyButton text={r.value!} />
              {r.href && (
                <a href={r.href} target="_blank" rel="noreferrer" className="sp-icon-btn" style={{ width: 30, height: 30 }} aria-label="Open in explorer">
                  <ExternalLink size={14} />
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------- keypad */
export function Keypad({ value, onChange, maxDecimals = 2, maxLen = 9 }: { value: string; onChange: (v: string) => void; maxDecimals?: number; maxLen?: number }) {
  const press = (k: string) => {
    if (k === 'del') return onChange(value.slice(0, -1));
    if (k === '.') {
      if (value.includes('.')) return;
      return onChange(value === '' ? '0.' : value + '.');
    }
    if (value.length >= maxLen) return;
    const [, dec] = value.split('.');
    if (dec !== undefined && dec.length >= maxDecimals) return;
    if (value === '0') return onChange(k);
    onChange(value + k);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
  return (
    <div className="keypad" role="group" aria-label="Amount">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => press(k)}
          onContextMenu={(e) => {
            if (k === 'del') {
              e.preventDefault();
              onChange('');
            }
          }}
          aria-label={k === 'del' ? 'Backspace' : k}
        >
          {k === 'del' ? <Delete size={22} /> : k}
        </button>
      ))}
    </div>
  );
}

export const routeLabel = (r: string, symbol?: string) =>
  r === 'DIRECT' ? 'Direct' : r === 'SWAP' ? `Paid in ${symbol ?? 'another token'}` : 'From another chain';
