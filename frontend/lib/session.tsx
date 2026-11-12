'use client';
import { useSyncExternalStore } from 'react';

const KEY = 'forkos.owner.v1';
export type OwnerSession = { token: string; humanHash: string; budgetAccountId: string };

const subs = new Set<() => void>();
let cache: OwnerSession | null | undefined;

function read(): OwnerSession | null {
  if (typeof window === 'undefined') return null;
  if (cache !== undefined) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    cache = v && typeof v.token === 'string' && v.token.startsWith('fos_') ? v : null;
  } catch {
    cache = null;
  }
  return cache ?? null;
}
function emit() { subs.forEach((f) => f()); }

export const session = {
  get: read,
  token: () => read()?.token ?? null,
  set(s: OwnerSession) {
    cache = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: memory only */ }
    emit();
  },
  clear() {
    cache = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    emit();
  },
  subscribe(f: () => void) { subs.add(f); return () => subs.delete(f); },
};

/** null on the server and when signed out. */
export function useOwner(): OwnerSession | null {
  return useSyncExternalStore(session.subscribe, read, () => null);
}
