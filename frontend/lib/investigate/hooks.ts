'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { investigateApi } from './api';
import type { ApprovalRow } from './types';

/**
 * Approve or reject. The decision always carries the approval's own action hash
 * (never one typed or recomputed). After any outcome, including a 409, the
 * caches are invalidated so the list shows what the server now says.
 */
export function useDecision(wid: string) {
  const qc = useQueryClient();
  const [active, setActive] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const m = useMutation({
    mutationFn: (v: { runId: string; approval: ApprovalRow; decision: 'approve' | 'reject' }) =>
      investigateApi.decide(v.runId, v.approval.approvalId, v.decision, v.approval.actionHash),
    onMutate: (v) => setActive({ id: v.approval.approvalId, decision: v.decision }),
    onSettled: () => {
      setActive(null);
      void qc.invalidateQueries({ queryKey: ['ws', wid] });
    },
  });
  return {
    decide: (runId: string, approval: ApprovalRow, decision: 'approve' | 'reject') => m.mutate({ runId, approval, decision }),
    pendingFor: (id: string) => (active?.id === id ? active.decision : null),
    errorFor: (id: string) => (m.isError && m.variables?.approval.approvalId === id ? m.error : null),
  };
}
