'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CollabProvider, type CollabScope } from './provider';

/** One provider per mounted consumer and scope; re-renders on status, peers and document changes. */
export function useCollab(wid: string, scope: CollabScope, presence?: Record<string, unknown>) {
  const [p, setP] = useState<CollabProvider | null>(null);
  useEffect(() => {
    const provider = new CollabProvider(wid, scope, presence);
    setP(provider);
    return () => {
      setP(null);
      provider.destroy();
    };
    // presence is sent on open and via setPresence; it must not reopen the socket
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wid, scope]);
  useSyncExternalStore(
    (fn) => (p ? p.subscribe(fn) : () => {}),
    () => (p ? p.getVersion() : -1),
    () => -1,
  );
  return p;
}
