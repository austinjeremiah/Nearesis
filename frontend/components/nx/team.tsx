'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from './evidence';
import { DataTable, type Column } from './table';
import { ApiErrorState } from './states';
import { Button, Card, Field, Input, Notice, Select } from './ui';
import { ConfirmDialog } from './overlays';
import { shellBrowser } from '@/lib/api/shell-browser';
import { newKey } from '@/lib/api/transport';
import type { CreatedInvite, Invite, Member, Role } from '@/lib/api/shell';
import { formatAge, formatUtc } from '@/lib/format';

const INVITE_ROLES: { value: Exclude<Role, 'owner'>; label: string }[] = [
  { value: 'viewer', label: 'Viewer (read only)' },
  { value: 'analyst', label: 'Analyst (query, edit canvas, add markers)' },
  { value: 'admin', label: 'Admin (members, budgets, publishing)' },
];

const teamKey = (workspaceId?: string) => ['global', 'team', workspaceId ?? 'org'] as const;

/** Create an invite. The signed token is returned once by the API, so this is the only place the link is shown. */
export function InviteForm({ workspaceId }: { workspaceId?: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('analyst');
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [key, setKey] = useState(newKey);
  const create = useMutation({
    mutationFn: () => shellBrowser.createInvite({ email: email.trim(), role, workspaceId }, { idempotencyKey: key }),
    onSuccess: async (r) => {
      setCreated(r);
      setEmail('');
      setKey(newKey());
      await qc.invalidateQueries({ queryKey: ['global', 'team'] });
    },
  });
  const link = created && typeof window !== 'undefined' ? `${window.location.origin}${created.acceptPath}` : '';
  return (
    <Card title="Invite someone" subtitle="Invitations are signed, single use and expire. The link is shown once.">
      <form
        className="col gap3"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) create.mutate();
        }}
      >
        <div className="row gap3 wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" autoComplete="off" />
            </Field>
          </div>
          <div style={{ minWidth: 240 }}>
            <Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)} options={INVITE_ROLES} data-testid="invite-role" />
            </Field>
          </div>
          <Button type="submit" variant="primary" pending={create.isPending} disabled={!email.trim()} disabledReason="Enter an email." data-testid="invite-submit">
            Create invite
          </Button>
        </div>
        {create.isError && <ApiErrorState error={create.error} />}
        {created && (
          <Notice tone="ok" title={`Invite created for ${created.email}`}>
            <div className="col gap1" data-testid="invite-created">
              <span>Send this link to the invitee. It expires {formatUtc(created.expiresAt)} and cannot be shown again.</span>
              <input className="input mono" readOnly value={link} aria-label="Invite link" data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} />
            </div>
          </Notice>
        )}
      </form>
    </Card>
  );
}

function inviteTone(s: Invite['state']) {
  return s === 'pending' ? 'info' : s === 'accepted' ? 'ok' : 'warn';
}

