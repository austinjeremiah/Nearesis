'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { shellBrowser } from '@/lib/api/shell-browser';
import { newKey } from '@/lib/api/transport';
import { qk } from '@/lib/api/keys';

const SCOPES = [
  { value: 'near-mainnet-read', label: 'NEAR mainnet (read only)' },
  { value: 'near-testnet', label: 'NEAR testnet' },
  { value: 'fixture-only', label: 'Fixture only (no live reads)' },
] as const;

/**
 * Creates a workspace. With a template (POST /v1/workspaces/from-template) the
 * name, optional description and template canvas configuration are applied;
 * templates carry layout and starter questions only, never data. Without one
 * it is POST /v1/workspaces. Both use one Idempotency-Key so a double submit
 * creates one workspace.
 */
export default function NewWorkspaceForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['global', 'templates'], queryFn: () => shellBrowser.templates() });
  const [templateId, setTemplateId] = useState('blank');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['value']>('near-mainnet-read');
  const [key] = useState(newKey);
  const tpl = templates.data?.templates.find((t) => t.id === templateId);

  const create = useMutation({
    mutationFn: async () => {
      const obj = objective.trim() || tpl?.objectiveHint || '';
      if (!name.trim() && templateId === 'blank') {
        const r = await browserApi.createWorkspace({ objective: obj, networkScope: scope, idempotencyKey: key }, { idempotencyKey: key });
        return r.workspaceId;
      }
      const r = await shellBrowser.createFromTemplate(
        {
          templateId,
          name: name.trim() || obj.slice(0, 120),
          description: description.trim() || undefined,
          objective: objective.trim() || undefined,
          networkScope: scope,
          idempotencyKey: key,
        },
        { idempotencyKey: key },
      );
      return r.workspaceId;
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: qk.workspaces });
      router.push(`/w/${id}/overview`);
    },
  });
  const hasObjective = !!(objective.trim() || tpl?.objectiveHint);

  return (
    <div style={{ maxWidth: 680 }}>
      <Card title="New workspace">
        <form
          className="col gap3"
          onSubmit={(e) => {
            e.preventDefault();
            if (hasObjective) create.mutate();
          }}
        >
          <Field label="Template" help={tpl?.description ?? undefined}>
            <Select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              options={(templates.data?.templates ?? [{ id: 'blank', name: 'Blank workspace' }]).map((t) => ({ value: t.id, label: t.name }))}
              data-testid="template"
            />
          </Field>
          {tpl && tpl.starterQuestions.length > 0 && (
            <div className="col gap1">
              <span className="label">Starter questions</span>
              <ul className="small" style={{ margin: 0 }}>
                {tpl.starterQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <Field label="Name" help="Optional. Defaults to the start of the objective.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="name" />
          </Field>
          <Field label="Objective" required={!tpl?.objectiveHint} help={tpl?.objectiveHint ? `Leave empty to use: ${tpl.objectiveHint}` : 'One question this workspace exists to answer.'}>
            <Textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={4} maxLength={2000} data-testid="objective" />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} data-testid="description" />
          </Field>
          <Field label="Network scope">
            <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} options={SCOPES.map((s) => ({ value: s.value, label: s.label }))} data-testid="scope" />
          </Field>
          {create.isError && <ApiErrorState error={create.error} />}
          <div className="row gap2">
            <Button type="submit" variant="primary" pending={create.isPending} disabled={!hasObjective} disabledReason="Enter an objective first." data-testid="create-workspace">
              Create workspace
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
