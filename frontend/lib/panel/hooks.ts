'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { newKey } from '@/lib/api/transport';
import { qk } from '@/lib/api/keys';
import { useWorkspaceEvents } from '@/lib/sse/hub';
import type { CanvasDocument, CanvasPanel, Lens, LensResolution, PanelData, PanelProgress } from './types';
import { panelKeys } from './keys';
import { buildPatch, inverse, previewDoc, type PatchOp } from './edit';

const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;

export function useCanvas(wid: string) {
  return useQuery({ queryKey: qk.canvas(wid), queryFn: () => browserApi.get<CanvasDocument>(`${ws(wid)}/canvas`) });
}

/**
 * Data of one panel by query hash (certified and analytics on one route). `enabled`
 * lets the canvas fetch lazily, panel by panel, as each scrolls into view.
 */
export function usePanelData(wid: string, hash: string | undefined, enabled = true, source?: 'fixture' | 'live') {
  return useQuery({
    queryKey: panelKeys.data(wid, hash ?? '', source),
    enabled: enabled && !!hash,
    staleTime: 60_000,
    queryFn: ({ signal }) => browserApi.get<PanelData>(`${ws(wid)}/panels/${hash}/data`, { query: { source }, signal }),
  });
}

export function useLenses(wid: string) {
  return useQuery({ queryKey: panelKeys.lenses(wid), queryFn: () => browserApi.get<{ lenses: Lens[] }>(`${ws(wid)}/lenses`) });
}

export function useLensResolution(wid: string, lensId: string | null) {
  return useQuery({
    queryKey: panelKeys.lensRes(wid, lensId ?? ''),
    enabled: !!lensId,
    queryFn: () => browserApi.get<LensResolution>(`${ws(wid)}/lenses/${lensId}/resolution`),
  });
}

/**
 * Live panel state from the event stream. `query.completed` carries one frame per
 * panel status change (QUERYING, READY, ERROR) with index/total, and drives the
 * per-panel skeleton. `panel.updated` / READY refetch just that panel's data.
 */
export function usePanelProgress(wid: string) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<Record<string, { status: PanelProgress; index: number; total: number; reason?: string }>>({});
  const canvasRef = useRef<CanvasDocument | undefined>(undefined);
  canvasRef.current = qc.getQueryData<CanvasDocument>(qk.canvas(wid));
  const onEvent = useCallback(
    (e: { event: string; data: Record<string, unknown> }) => {
      const d = e.data;
      if (e.event === 'query.completed' && typeof d.panelId === 'string') {
        const status = d.status as PanelProgress;
        setProgress((p) => ({ ...p, [d.panelId as string]: { status, index: Number(d.index ?? 0), total: Number(d.total ?? 0), reason: typeof d.reasonCode === 'string' ? d.reasonCode : undefined } }));
        if (status === 'READY') {
          const hash = typeof d.queryHash === 'string' ? d.queryHash : canvasRef.current?.panels.find((p) => p.panelId === d.panelId)?.queryRef?.hash;
          if (hash) void qc.invalidateQueries({ queryKey: ['ws', wid, 'panel-data', hash] });
        }
      }
      if (e.event === 'panel.updated' || e.event === 'canvas.patched') {
        void qc.invalidateQueries({ queryKey: panelKeys.allData(wid) });
      }
    },
    [qc, wid],
  );
  useWorkspaceEvents(wid, onEvent as never);
  return progress;
}

export type EditError =
  | { kind: 'conflict'; message: string; lastStableRevision: number | null }
  | { kind: 'rejected'; message: string; issues: { path: string; issue: string }[] }
  | { kind: 'other'; message: string };

function toEditError(e: unknown): EditError {
  if (e instanceof ApiRequestError) {
    if (e.kind === 'stale_version') return { kind: 'conflict', message: e.message, lastStableRevision: e.lastStableRevision };
    if (e.kind === 'validation') return { kind: 'rejected', message: e.message, issues: e.details };
    return { kind: 'other', message: e.message };
  }
  return { kind: 'other', message: e instanceof Error ? e.message : 'Request failed' };
}

type Applied = { undo: PatchOp[]; redo: PatchOp[] };

/**
 * Canvas editing through the kernel command API.
 *   - edits queue as a pending patch and show locally (`draftPanels`)
 *   - `preview()` is the pure server preview (per-op report, cost estimate)
 *   - `apply()` sends `canvas.apply_patch` with `If-Match: <workspace version>` and the canvas revision
 *   - applied patches are undoable and redoable; each undo/redo is another revision
 */
