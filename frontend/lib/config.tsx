'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Config } from './types';

type Ctx = { cfg: Config | null; error: unknown; loading: boolean };
const ConfigCtx = createContext<Ctx>({ cfg: null, error: null, loading: true });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 10 * 60_000, retry: 2 });
  return <ConfigCtx.Provider value={{ cfg: q.data ?? null, error: q.error, loading: q.isLoading }}>{children}</ConfigCtx.Provider>;
}
export const useConfig = () => useContext(ConfigCtx);

/** Format a base-unit FUSD amount with the decimals from /v1/config (6). */
export function useDecimals() {
  return useConfig().cfg?.assetDecimals ?? 6;
}
