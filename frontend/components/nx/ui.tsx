'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { formatUsd } from '@/lib/format';

/**
 * Shared interface primitives. Spec 3.3 names these; spec 3.4 sets the rules
 * they enforce, in particular: one primary per action cluster, and no inert
 * buttons. A disabled control here always carries a reason, because the spec
 * forbids showing an action that cannot explain why it is unavailable.
 */

/* -----------------------------------------------------------------------------
   buttons
   -------------------------------------------------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size,
  block,
  pending,
  /** Why the control is disabled. Required whenever `disabled` is set. */
  disabledReason,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'lg';
  block?: boolean;
  pending?: boolean;
  disabledReason?: string;
}) {
  const cls = [
    'btn',
    variant === 'primary' ? 'primary' : '',
    variant === 'ghost' ? 'ghost' : '',
    variant === 'danger' ? 'danger' : '',
    size === 'lg' ? 'lg' : '',
    block ? 'block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      className={cls}
      disabled={disabled || pending}
      data-pending={pending ? 'true' : undefined}
      // The reason is the accessible explanation, not a decorative tooltip.
      title={disabled ? disabledReason : rest.title}
      aria-describedby={undefined}
      {...rest}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'secondary',
  size,
  children,
  className = '',
}: {
  href: string;
  variant?: Variant;
  size?: 'lg';
  children: ReactNode;
  className?: string;
}) {
  const cls = [
    'btn',
    variant === 'primary' ? 'primary' : '',
    variant === 'ghost' ? 'ghost' : '',
    variant === 'danger' ? 'danger' : '',
    size === 'lg' ? 'lg' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

export function IconButton({
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button className="btn icon ghost" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** A plain rotating rule. No pulsing orb. */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1.5 A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 8 8"
          to="360 8 8"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

/* -----------------------------------------------------------------------------
   form fields
   -------------------------------------------------------------------------- */

export function Field({
  label,
  help,
  error,
  required,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      {children}
      {help && !error && <span className="help">{help}</span>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Textarea(
  props: React.ComponentProps<'textarea'>,
) {
  return <textarea className="textarea" {...props} />;
}

export function Select({
  options,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: { value: string; label: string }[];
}) {
  // The native arrow sits hard against the border and cannot be moved, so it is
  // suppressed and drawn as our own chevron with room around it.
  return (
    <span className="select-wrap">
      <select className="select" {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="select-chevron" size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}


/* -----------------------------------------------------------------------------
   segmented control and tabs
   -------------------------------------------------------------------------- */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -----------------------------------------------------------------------------
   surfaces
   -------------------------------------------------------------------------- */

export function Card({
  title,
  subtitle,
  actions,
  dark,
  children,
  footer,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  dark?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={`card ${dark ? 'dark' : ''}`.trim()}>
      {(title || actions) && (
        <header className="card-head">
          <div className="grow">
            {title && <div className="h3">{title}</div>}
            {subtitle && <div className="small dim">{subtitle}</div>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      {children && <div className="card-body">{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

/**
 * Spend against a cap.
 *
 * Typography separates what was spent from what was allowed, so the eye lands
 * on the number that moves. Colour appears only when the ratio crosses a
 * threshold, and never alone: "near cap" and "over cap" are written out.
 */
export function SpendValue({
  spentUsd,
  budgetUsd,
  compact,
}: {
  spentUsd: number;
  budgetUsd: number;
  compact?: boolean;
}) {
  const ratio = budgetUsd > 0 ? spentUsd / budgetUsd : 0;
  const tone = spentUsd > budgetUsd ? 'bad' : ratio >= 0.7 ? 'warn' : '';
  const note = tone === 'bad' ? 'over cap' : tone === 'warn' ? 'near cap' : null;

  return (
    <span
      className={`spend ${tone}`.trim()}
      title={`${(ratio * 100).toFixed(0)}% of the cap spent. Recorded from the run ledger.`}
    >
      <span className="v mono">{formatUsd(spentUsd)}</span>
      <span className="cap mono">/ {formatUsd(budgetUsd)}</span>
      {note && !compact && <span className="note">{note}</span>}
    </span>
  );
}

/** Definition list used for provenance and detail blocks. */
export function KeyValues({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl style={{ margin: 0 }}>
      {rows.map((r) => (
        <div className="kv" key={r.k}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -----------------------------------------------------------------------------
   feedback
   -------------------------------------------------------------------------- */

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <div className="grow">
        {title && <div className="strong small">{title}</div>}
        {children && <div className="small body">{children}</div>}
      </div>
    </div>
  );
}

/**
 * Spec 10.2: an empty state says what is missing and what to do next. It never
 * shows invented KPIs or placeholder charts in place of absent data.
 */
export function EmptyState({
  title,
  body,
  action,
  secondary,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="h3">{title}</div>
      {body && <p>{body}</p>}
      {(action || secondary) && (
        <div className="row gap2">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="col gap2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skel text"
          style={{ width: `${100 - (i % 3) * 14}%` }}
        />
      ))}
      <span className="tiny dim">Loading</span>
    </div>
  );
}

/** Budget meter. Over-cap turns red and says so in text, not colour alone. */
export function BudgetMeter({
  spentUsd,
  budgetUsd,
  label = 'Budget',
}: {
  spentUsd: number;
  budgetUsd: number;
  label?: string;
}) {
  const ratio = budgetUsd > 0 ? Math.min(1, spentUsd / budgetUsd) : 0;
  const over = budgetUsd > 0 && spentUsd > budgetUsd;
  return (
    <div className="col gap1" style={{ minWidth: 150 }}>
      <div className="row between tiny">
        <span className="label">{label}</span>
        <span className="mono">
          ${spentUsd.toFixed(2)} / ${budgetUsd.toFixed(2)}
          {over ? ' over cap' : ''}
        </span>
      </div>
      <div
        className="meter"
        data-over={over ? 'true' : 'false'}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={budgetUsd}
        aria-valuenow={spentUsd}
        aria-label={`${label}: ${spentUsd.toFixed(2)} of ${budgetUsd.toFixed(2)} US dollars`}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
