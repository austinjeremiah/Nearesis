'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The marketing site's own devices, reused inside the product.
 *
 * These are not decoration borrowed for its own sake. The landing page teaches
 * a visitor four shapes: a numbered tab strip, an oversized uppercase title
 * with one word marked in green, a notched green kicker, and a bracketed call
 * to action that fills on hover. Using the same four inside the app means the
 * person who read the site recognises the product, instead of meeting a
 * generic dashboard that happens to share a palette.
 *
 * Density stays where it is: these are for page headers and empty states, not
 * for tables, canvases or anything that has to hold a lot of rows.
 */

/** The notched green tag, from the landing's PROVE IT label. */
export function Kicker({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'ink' }) {
  return (
    <span className="kicker" data-tone={tone}>
      <span className="sq" aria-hidden="true" />
      <span className="chev" aria-hidden="true">
        &gt;&gt;&gt;&gt;
      </span>
      <span className="txt">{children}</span>
    </span>
  );
}

/**
 * The oversized title. `mark` is the one word or phrase that gets the green
 * highlight, exactly as EVIDENCE-FIRST RESEARCH does on the landing page.
 */
export function DisplayTitle({
  children,
  mark,
  as: Tag = 'h1',
}: {
  children: ReactNode;
  mark?: string;
  as?: 'h1' | 'h2';
}) {
  return (
    <Tag className="display-title">
      {children}
      {mark && <span className="mark">{mark}</span>}
    </Tag>
  );
}

/**
 * The numbered tab strip. Equal columns, hard rules between them, the active
 * tab filled with ink under a green top rule, its number set in mono on the
 * right. Same component the landing uses for Ask / Compose / Delegate / Publish.
 */
export function TabStrip<T extends string>({
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
    <div className="tabstrip" role="tablist" aria-label={ariaLabel}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className="tabstrip-tab"
          onClick={() => onChange(o.value)}
        >
          <span className="t">{o.label}</span>
          <span className="n">{String(i + 1).padStart(2, '0')}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The bracketed call to action. Corner marks at rest, a filled ink box on
 * hover, and the label rolls up to its duplicate so the change reads as a
 * mechanism rather than a colour swap.
 */
export function BracketButton({
  href,
  onClick,
  children,
  disabled,
  disabledReason,
}: {
  href?: string;
  onClick?: () => void;
  children: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const inner = (
    <>
      <span className="corner tl" aria-hidden="true" />
      <span className="corner tr" aria-hidden="true" />
      <span className="corner bl" aria-hidden="true" />
      <span className="corner br" aria-hidden="true" />
      <span className="roll">
        <span>{children}</span>
        <span aria-hidden="true">{children}</span>
      </span>
    </>
  );

  if (href && !disabled) {
    return (
      <Link className="bracket-btn" href={href}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="bracket-btn"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      aria-disabled={disabled || undefined}
    >
      {inner}
    </button>
  );
}

/**
 * A page header built from the landing devices: kicker, oversized title with a
 * marked word, lede, and the page's actions on the right. Used on the screens
 * a person lands on. Dense working screens keep the compact `PageHeader`.
 */
export function PageHero({
  kicker,
  title,
  mark,
  lede,
  context,
  actions,
}: {
  kicker?: string;
  title: string;
  mark?: string;
  lede?: string;
  context?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="pagehead display">
      <div className="head-row">
        <div className="titles">
          {kicker && <Kicker>{kicker}</Kicker>}
          <DisplayTitle mark={mark}>{title}</DisplayTitle>
        </div>
        <div className="col gap3" style={{ alignItems: 'flex-end' }}>
          {context && <div className="row gap2 wrap">{context}</div>}
          {actions && <div className="row gap3 wrap">{actions}</div>}
        </div>
      </div>
      {lede && <p className="lede small">{lede}</p>}
    </header>
  );
}
