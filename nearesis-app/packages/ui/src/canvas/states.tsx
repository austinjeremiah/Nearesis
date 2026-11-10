import type { ReactNode } from "react";
import { Button, Skeleton } from "../primitives";

/** Quiet line-art for empty states: three bars, one axis. No illustration characters, no gradients. */
function EmptyArt() {
  return (
    <svg
      className="nz-state-art"
      viewBox="0 0 120 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 56h104" />
      <rect x="20" y="30" width="14" height="26" rx="2" />
      <rect x="44" y="18" width="14" height="38" rx="2" />
      <rect x="68" y="38" width="14" height="18" rx="2" strokeDasharray="3 3" />
      <path d="M92 40l8-10 8 6" strokeDasharray="3 3" />
    </svg>
  );
}

export function EmptyState({
  title,
  children,
  action,
  center,
  art = true,
  ...rest
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  center?: boolean;
  art?: boolean;
  "data-testid"?: string;
}) {
  return (
    <div className="nz-state" data-center={center ? "true" : undefined} {...rest}>
      {art ? <EmptyArt /> : null}
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  code,
  message,
  onRetry,
  children,
}: {
  code: string;
  message: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="nz-state" role="alert">
      <strong>This panel could not be drawn</strong>
      <div>
        <span className="nz-mono">{code}</span>: {message}
      </div>
      {children}
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Retry query
        </Button>
      ) : null}
    </div>
  );
}

/** Invalid stored spec (C09b): isolated, labelled, never instantiates a component. */
export function InvalidSpecState({
  index,
  issues,
}: {
  index: number;
  issues: Array<{ code: string; path: string }>;
}) {
  return (
    <div className="nz-state" data-testid={`invalid-panel-${index}`}>
      <strong>Invalid panel spec: this panel was not rendered</strong>
      <div>Its stored specification failed validation (stored panel #{index + 1}).</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {issues.slice(0, 6).map((i, k) => (
          <li key={k}>
            <span className="nz-mono">{i.code}</span> at <span className="nz-mono">{i.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Chart-shaped skeleton shown during VALIDATING and QUERYING. Heights are fixed so the card never reflows. */
export function ChartSkeleton() {
  return (
    <div
      role="status"
      style={{ padding: "8px 12px", display: "grid", gap: 10, height: "100%", alignContent: "start" }}
      aria-busy="true"
      aria-label="Loading chart"
    >
      <Skeleton width="38%" height={10} />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
        {[44, 70, 52, 88, 64, 96, 58, 80, 48, 72].map((h, i) => (
          <Skeleton key={i} width="100%" height={`${h}%`} />
        ))}
      </div>
      <Skeleton width="100%" height={8} />
    </div>
  );
}

export function WorkspaceOnboarding({ onAsk, onConnect }: { onAsk: () => void; onConnect?: () => void }) {
  const steps = [
    {
      t: "Ask a question",
      d: "Describe what you want to understand. An agent plans the queries and shows its work.",
      a: onAsk,
    },
    {
      t: "Check the sources",
      d: "See freshness and coverage for each connected source before you trust a number.",
      a: onConnect,
    },
    {
      t: "Pin what holds up",
      d: "Add verified panels to the canvas. Every panel keeps its query and provenance.",
      a: onAsk,
    },
  ];
  return (
    <div className="nz-onboard" data-testid="onboarding">
      <h1>This workspace is empty</h1>
      <p style={{ color: "var(--fg-muted)", marginTop: 4, maxWidth: "58ch" }}>
        Nothing is plotted until a query returns rows. Start with a question and the agent will build the
        first panels.
      </p>
      <div className="nz-onboard-steps">
        {steps.map((s) => (
          <button key={s.t} type="button" className="nz-onboard-step" onClick={s.a}>
            <b>{s.t}</b>
            <span>{s.d}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Page-level honesty banner (fixture or synthetic mode). Always visible, never dismissible. */
export function HonestyBanner({ children, ...rest }: { children: ReactNode; "data-testid"?: string }) {
  return (
    <div className="nz-banner" role="note" {...rest}>
      {children}
    </div>
  );
}
