import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, Field, Input, KeyValues, Notice, Select } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd } from '@/lib/format';

/** Spec 5.29 — organization and account settings. */
export default function SettingsPage() {
  const ws = db.workspaces().filter((w) => !w.archived);
  const spent = ws.reduce((a, w) => a + w.spentUsd, 0);

  return (
    <>
      <PageHeader title="Settings" description="Profile, organization, usage and integrations." />
      <Content>
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Profile">
            <Field label="Display name">
              <Input defaultValue="you" disabled />
            </Field>
            <Field label="Theme" help="Dark mode is a complete token variant, not an inverted screenshot.">
              <Select
                defaultValue="system"
                disabled
                options={[
                  { value: 'system', label: 'Match system' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </Field>
            <Field label="Table density">
              <Select
                defaultValue="compact"
                disabled
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'comfortable', label: 'Comfortable' },
                ]}
              />
            </Field>
            <Button disabled disabledReason="Saving needs the authorized API.">Save</Button>
          </Card>

          <Card title="Organization">
            <KeyValues
              rows={[
                { k: 'Name', v: 'Nearesis Research' },
                { k: 'Your role', v: <Badge tone="ok">Owner</Badge> },
                { k: 'Members', v: <span className="mono">3</span> },
                { k: 'Identity provider', v: <Badge tone="warn">Not configured</Badge> },
              ]}
            />
            <Notice tone="info" title="Roles are enforced on the server">
              What you see here reflects a grant, not a preference. Changing a role in the UI
              cannot widen what an account may actually do.
            </Notice>
          </Card>
        </div>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Usage">
            <KeyValues
              rows={[
                { k: 'Spent across workspaces', v: <span className="mono">{formatUsd(spent)}</span> },
                { k: 'Active workspaces', v: <span className="mono">{ws.length}</span> },
                { k: 'Billing period', v: 'November 2026' },
              ]}
            />
            <p className="tiny dim">Read from the run ledger, not estimated from token counts.</p>
          </Card>

          <Card title="Integrations">
            <KeyValues
              rows={[
                { k: 'NEAR BigQuery', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'Intents Explorer', v: <Badge tone="warn">Not connected</Badge> },
                { k: '1Click sampler', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'OpenRouter', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'OutLayer', v: <Badge tone="warn">Not connected</Badge> },
              ]}
            />
            <Notice tone="warn" title="Credentials are never entered here">
              Provider secrets live on the server and are set by a maintainer. This page can show
              a connection status, never a key.
            </Notice>
          </Card>
        </div>
      </Content>
    </>
  );
}