/** Org-level team: members (role change, remove) and every invite with its state. Owner/admin only for invites. */
export function OrgTeam({ canAdmin, myRole }: { canAdmin: boolean; myRole: Role }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: [...teamKey(), 'members'], queryFn: () => shellBrowser.members() });
  const invites = useQuery({
    queryKey: [...teamKey(), 'invites'],
    queryFn: () => shellBrowser.invites(),
    enabled: canAdmin,
  });
  const [removing, setRemoving] = useState<Member | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['global', 'team'] });
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: Role }) => shellBrowser.setMemberRole(v.userId, v.role),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => shellBrowser.removeMember(userId),
    onSettled: () => {
      setRemoving(null);
      return refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => shellBrowser.revokeInvite(id), onSettled: refresh });

  const roleOptions = (['owner', 'admin', 'analyst', 'viewer'] as Role[])
    .filter((r) => r !== 'owner' || myRole === 'owner')
    .map((r) => ({ value: r, label: r }));

  const mcols: Column<Member>[] = [
    { key: 'name', header: 'Member', render: (m) => <span>{m.displayName ?? m.userId}{m.you && <span className="tiny dim"> (you)</span>}</span> },
    {
      key: 'role',
      header: 'Role',
      render: (m) =>
        canAdmin && !m.you ? (
          <Select
            aria-label={`Role of ${m.displayName ?? m.userId}`}
            value={m.role}
            options={m.role === 'owner' && myRole !== 'owner' ? [{ value: 'owner', label: 'owner' }] : roleOptions}
            disabled={m.role === 'owner' && myRole !== 'owner'}
            onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as Role })}
          />
        ) : (
          <Badge outline>{m.role}</Badge>
        ),
    },
    {
      key: 'act',
      header: '',
      render: (m) =>
        canAdmin && !m.you ? (
          <Button variant="ghost" onClick={() => setRemoving(m)} aria-label={`Remove ${m.displayName ?? m.userId}`}>
            Remove
          </Button>
        ) : null,
    },
  ];
  const icols: Column<Invite>[] = [
    { key: 'email', header: 'Invitee', render: (i) => <span className="mono small">{i.email}</span> },
    { key: 'role', header: 'Role', render: (i) => <Badge outline>{i.role}</Badge> },
    { key: 'state', header: 'State', render: (i) => <Badge tone={inviteTone(i.state)}>{i.state}</Badge> },
    { key: 'exp', header: 'Expires', render: (i) => <span className="small mono" title={formatUtc(i.expiresAt)}>{formatAge(i.expiresAt)}</span> },
    {
      key: 'act',
      header: '',
      render: (i) =>
        i.state === 'pending' ? (
          <Button variant="ghost" onClick={() => revoke.mutate(i.inviteId)} aria-label={`Revoke invite for ${i.email}`}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="col gap4">
      <Card title="Members">
        {members.isError ? (
          <ApiErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : (
          <div data-testid="members">
            <DataTable
              caption={`${members.data?.members.length ?? 0} members`}
              columns={mcols}
              rows={members.data?.members ?? []}
              rowKey={(m) => m.userId}
              state={{ status: members.isPending ? 'loading' : 'ready' }}
            />
          </div>
        )}
        {(setRole.isError || remove.isError) && <ApiErrorState error={setRole.error ?? remove.error} />}
      </Card>
      {canAdmin ? (
        <>
          <InviteForm />
          <Card title="Invitations">
            {invites.isError ? (
              <ApiErrorState error={invites.error} onRetry={() => invites.refetch()} />
            ) : (
              <div data-testid="invites">
                <DataTable
                  caption={`${invites.data?.invites.length ?? 0} invites`}
                  columns={icols}
                  rows={invites.data?.invites ?? []}
                  rowKey={(i) => i.inviteId}
                  state={{ status: invites.isPending ? 'loading' : (invites.data?.invites.length ?? 0) === 0 ? 'empty' : 'ready' }}
                  empty={{ title: 'No invitations', body: 'Invitations you create appear here with their state.' }}
                />
              </div>
            )}
            {revoke.isError && <ApiErrorState error={revoke.error} />}
          </Card>
        </>
      ) : (
        <Notice tone="info" title="Members are managed by owners and admins">
          Your role is {myRole}. Ask an owner or admin to change roles or invite people.
        </Notice>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title="Remove member"
        body={`${removing?.displayName ?? removing?.userId ?? ''} will lose access to every workspace in this organization. The last owner cannot be removed.`}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </div>
  );
}

/** A workspace's collaborators. Membership is org level, so roles are shown read-only here and managed in Settings. */
export function WorkspaceTeam({ workspaceId, canAdmin }: { workspaceId: string; canAdmin: boolean }) {
  const q = useQuery({ queryKey: [...teamKey(workspaceId), 'collab'], queryFn: () => shellBrowser.collaborators(workspaceId) });
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  const cols: Column<Member>[] = [
    { key: 'name', header: 'Collaborator', render: (m) => <span>{m.displayName ?? m.userId}{m.you && <span className="tiny dim"> (you)</span>}</span> },
    { key: 'role', header: 'Role', render: (m) => <Badge outline>{m.role}</Badge> },
  ];
  return (
    <div className="col gap4">
      <Card title="Collaborators" subtitle="Access is granted to the whole organization, so everyone here can open this workspace.">
        <div data-testid="collaborators">
          <DataTable
            caption={`${q.data?.collaborators.length ?? 0} collaborators`}
            columns={cols}
            rows={q.data?.collaborators ?? []}
            rowKey={(m) => m.userId}
            state={{ status: q.isPending ? 'loading' : 'ready' }}
          />
        </div>
        {q.data?.pendingInvites && q.data.pendingInvites.length > 0 && (
          <div className="col gap1" style={{ marginTop: 12 }} data-testid="pending-invites">
            <span className="label">Pending invites</span>
            {q.data.pendingInvites.map((i) => (
              <span key={i.inviteId} className="small">
                <span className="mono">{i.email}</span> as {i.role}, expires {formatAge(i.expiresAt)}
              </span>
            ))}
          </div>
        )}
      </Card>
      {canAdmin ? <InviteForm workspaceId={workspaceId} /> : <Notice tone="info" title="Inviting needs an owner or admin role" />}
    </div>
  );
}
