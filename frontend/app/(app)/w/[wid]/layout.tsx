import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import AppFrame from '@/components/nx/app-frame';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';

/**
 * Workspace shell.
 *
 * Spec 1.3: a workspace in another tenant must return the same protected
 * not-found as one that does not exist. The API answers both with the same
 * 404, and this maps every 404 (and a malformed id) to notFound() without
 * distinguishing them.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ wid: string }>;
}) {
  const { wid } = await params;
  if (!UUID.test(wid)) notFound();
  const r = await settle(api.workspace(wid));
  if (!r.ok) {
    if (r.error.kind === 'not_found') notFound();
    return (
      <AppFrame workspaceId={null}>
        <div className="content">
          <ApiErrorState error={r.error} />
        </div>
      </AppFrame>
    );
  }
  return (
    <AppFrame workspaceId={wid} workspaceName={workspaceLabel(r.data.objective)}>
      {children}
    </AppFrame>
  );
}
