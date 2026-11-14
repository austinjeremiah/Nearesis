import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
} from "react";
import { IconGrip } from "../icons";
import { useFlashOnChange } from "../motion";
import { Badge } from "../primitives";
import type { PanelState } from "../types";
import { PanelStateBadge } from "./badges";

export interface PanelCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  panelId: string;
  /** Panel kind (timeSeries, bar, table, note, evidenceGraph...): exposed as data-panel-kind for tests. */
  kind?: string;
  title: string;
  state: PanelState;
  /** Grid placement, 0-based x/y, spans w/h (12 columns). */
  layout: { x: number; y: number; w: number; h: number };
  selected?: boolean;
  /** Increment (e.g. dataRevision or documentRevision) to play the one-shot "patch applied" ring. */
  patchKey?: unknown;
  /** Play the enter animation (panels added by an agent run). */
  entering?: boolean;
  /** Badges row: FreshnessBadge, CompletenessBadge, ProvenanceChip, units. */
  meta?: ReactNode;
  /** Tool row: select range, threshold, mark selection. */
  toolbar?: ReactNode;
  /** Right side of the header: overflow menu and so on. */
  actions?: ReactNode;
  /** Stale/error/honesty notices rendered under the header. */
  notices?: ReactNode;
  footer?: ReactNode;
  inspector?: ReactNode;
  /** Visually hidden text alternative. */
  textAlternative?: string;
  gripLabel?: string;
  onGripPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onGripPointerUp?: PointerEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  children: ReactNode;
}

/**
 * Canvas panel: header (grip, title, state), meta row, notices, body, footer. Every slot accepts the existing data-testid
 * elements unchanged, so apps/web keeps its selectors when it adopts this card.
 */
export function PanelCard({
  panelId,
  kind,
  title,
  state,
  layout,
  selected,
  patchKey,
  entering,
  meta,
  toolbar,
  actions,
  notices,
  footer,
  inspector,
  textAlternative,
  gripLabel,
  onGripPointerDown,
  onGripPointerUp,
  children,
  style,
  ...rest
}: PanelCardProps) {
  const flash = useFlashOnChange(patchKey);
  const place: CSSProperties = {
    gridColumn: `${layout.x + 1} / span ${Math.min(12, layout.w)}`,
    gridRow: `${layout.y + 1} / span ${layout.h}`,
    ...style,
  };
  return (
    <section
      className="nz-panel"
      data-testid={`panel-${panelId}`}
      data-panel-kind={kind}
      data-panel-state={state}
      data-state={state}
      data-selected={selected ? "true" : undefined}
      data-flash={flash ? "true" : undefined}
      data-enter={entering ? "true" : undefined}
      aria-labelledby={`t-${panelId}`}
      tabIndex={0}
      style={place}
      {...rest}
    >
      <div className="nz-panel-head">
        {onGripPointerDown ? (
          <button
            type="button"
            className="nz-grip"
            aria-label={gripLabel ?? `Move panel ${title} (or focus the panel and press Alt+Arrow)`}
            onPointerDown={onGripPointerDown}
            onPointerUp={onGripPointerUp}
          >
            <IconGrip />
          </button>
        ) : null}
        <h2 className="nz-panel-title" id={`t-${panelId}`} data-testid="panel-title">
          {title}
        </h2>
        <PanelStateBadge state={state} data-testid="panel-state" />
        {actions}
      </div>
      {meta ? <div className="nz-panel-meta">{meta}</div> : null}
      {toolbar ? <div className="nz-panel-toolbar">{toolbar}</div> : null}
      {notices}
      <div className="nz-panel-body">{children}</div>
      {footer ? <div className="nz-panel-foot">{footer}</div> : null}
      {textAlternative ? (
        <p className="nz-sr-only" data-testid="text-alternative">
          {textAlternative}
        </p>
      ) : null}
      {inspector}
    </section>
  );
}

export function PanelNotice({
  tone,
  children,
  role,
  ...rest
}: {
  tone: "warn" | "bad" | "honesty";
  children: ReactNode;
  role?: "status" | "alert";
  "data-testid"?: string;
}) {
  return (
    <div
      className="nz-notice"
      data-tone={tone}
      role={role ?? (tone === "bad" ? "alert" : "status")}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Inspector({ data, ...rest }: { data: unknown; "data-testid"?: string }) {
  return (
    <pre className="nz-inspector" {...rest}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function UnitsBadge({ units, ...rest }: { units: Array<[string, string]>; "data-testid"?: string }) {
  return (
    <Badge tone="plain" {...rest}>
      units: {units.length ? units.map(([f, u]) => `${f.split(".").pop()}=${u}`).join(", ") : "n/a"}
    </Badge>
  );
}
