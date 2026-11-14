"use client";
import type { Lens, LensResolution } from "@nearesis/contracts";
import { Button } from "@nearesis/ui";
import { useState } from "react";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import type { PanelRef } from "./MarkersTab.tsx";
import { fmtTime } from "./shared.tsx";

export interface LensApplication {
  lensId: string;
  resolution: LensResolution;
}

const toLocalInput = (iso: string | undefined) => (iso ? iso.slice(0, 16) : "");
const fromLocalInput = (v: string) => (v ? `${v}:00.000Z` : "");

export function LensesTab(p: {
  store: MonitoringStore;
  panels: PanelRef[];
  /** Interval of the current chart selection, offered as the lens range. */
  selectionInterval: { start: string; end: string } | null;
  active: LensApplication | null;
  onApply: (lensId: string | null) => Promise<void>;
  onNotice: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [start, setStart] = useState(toLocalInput(p.selectionInterval?.start));
  const [end, setEnd] = useState(toLocalInput(p.selectionInterval?.end));
  const [dimension, setDimension] = useState("");
  const [values, setValues] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    const s = fromLocalInput(start);
    const e = fromLocalInput(end);
    if (!name.trim()) return setErr("Name the lens.");
    if (!picked.length) return setErr("Choose at least one panel.");
    if ((s || e) && !(s && e && Date.parse(s) < Date.parse(e)))
      return setErr("The time range needs a start before its end.");
    const vals = values
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if ((dimension.trim() === "") !== (vals.length === 0))
      return setErr("A segment needs both a dimension and at least one value.");
    if (!s && !dimension.trim()) return setErr("Set a time range or a segment.");
    setErr(null);
    const r = await p.store.act((api) =>
      api.createLens({
        name: name.trim(),
        panelIds: picked,
        filter: {
          ...(s ? { timeRange: { start: s, end: e } } : {}),
          ...(dimension.trim() ? { segment: { dimension: dimension.trim(), values: vals } } : {}),
        },
      }),
    );
    if (!r.ok) {
      setErr(`${r.reasonCode}: ${r.message}`);
      return;
    }
    setName("");
  };

  return (
    <div className="nz-split" data-testid="lenses-tab">
      <div className="nz-split-list">
        {p.store.data.lenses.length === 0 ? (
          <p className="nz-sb-meta" data-testid="lenses-empty">
            No lenses. A lens applies one shared filter to several panels without changing their certified
            definitions.
          </p>
        ) : (
          <ul className="nz-list" aria-label="Lenses">
            {p.store.data.lenses.map((l) => (
              <LensRow
                key={l.lensId}
                lens={l}
                panels={p.panels}
                active={p.active?.lensId === l.lensId}
                store={p.store}
                onApply={p.onApply}
              />
            ))}
          </ul>
        )}
        {p.active && (
          <div data-testid="lens-resolution" aria-live="polite">
            <h4 className="nz-h4">Compatibility</h4>
            <ul className="nz-plain-list">
              {p.active.resolution.panels.map((x) => (
                <li key={x.panelId} data-testid={`lens-panel-${x.panelId}`} data-compatible={x.compatible}>
                  {p.panels.find((q) => q.panelId === x.panelId)?.title ?? x.panelId.slice(0, 8)}:{" "}
                  {x.compatible ? "filter applied" : `not applied (${x.reason ?? "incompatible"})`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="nz-split-detail">
        <form
          className="nz-form"
          data-testid="lens-builder"
          aria-label="New lens"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h3 className="nz-h3">New lens</h3>
          <label className="nz-field-block">
            Name
            <input
              className="nz-input nz-wide"
              data-testid="lens-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="nz-fieldset">
            <legend>Panels</legend>
            {p.panels.length === 0 && <span className="nz-sb-meta">No panels on the canvas.</span>}
            {p.panels.map((x) => (
              <label key={x.panelId} className="nz-field-inline">
                <input
                  type="checkbox"
                  data-testid={`lens-pick-${x.panelId}`}
                  checked={picked.includes(x.panelId)}
                  onChange={(e) =>
                    setPicked((c) =>
                      e.target.checked ? [...c, x.panelId] : c.filter((i) => i !== x.panelId),
                    )
                  }
                />
                {x.title}
              </label>
            ))}
          </fieldset>
          <fieldset className="nz-fieldset">
            <legend>Time range (UTC)</legend>
            <div className="nz-row nz-row-wrap">
              <label className="nz-field-block">
                From
                <input
                  type="datetime-local"
                  className="nz-input nz-wide"
                  data-testid="lens-start"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className="nz-field-block">
                To
                <input
                  type="datetime-local"
                  className="nz-input nz-wide"
                  data-testid="lens-end"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
            </div>
            {p.selectionInterval && (
              <Button
                size="sm"
                onClick={() => {
                  setStart(toLocalInput(p.selectionInterval!.start));
                  setEnd(toLocalInput(p.selectionInterval!.end));
                }}
              >
                Use current selection ({fmtTime(p.selectionInterval.start)})
              </Button>
            )}
          </fieldset>
          <fieldset className="nz-fieldset">
            <legend>Segment (optional)</legend>
            <div className="nz-row nz-row-wrap">
              <input
                className="nz-input nz-wide"
                aria-label="Segment dimension"
                placeholder="dimension, e.g. intents.chain"
                value={dimension}
                onChange={(e) => setDimension(e.target.value)}
              />
              <input
                className="nz-input nz-wide"
                aria-label="Segment values"
                placeholder="values, comma separated"
                value={values}
                onChange={(e) => setValues(e.target.value)}
              />
            </div>
          </fieldset>
          {err && (
            <p role="alert" className="nz-error" data-testid="lens-error">
              {err}
            </p>
          )}
          <Button type="submit" variant="primary" size="sm" data-testid="lens-save">
            Create lens
          </Button>
        </form>
      </div>
    </div>
  );
}

function LensRow(p: {
  lens: Lens;
  panels: PanelRef[];
  active: boolean;
  store: MonitoringStore;
  onApply: (id: string | null) => Promise<void>;
}) {
  const l = p.lens;
  const f = l.filter;
  return (
    <li className="nz-list-item nz-list-item-col" data-testid={`lens-row-${l.lensId}`} data-active={p.active}>
      <b>{l.name}</b>
      <span className="nz-sb-meta">
        {l.panelIds.length} panel{l.panelIds.length === 1 ? "" : "s"}
        {f.timeRange ? ` · ${fmtTime(f.timeRange.start)} to ${fmtTime(f.timeRange.end)}` : ""}
        {f.segment ? ` · ${f.segment.dimension} in ${f.segment.values.join(", ")}` : ""}
      </span>
      <div className="nz-page-actions">
        <Button
          size="sm"
          aria-pressed={p.active}
          data-testid={`lens-apply-${l.lensId}`}
          onClick={() => void p.onApply(p.active ? null : l.lensId)}
        >
          {p.active ? "Clear lens" : "Apply lens"}
        </Button>
        <Button
          size="sm"
          data-testid={`lens-delete-${l.lensId}`}
          onClick={() =>
            void p.store
              .act((api) => api.deleteLens(l.lensId))
              .then(() => (p.active ? p.onApply(null) : undefined))
          }
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
