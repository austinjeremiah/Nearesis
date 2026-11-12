import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { BudgetMeter, Button, Card, Input, KeyValues, Notice, Field } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd } from '@/lib/format';

/** Spec 5.28 — workspace settings. Every control is server-enforced. */
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  return (
    <>
      <PageHeader
        title="Workspace settings"
        description="Scope, budgets, collaborators and lifecycle."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Settings' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Identity">
            <Field label="Name">
              <Input defaultValue={ws.name} disabled />
            </Field>
            <Field label="Objective" help="Changing the objective is a fork, not an edit.">
              <Input defaultValue={ws.objective} disabled />
            </Field>
            <KeyValues
              rows={[
                { k: 'Template', v: ws.template },
                { k: 'Branch', v: <span className="mono">{ws.branch}</span> },
                { k: 'Snapshot', v: <span className="mono">{ws.snapshotId}</span> },
                { k: 'Owner', v: ws.owner },
              ]}
            />
            <Button disabled disabledReason="Saving needs the authorized API.">Save</Button>
          </Card>

          <Card title="Budgets">
            <BudgetMeter spentUsd={ws.spentUsd} budgetUsd={ws.budgetUsd} label="Workspace total" />
            <Field label="Per-investigation cap (USD)">
              <Input defaultValue="8.00" disabled />
            </Field>
            <Field label="Workspace total cap (USD)">
              <Input defaultValue={ws.budgetUsd.toFixed(2)} disabled />
            </Field>
            <Notice tone="info" title="Raising a cap needs an approval">
              A budget increase is an approval bound to the new number, so an agent cannot ask for
              a small raise and receive a large one.
            </Notice>
          </Card>
        </div>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Collaborators">
            <KeyValues
              rows={[
                { k: 'you', v: <Badge tone="ok">Owner</Badge> },
                { k: 'r.mehta', v: <Badge tone="info">Analyst</Badge> },
                { k: 'external reviewer', v: <Badge outline>Reviewer</Badge> },
              ]}
            />
            <Button disabled disabledReason="Inviting needs the authorized API.">Invite</Button>
          </Card>

          <Card title="Lifecycle">
            <KeyValues
              rows={[
                { k: 'Status', v: <Badge>{ws.thesisStatus.replace(/_/g, ' ')}</Badge> },
                { k: 'Spend to date', v: <span className="mono">{formatUsd(ws.spentUsd)}</span> },
              ]}
            />
            <Notice tone="warn" title="Archiving is reversible, deleting is not">
              Archiving hides a workspace and stops its monitors. Published capsules stay
              reachable, because a reader who cited one should not find a dead link.
            </Notice>
            <div className="row gap2">
              <Button disabled disabledReason="Archiving needs the authorized API.">Archive workspace</Button>
              <Button variant="danger" disabled disabledReason="Deleting needs owner confirmation and the authorized API.">
                Delete workspace
              </Button>
            </div>
          </Card>
        </div>
      </Content>
    </>
  );
}
