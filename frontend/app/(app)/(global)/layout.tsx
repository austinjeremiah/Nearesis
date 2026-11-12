import type { ReactNode } from 'react';
import AppFrame from '@/components/nx/app-frame';

/** Global area: the shell without an active workspace, per spec 2.1. */
export default function GlobalLayout({ children }: { children: ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
