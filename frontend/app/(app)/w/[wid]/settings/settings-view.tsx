'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Input, KeyValues, Notice, Skeleton, Textarea } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ConfirmDialog } from '@/components/nx/overlays';
import { ApiErrorState } from '@/components/nx/states';
import { WorkspaceTeam } from '@/components/nx/team';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
import { formatUtc } from '@/lib/format';

export default function SettingsView({ wid }: { wid: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['ws', wid, 'settings'] as const;
  const q = useQuery({ queryKey: key, queryFn: () => shellBrowser.settings(wid) });
  const me = useQuery({ queryKey: qk.me, queryFn: () => shellBrowser.me(), staleTime: 60_000 });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archiving, setArchiving] = useState(false);
  const s = q.data;
  useEffect(() => {
    if (s) {
      setName(s.name ?? '');
      setDescription(s.description ?? '');
    }
  }, [s]);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: qk.workspaces }), qc.invalidateQueries({ queryKey: ['global'] })]);
    router.refresh(); // the sidebar title comes from the server layout
  };
  const save = useMutation({
    mutationFn: () => shellBrowser.patchSettings(wid, { name: name.trim() || undefined, description: description.trim() ? description.trim() : null }),
    onSuccess: refresh,
  });
  const pin = useMutation({ mutationFn: (v: boolean) => shellBrowser.setPinned(wid, v), onSuccess: refresh });
  const archive = useMutation({
    mutationFn: (v: boolean) => shellBrowser.setArchived(wid, v),
    onSuccess: async () => {
      setArchiving(false);
      await refresh();
    },
  });

  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!s) return <Skeleton rows={5} />;
  const canWrite = me.data?.permissions.canWrite ?? false;
  const canAdmin = me.data?.permissions.canAdmin ?? false;
  const dirty = name.trim() !== (s.name ?? '') || description.trim() !== (s.description ?? '');

  return (
    <div className="col gap4" style={{ maxWidth: 860 }}>
      {s.archived && (
        <Notice tone="warn" title="This workspace is archived">
          Archived {formatUtc(s.archivedAt)}. {canAdmin ? 'Unarchive it to continue working.' : 'An admin can unarchive it.'}
        </Notice>
      )}
      <Card
        title="Profile"
        actions={
          <Button variant="ghost" onClick={() => pin.mutate(!s.pinned)} pending={pin.isPending} data-testid="pin-toggle" aria-pressed={s.pinned}>
            {s.pinned ? 'Unpin' : 'Pin to home'}
          </Button>
        }
      >
        <form
          className="col gap3"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && name.trim()) save.mutate();
          }}
        >
          <Field label="Name" help="Shown in the sidebar and lists. The objective below is not changed.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={s.displayName} data-testid="ws-name" disabled={!canWrite} />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} data-testid="ws-description" disabled={!canWrite} />
          </Field>
          {save.isError && <ApiErrorState error={save.error} />}
          {save.isSuccess && !dirty && <span className="small dim" data-testid="saved">Saved.</span>}
          <div className="row gap2">
            <Button type="submit" variant="primary" pending={save.isPending} disabled={!dirty || !name.trim() || !canWrite} disabledReason={!canWrite ? 'Your role cannot edit workspaces.' : 'Change the name or description first.'} data-testid="ws-save">
              Save
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Facts">
        <KeyValues
          rows={[
            { k: 'Objective', v: s.objective },
            { k: 'Network scope', v: <Badge outline>{s.networkScope}</Badge> },
            { k: 'Template', v: s.template ? s.template.name : 'None (created blank)' },
            { k: 'Workspace id', v: <span className="mono small">{s.workspaceId}</span> },
            { k: 'Created', v: <span className="mono small">{formatUtc(s.createdAt)}</span> },
            { k: 'Your role', v: <Badge tone="info">{s.myRole}</Badge> },
          ]}
        />
      </Card>

      <WorkspaceTeam workspaceId={wid} canAdmin={canAdmin} />

      <Card title={s.archived ? 'Unarchive' : 'Archive'} subtitle="Archiving hides the workspace from active lists. Nothing is deleted.">
        {archive.isError && <ApiErrorState error={archive.error} />}
        <Button
          variant={s.archived ? 'secondary' : 'danger'}
          disabled={!canAdmin}
          disabledReason="Owners and admins can archive."
          onClick={() => (s.archived ? archive.mutate(false) : setArchiving(true))}
          pending={archive.isPending}
          data-testid="archive-toggle"
        >
          {s.archived ? 'Unarchive workspace' : 'Archive workspace'}
        </Button>
      </Card>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this workspace"
        body="It will be marked archived. Runs, evidence and capsules are kept, and an admin can unarchive it."
        confirmLabel="Archive"
        danger
        pending={archive.isPending}
        onConfirm={() => archive.mutate(true)}
      />
    </div>
  );
}
