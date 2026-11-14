'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, KeyValues, Skeleton } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { OrgTeam } from '@/components/nx/team';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
import { LinkNearWallet } from '@/components/nx/near-link';

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including roles and the last-owner guard.',
  admin: 'Members, invitations, budgets and publishing.',
  analyst: 'Ask questions, edit the canvas, add markers.',
  viewer: 'Read only.',
};

export default function SettingsView() {
  const me = useQuery({ queryKey: qk.me, queryFn: () => shellBrowser.me(), staleTime: 60_000 });
  const org = useQuery({ queryKey: ['global', 'org'], queryFn: () => shellBrowser.org() });
  if (me.isError) return <ApiErrorState error={me.error} onRetry={() => me.refetch()} />;
  if (!me.data) return <Skeleton rows={4} />;
  const m = me.data;
  return (
    <div className="col gap4">
      <Card title="Account">
        <div data-testid="account">
          <KeyValues
            rows={[
              { k: 'Name', v: m.principal.displayName ?? 'No display name' },
              { k: 'User id', v: <span className="mono small">{m.principal.userId}</span> },
              { k: 'Kind', v: m.principal.kind },
              {
                k: 'Role',
                v: (
                  <span className="row gap2">
                    <Badge tone="info">{m.role}</Badge>
                    <span className="small dim">{ROLE_HELP[m.role]}</span>
                  </span>
                ),
              },
              { k: 'Can write', v: m.permissions.canWrite ? 'Yes' : 'No' },
              { k: 'Can administer', v: m.permissions.canAdmin ? 'Yes' : 'No' },
              { k: 'Workspaces you can open', v: String(m.workspaces.length) },
              {
                k: 'NEAR wallet',
                v:
                  m.nearAccountId === undefined ? (
                    <span className="dim">unknown</span>
                  ) : m.nearAccountId ? (
                    <span className="mono small" data-testid="near-account">{m.nearAccountId} (testnet)</span>
                  ) : (
                    <LinkNearWallet />
                  ),
              },
            ]}
          />
        </div>
      </Card>
      <Card title="Organization">
        {org.isError ? (
          <ApiErrorState error={org.error} onRetry={() => org.refetch()} />
        ) : org.data ? (
          <div data-testid="org">
            <KeyValues
              rows={[
                { k: 'Name', v: org.data.name },
                { k: 'Org id', v: <span className="mono small">{org.data.orgId}</span> },
                { k: 'Members', v: String(org.data.memberCount) },
                { k: 'Roles available', v: org.data.roles.join(', ') },
              ]}
            />
          </div>
        ) : (
          <Skeleton rows={3} />
        )}
      </Card>
      <OrgTeam canAdmin={m.permissions.canAdmin} myRole={m.role} />
    </div>
  );
}
