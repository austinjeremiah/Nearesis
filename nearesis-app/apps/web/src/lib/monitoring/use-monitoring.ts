"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hooks } from "../test-hooks.ts";
import type { CommandResult, MonitoringApi, MonitoringSnapshot } from "./api.ts";
import { HttpMonitoringApi } from "./http.ts";
import { TestMonitoringAdapter } from "./test-adapter.ts";

const POLL_MS = 3000;
export const EMPTY: MonitoringSnapshot = {
  markers: [],
  lenses: [],
  rules: [],
  triggers: [],
  notifications: [],
  tasks: [],
  evaluations: [],
  counters: { day: "", live: 0, replay: 0 },
};

/**
 * Picks the implementation. The kernel API is the default whenever the workspace is kernel-backed. The in-memory test
 * adapter is used only when the URL asks for it, and the UI labels it. Fixture mode without the flag has no monitoring.
 */
export function createMonitoringApi(
  search: URLSearchParams,
  workspaceId: string,
  mode: "kernel" | "fixture" | null,
): MonitoringApi | null {
  if (search.get("monitoring") === "test-adapter") return new TestMonitoringAdapter(workspaceId);
  if (mode === "kernel") return new HttpMonitoringApi(workspaceId);
  return null;
}

export type MonitoringStatus = "off" | "loading" | "ready" | "degraded";

export interface MonitoringStore {
  api: MonitoringApi | null;
  status: MonitoringStatus;
  /** Last load failure (HTTP status or 0 for network). Last good data stays visible while degraded. */
  error: { status: number; message: string } | null;
  data: MonitoringSnapshot;
  lastLoadedAt: string | null;
  refresh: () => Promise<void>;
  /** Runs a command, surfaces its structured failure, then refreshes. Never optimistic: the UI shows backend state. */
  act: (fn: (api: MonitoringApi) => Promise<CommandResult>) => Promise<CommandResult>;
  unread: number;
}

export function useMonitoring(
  workspaceId: string,
  mode: "kernel" | "fixture" | null,
  enabled: boolean,
): MonitoringStore {
  const [api, setApi] = useState<MonitoringApi | null>(null);
  const [data, setData] = useState<MonitoringSnapshot>(EMPTY);
  const [status, setStatus] = useState<MonitoringStatus>("off");
  const [error, setError] = useState<MonitoringStore["error"]>(null);
  const [lastLoadedAt, setLast] = useState<string | null>(null);
  const apiRef = useRef<MonitoringApi | null>(null);

  useEffect(() => {
    if (!enabled || mode === null) return;
    const a = createMonitoringApi(new URLSearchParams(window.location.search), workspaceId, mode);
    apiRef.current = a;
    setApi(a);
    hooks().monitoring = a;
    setStatus(a ? "loading" : "off");
  }, [workspaceId, mode, enabled]);

  const refresh = useCallback(async () => {
    const a = apiRef.current;
    if (!a) return;
    const r = await a.load();
    if (r.ok) {
      setData(r.snapshot);
      setError(null);
      setStatus("ready");
      setLast(new Date().toISOString());
    } else {
      setError({ status: r.status, message: r.message });
      setStatus("degraded");
    }
  }, []);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [api, refresh]);

  const act = useCallback(
    async (fn: (a: MonitoringApi) => Promise<CommandResult>) => {
      const a = apiRef.current;
      if (!a)
        return { ok: false, status: 0, reasonCode: "NO_BACKEND", message: "monitoring unavailable" } as const;
      const r = await fn(a);
      await refresh();
      return r;
    },
    [refresh],
  );

  const unread = useMemo(() => data.notifications.filter((n) => n.readAt === null).length, [data]);
  return { api, status, error, data, lastLoadedAt, refresh, act, unread };
}
