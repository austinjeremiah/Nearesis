'use client';

import { useSyncExternalStore } from 'react';

/**
 * Range selection and marker hooks for other workstreams (marker creation, WS4).
 *
 * A selection is ephemeral: it never writes anything and never starts an agent
 * (spec 5.7). A consumer reads it with `usePanelSelection()` and decides whether
 * to turn it into a marker command (`marker.create`) after an explicit user action.
 *
 *   const sel = usePanelSelection();       // PanelSelection | null
 *   panelSelection.clear();
 *   const off = panelSelection.subscribe(() => ...);
 */
export type PanelSelection = {
  workspaceId: string;
  panelId: string;
  queryHash: string;
  /** Time column the range applies to. */
  seriesId: string;
  /** Inclusive range, ISO-8601 UTC. */
  start: string;
  end: string;
  /** Where it came from: a chart drag or the keyboard form. */
  origin: 'brush' | 'form';
  /** Data watermark of the panel when the selection was made. */
  sourceWatermark: string | null;
  at: number;
};

let current: PanelSelection | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const panelSelection = {
  get: () => current,
  set(sel: Omit<PanelSelection, 'at'> | null) {
    current = sel ? { ...sel, at: Date.now() } : null;
    emit();
  },
  clear() {
    this.set(null);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function usePanelSelection(): PanelSelection | null {
  return useSyncExternalStore(panelSelection.subscribe, panelSelection.get, () => null);
}

/** Request to create a marker from the current selection; WS4's marker form listens for this. */
export type MarkerDraft = { workspaceId: string; panelId: string; anchor: { kind: 'time_range'; start: string; end: string } | { kind: 'time_point'; at: string } };
export function draftMarkerFromSelection(sel: PanelSelection): MarkerDraft {
  return { workspaceId: sel.workspaceId, panelId: sel.panelId, anchor: sel.start === sel.end ? { kind: 'time_point', at: sel.start } : { kind: 'time_range', start: sel.start, end: sel.end } };
}

/**
 * Other pages can add actions next to the selection bar (for example WS4's
 * "Create marker"). Register a renderer; it receives the current selection.
 *
 *   useEffect(() => selectionActions.register((sel) => <Button .../>), []);
 */
import type { ReactNode } from 'react';
type ActionRenderer = (sel: PanelSelection) => ReactNode;
const renderers = new Set<ActionRenderer>();
const actionListeners = new Set<() => void>();
let actionVersion = 0;
export const selectionActions = {
  register(fn: ActionRenderer) {
    renderers.add(fn);
    actionVersion++;
    actionListeners.forEach((l) => l());
    return () => {
      renderers.delete(fn);
      actionVersion++;
      actionListeners.forEach((l) => l());
    };
  },
  list: () => [...renderers],
  subscribe(fn: () => void) {
    actionListeners.add(fn);
    return () => {
      actionListeners.delete(fn);
    };
  },
  version: () => actionVersion,
};
export function useSelectionActions(): ActionRenderer[] {
  useSyncExternalStore(selectionActions.subscribe, selectionActions.version, () => 0);
  return selectionActions.list();
}
