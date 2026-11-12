import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import AppFrame from '@/components/nx/app-frame';
import * as db from '@/lib/data/client';

/**
 * Workspace shell.
 *
 * Spec 1.3: a workspace in another tenant must return the same protected
 * not-found as one that does not exist, so this resolves through the same path
 * for both and never distinguishes them in the response.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ wid: string }>;
}) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  return (
    <AppFrame workspaceId={wid} workspaceName={ws.name}>
      {children}
    </AppFrame>
  );
}