export function useCanvasEditor(wid: string, doc: CanvasDocument | undefined) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PatchOp[]>([]);
  const [undoStack, setUndo] = useState<Applied[]>([]);
  const [redoStack, setRedo] = useState<Applied[]>([]);
  const [error, setError] = useState<EditError | null>(null);
  const [lastApplied, setLastApplied] = useState<{ version: number; revision: number } | null>(null);

  const draftPanels: CanvasPanel[] = useMemo(() => (doc ? previewDoc(doc, pending) : []), [doc, pending]);
  const draftDoc = useMemo(() => (doc ? { ...doc, panels: draftPanels } : undefined), [doc, draftPanels]);

  const queue = useCallback((ops: PatchOp[] | null) => {
    if (!ops?.length) return;
    setError(null);
    // One panel keeps only its latest move: absolute layouts make the earlier ones redundant, and the diff stays short.
    setPending((p) => {
      const moved = new Set(ops.flatMap((o) => (o.op === 'movePanel' ? [o.panelId] : [])));
      return [...p.filter((o) => !(o.op === 'movePanel' && moved.has(o.panelId))), ...ops];
    });
  }, []);
  const discard = useCallback(() => {
    setPending([]);
    setError(null);
  }, []);

  const send = useCallback(
    async (d: CanvasDocument, ops: PatchOp[]) => {
      // Always read the workspace version fresh: If-Match is the workspace version, not the canvas revision.
      const w = await browserApi.workspace(wid);
      const patch = buildPatch(d, ops, crypto.randomUUID());
      const out = await browserApi.send<{ workspaceVersion: number }>(
        'POST',
        `${ws(wid)}/commands`,
        { apiVersion: 'v1', commandId: crypto.randomUUID(), commandType: 'canvas.apply_patch', payload: patch, expectedVersion: w.version },
        { ifMatch: w.version, idempotencyKey: patch.operationId },
      );
      setLastApplied({ version: out.workspaceVersion, revision: d.documentRevision + 1 });
      await qc.invalidateQueries({ queryKey: qk.canvas(wid) });
      await qc.invalidateQueries({ queryKey: qk.workspace(wid) });
      return out;
    },
    [qc, wid],
  );

  const previewM = useMutation({
    mutationFn: (): Promise<PreviewResult> => {
      if (!doc) throw new Error('No canvas');
      return browserApi.send<PreviewResult>('POST', `${ws(wid)}/canvas/preview`, buildPatch(doc, pending, crypto.randomUUID()), { idempotencyKey: false });
    },
    onMutate: () => setError(null),
    onError: (e) => setError(toEditError(e)),
  });

  const applyM = useMutation({
    mutationFn: async () => {
      if (!doc) throw new Error('No canvas');
      const ops = pending;
      const undo = inverse(doc, ops);
      await send(doc, ops);
      return { undo, redo: ops } as Applied;
    },
    onMutate: () => setError(null),
    onSuccess: (a) => {
      setUndo((s) => [...s, a]);
      setRedo([]);
      setPending([]);
      previewM.reset();
    },
    onError: (e) => setError(toEditError(e)),
  });

  const undoM = useMutation({
    mutationFn: async () => {
      const a = undoStack[undoStack.length - 1];
      if (!doc || !a) throw new Error('Nothing to undo');
      const fresh = (await browserApi.get<CanvasDocument>(`${ws(wid)}/canvas`)) ?? doc;
      await send(fresh, a.undo);
      return a;
    },
    onMutate: () => setError(null),
    onSuccess: (a) => {
      setUndo((s) => s.slice(0, -1));
      setRedo((s) => [...s, a]);
    },
    onError: (e) => setError(toEditError(e)),
  });

  const redoM = useMutation({
    mutationFn: async () => {
      const a = redoStack[redoStack.length - 1];
      if (!doc || !a) throw new Error('Nothing to redo');
      const fresh = (await browserApi.get<CanvasDocument>(`${ws(wid)}/canvas`)) ?? doc;
      await send(fresh, a.redo);
      return a;
    },
    onMutate: () => setError(null),
    onSuccess: (a) => {
      setRedo((s) => s.slice(0, -1));
      setUndo((s) => [...s, a]);
    },
    onError: (e) => setError(toEditError(e)),
  });

  /** After a conflict: refetch the canvas and the version, keep the pending edits, and let the user apply again. */
  const reload = useCallback(async () => {
    setError(null);
    previewM.reset();
    await qc.invalidateQueries({ queryKey: qk.canvas(wid) });
    await qc.invalidateQueries({ queryKey: qk.workspace(wid) });
  }, [qc, wid, previewM]);

  // A different canvas or a reload-required event drops history that no longer applies.
  useEffect(() => {
    setUndo([]);
    setRedo([]);
    setPending([]);
  }, [wid]);

  return {
    pending,
    queue,
    discard,
    draftPanels,
    draftDoc,
    preview: previewM,
    apply: applyM,
    undo: () => undoM.mutate(),
    redo: () => redoM.mutate(),
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    busy: applyM.isPending || undoM.isPending || redoM.isPending,
    error,
    reload,
    lastApplied,
    newKey,
  };
}

export type PreviewResult = {
  previewHash: string;
  baseRevision: number;
  operations: { index: number; op: string; ok: boolean; issues: unknown[] }[];
  estimate: {
    queryCount: number;
    estimatedRows: number;
    bytesEstimated: number;
    estimatedCostUsd: number | null;
    costBasis: string;
    atRiskPanelIds: string[];
    removedPanelIds: string[];
    queries: { panelId: string; op: string; queryHash: string | null; kind: string; status: string; estimatedRows: number | null; bytesEstimated: number | null; withinCap: boolean | null; cached: boolean | null; reasonCode: string | null }[];
  };
};

/** Lens commands. Lenses are created and deleted through the command API with `If-Match`. */
export function useLensCommands(wid: string) {
  const qc = useQueryClient();
  const run = async (commandType: 'lens.create' | 'lens.delete', payload: Record<string, unknown>) => {
    const w = await browserApi.workspace(wid);
    await browserApi.send('POST', `${ws(wid)}/commands`, { apiVersion: 'v1', commandId: crypto.randomUUID(), commandType, payload, expectedVersion: w.version }, { ifMatch: w.version });
    await qc.invalidateQueries({ queryKey: panelKeys.lenses(wid) });
    await qc.invalidateQueries({ queryKey: qk.workspace(wid) });
  };
  return {
    create: useMutation({ mutationFn: (p: { name: string; panelIds: string[]; filter: Lens['filter'] }) => run('lens.create', p) }),
    remove: useMutation({ mutationFn: (lensId: string) => run('lens.delete', { lensId }) }),
  };
}
