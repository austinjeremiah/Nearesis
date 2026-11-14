'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { ik, investigateApi } from '@/lib/investigate/api';
import { research, rk } from '@/lib/research/api';
import type { CanvasDocument } from '@/lib/panel/types';
import { panelKeys } from '@/lib/panel/keys';

/** Runs `fn` when `value` changes after the first render (never on mount). */
export function useOnChange<T>(value: T, fn: () => void) {
  const prev = useRef(value);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      f.current();
    }
  }, [value]);
}

const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;

/** The canvas shares its key with the canvas page and the old charts view. Polled only while the agent is working. */
export function useCanvasDoc(wid: string | null, live: boolean) {
  return useQuery({
    queryKey: wid ? qk.canvas(wid) : ['agent', 'nocanvas'],
    queryFn: () => browserApi.get<CanvasDocument>(`${ws(wid!)}/canvas`),
    enabled: !!wid,
    staleTime: 15_000,
    refetchInterval: live ? 6000 : false,
    retry: false,
  });
}

export function useWorkspaceDoc(wid: string | null) {
  return useQuery({ queryKey: wid ? qk.workspace(wid) : ['agent', 'nows'], queryFn: () => browserApi.workspace(wid!), enabled: !!wid, staleTime: 60_000, retry: false });
}

/** The run, kept in the same cache entry the run card and the run page use. Polls only while it has not ended. */
export function useRunDoc(wid: string | null, runId: string | null | undefined, active: boolean) {
  return useQuery({
    queryKey: wid && runId ? ik.run(wid, runId) : ['agent', 'norun'],
    queryFn: () => investigateApi.run(runId!),
    enabled: !!wid && !!runId,
    staleTime: 10_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.terminal || !active ? false : 4000),
  });
}

export function useRunTasks(wid: string | null, runId: string | null | undefined, active: boolean, enabled: boolean) {
  return useQuery({
    queryKey: wid && runId ? ik.tasks(wid, runId) : ['agent', 'notasks'],
    queryFn: () => investigateApi.tasks(runId!),
    enabled: !!wid && !!runId && enabled,
    staleTime: 15_000,
    retry: false,
    refetchInterval: active ? 5000 : false,
  });
}

export const useMarkerList = (wid: string | null, enabled: boolean) =>
  useQuery({ queryKey: wid ? [...qk.markers(wid), 'list'] : ['agent', 'nomarkers'], queryFn: () => research.markers(wid!), enabled: !!wid && enabled, staleTime: 15_000, retry: false });

export const useRuleList = (wid: string | null, enabled: boolean) =>
  useQuery({ queryKey: wid ? rk.rules(wid) : ['agent', 'norules'], queryFn: () => research.rules(wid!), enabled: !!wid && enabled, staleTime: 15_000, retry: false });

export const useEvaluationList = (wid: string | null, enabled: boolean) =>
  useQuery({ queryKey: wid ? rk.evaluations(wid) : ['agent', 'noevals'], queryFn: () => research.evaluations(wid!), enabled: !!wid && enabled, staleTime: 15_000, retry: false });

export const useTriggerList = (wid: string | null, enabled: boolean) =>
  useQuery({ queryKey: wid ? rk.triggers(wid) : ['agent', 'notriggers'], queryFn: () => research.triggers(wid!), enabled: !!wid && enabled, staleTime: 15_000, retry: false });

export const useHypothesisList = (wid: string | null, enabled: boolean) =>
  useQuery({ queryKey: wid ? rk.hypotheses(wid) : ['agent', 'nohyp'], queryFn: () => research.hypotheses(wid!), enabled: !!wid && enabled, staleTime: 15_000, retry: false });

export { panelKeys };
