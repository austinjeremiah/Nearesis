'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Select, Textarea } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { newKey } from '@/lib/api/transport';
import { qk } from '@/lib/api/keys';

const SCOPES = [
  { value: 'near-mainnet-read', label: 'NEAR mainnet (read only)' },
  { value: 'near-testnet', label: 'NEAR testnet' },
  { value: 'fixture-only', label: 'Fixture only (no live reads)' },
] as const;

/** POST /v1/workspaces with an Idempotency-Key (header and body) so a double submit creates one workspace. */
export default function NewWorkspaceForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['value']>('near-mainnet-read');
  const [key] = useState(newKey);

  const create = useMutation({
    mutationFn: () =>
      browserApi.createWorkspace({ objective: objective.trim(), networkScope: scope, idempotencyKey: key }, { idempotencyKey: key }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.workspaces });
      router.push(`/w/${r.workspaceId}/overview`);
    },
  });

  return (
    <div style={{ maxWidth: 640 }}>
      <Card title="Research question">
        <form
          className="col gap3"
          onSubmit={(e) => {
            e.preventDefault();
            if (objective.trim()) create.mutate();
          }}
        >
          <Field label="Objective" required help="One question this workspace exists to answer.">
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={4}
              maxLength={2000}
              data-testid="objective"
            />
          </Field>
          <Field label="Network scope">
            <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} options={SCOPES.map((s) => ({ value: s.value, label: s.label }))} />
          </Field>
          {create.isError && <ApiErrorState error={create.error} />}
          <div className="row gap2">
            <Button
              type="submit"
              variant="primary"
              pending={create.isPending}
              disabled={!objective.trim()}
              disabledReason="Enter an objective first."
              data-testid="create-workspace"
            >
              Create workspace
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
