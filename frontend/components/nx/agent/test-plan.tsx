'use client';

import './five.css';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Button } from '@/components/nx/ui';
import { MutationError } from '@/components/nx/research-kit';
import { ApiRequestError } from '@/lib/api/errors';
import { agentApi, agentKeys } from '@/lib/agent/api';
import type { Task } from '@/lib/agent/thread';
import {
  EDITABLE,
  LIMITS,
  LOCK_NOTE,
  NO_STATEMENT_NOTE,
  diffDraft,
  draftErrors,
  fieldErrorsFrom,
  relationText,
  shortFingerprint,
  signText,
  toDraft,
  windowText,
  type Draft,
  type EditableKey,
  type TestPlan,
} from '@/lib/agent/testplan';
import { formatUtc } from '@/lib/format';
import { CopyChip } from './storyboard/parts';

const FIELD_ID = (base: string, k: string) => `${base}-${k}`;

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="tp-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const unknown = <span className="dim">unknown</span>;

/** The read-only facts of a plan: the two series, relation, direction, window. */
function Facts({ p }: { p: TestPlan }) {
  return (
    <dl className="tp-facts" data-testid="testplan-facts">
      <Row k="First series">{p.xLabel ?? unknown}</Row>
      <Row k="Second series">{p.yLabel ?? unknown}</Row>
      <Row k="Relation"><span data-testid="testplan-relation">{p.relation ? relationText(p) : unknown}</span></Row>
      <Row k="Expected direction">{p.expectedSign ? signText(p.expectedSign) : unknown}</Row>
      <Row k="Window">{p.windowDays === null ? unknown : windowText(p.windowDays)}</Row>
    </dl>
  );
}

function Wrong({ text }: { text: string | null }) {
  return (
    <p className="tp-wrong" data-testid="testplan-wrong">
      <b>This would count as wrong:</b> {text ?? <span className="dim">not stated</span>}
    </p>
  );
}

/** The lock line: icon, time, a short fingerprint with copy, and who edited. */
export function LockLine({ p }: { p: TestPlan }) {
  const short = shortFingerprint(p.sha256);
  return (
    <p className="tp-lock" data-testid="testplan-locked">
      <Lock size={13} aria-hidden="true" />
      <span>Locked {p.lockedAt ? <span className="mono" title={p.lockedAt}>{formatUtc(p.lockedAt)}</span> : 'at an unknown time'}</span>
      {p.sha256 && short ? (
        <span className="tp-fp">
          fingerprint <CopyChip value={p.sha256} short={short} label="test plan fingerprint" />
        </span>
      ) : (
        <span className="dim">no fingerprint recorded</span>
      )}
      {p.editedByUser && <Badge outline title="You changed the planner's wording before pressing Start.">edited by you</Badge>}
    </p>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="tp-field" data-bad={error ? 'true' : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <span className="tp-hint">{hint}</span>}
      {error && <span className="tp-err" role="alert" data-testid={`testplan-error-${id.split('-').pop()}`}>{error}</span>}
    </div>
  );
}

function Editor({ task, p, onDone, writing }: { task: Task; p: TestPlan; onDone: () => void; writing: boolean }) {
  const base = useId();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(p));
  const [serverErrors, setServerErrors] = useState<Partial<Record<EditableKey, string>>>({});
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
  const local = draftErrors(draft);
  const errs = { ...serverErrors, ...local };
  const body = diffDraft(p, draft);
  const dirty = Object.keys(body).length > 0;
  const save = useMutation({
    mutationFn: () => agentApi.patchTestPlan(task.id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.thread(task.threadId) });
      onDone();
    },
    onError: (e) => setServerErrors(e instanceof ApiRequestError ? fieldErrorsFrom(e.details) : {}),
  });
  const set = (k: EditableKey, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };
  const hasFieldErr = Object.values(errs).some(Boolean);
  const showGeneric = save.error && !(save.error instanceof ApiRequestError && Object.keys(serverErrors).length > 0);
  return (
    <form
      className="tp-form"
      data-testid="testplan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !hasFieldErr && !save.isPending) save.mutate();
      }}
    >
      <Field id={FIELD_ID(base, 'statement')} label="The sentence" error={errs.statement} hint={`One testable sentence about two daily series. ${draft.statement.length}/${LIMITS.statement}`}>
        <textarea ref={first} id={FIELD_ID(base, 'statement')} rows={3} maxLength={LIMITS.statement + 40} value={draft.statement} onChange={(e) => set('statement', e.target.value)} data-testid="testplan-statement-input" placeholder="For example: Daily swap volume moves with the daily number of active wallets." />
      </Field>
      <div className="tp-two">
        <Field id={FIELD_ID(base, 'xLabel')} label="First series" error={errs.xLabel}>
          <input id={FIELD_ID(base, 'xLabel')} type="text" maxLength={LIMITS.label + 20} value={draft.xLabel} onChange={(e) => set('xLabel', e.target.value)} />
        </Field>
        <Field id={FIELD_ID(base, 'yLabel')} label="Second series" error={errs.yLabel}>
          <input id={FIELD_ID(base, 'yLabel')} type="text" maxLength={LIMITS.label + 20} value={draft.yLabel} onChange={(e) => set('yLabel', e.target.value)} />
        </Field>
        <Field id={FIELD_ID(base, 'relation')} label="Relation" error={errs.relation}>
          <select id={FIELD_ID(base, 'relation')} value={draft.relation} onChange={(e) => set('relation', e.target.value)}>
            <option value="" disabled>unknown</option>
            <option value="moves_with">moves with</option>
            <option value="leads">leads by N days</option>
          </select>
        </Field>
        <Field id={FIELD_ID(base, 'lagDays')} label="Lead, in days" error={errs.lagDays} hint={`0 to ${LIMITS.lagMax}`}>
          <input id={FIELD_ID(base, 'lagDays')} type="text" inputMode="numeric" value={draft.lagDays} disabled={draft.relation === 'moves_with'} onChange={(e) => set('lagDays', e.target.value)} />
        </Field>
        <Field id={FIELD_ID(base, 'expectedSign')} label="Expected direction" error={errs.expectedSign}>
          <select id={FIELD_ID(base, 'expectedSign')} value={draft.expectedSign} onChange={(e) => set('expectedSign', e.target.value)}>
            <option value="" disabled>unknown</option>
            <option value="positive">positive</option>
            <option value="negative">negative</option>
            <option value="either">either direction</option>
          </select>
        </Field>
        <Field id={FIELD_ID(base, 'windowDays')} label="Window, in days" error={errs.windowDays} hint={`${LIMITS.windowMin} to ${LIMITS.windowMax}`}>
          <input id={FIELD_ID(base, 'windowDays')} type="text" inputMode="numeric" value={draft.windowDays} onChange={(e) => set('windowDays', e.target.value)} />
        </Field>
      </div>
      <Field id={FIELD_ID(base, 'wouldCountAsWrong')} label="This would count as wrong" error={errs.wouldCountAsWrong} hint={`In the rule's terms. ${draft.wouldCountAsWrong.length}/${LIMITS.wrong}`}>
        <textarea id={FIELD_ID(base, 'wouldCountAsWrong')} rows={2} maxLength={LIMITS.wrong + 40} value={draft.wouldCountAsWrong} onChange={(e) => set('wouldCountAsWrong', e.target.value)} />
      </Field>
      {showGeneric && <MutationError error={save.error} />}
      <div className="tp-actions">
        <Button type="submit" variant="primary" pending={save.isPending} disabled={!dirty || hasFieldErr} disabledReason={!dirty ? 'Nothing has changed.' : 'Fix the marked fields first.'} data-testid="testplan-save">Save the plan</Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending} disabledReason="Saving.">{writing ? 'Not now' : 'Cancel'}</Button>
      </div>
    </form>
  );
}

/**
 * The test plan of a task. In the plan card (`variant="chat"`) it is editable until Start; after Start, and in the
 * storyboard, it is read-only. Nothing renders when the API sent no test plan.
 */
export default function TestPlanBlock({ task, variant = 'chat', onEditInChat }: { task: Task; variant?: 'chat' | 'story'; onEditInChat?: () => void }) {
  const p = task.testPlan;
  const [editing, setEditing] = useState(false);
  const labelId = useId();
  if (!p) return null;
  const locked = !!p.lockedAt;
  const canEdit = task.state === 'proposed' && !locked && variant === 'chat';
  const noSentence = p.statement === null;
  return (
    <section className="tp" data-surface={variant === 'story' ? true : undefined} data-testid="testplan" data-locked={locked ? 'true' : 'false'} data-variant={variant} aria-labelledby={labelId}>
      <header className="tp-head">
        <h4 id={labelId} className="tp-title">Test plan</h4>
        {locked ? <Badge tone="ok"><Lock size={11} aria-hidden="true" /> locked</Badge> : <Badge tone="info" outline>not locked yet</Badge>}
        <span className="grow" />
        {canEdit && !editing && !noSentence && (
          <button type="button" className="tp-edit" onClick={() => setEditing(true)} data-testid="testplan-edit">
            <Pencil size={12} aria-hidden="true" /> Edit
          </button>
        )}
      </header>
      {editing ? (
        <Editor task={task} p={p} onDone={() => setEditing(false)} writing={noSentence} />
      ) : noSentence ? (
        <div className="tp-empty" data-testid="testplan-empty">
          <p><b>No sentence yet.</b> Write one sentence about two daily series, for example how one moves with the other. {NO_STATEMENT_NOTE}</p>
          {canEdit ? <Button variant="primary" onClick={() => setEditing(true)} data-testid="testplan-write">Write the sentence</Button> : variant === 'story' && task.state === 'proposed' && onEditInChat ? <Button onClick={onEditInChat}>Write it in the chat</Button> : null}
        </div>
      ) : (
        <>
          <p className="tp-statement" data-testid="testplan-statement">{p.statement}</p>
          <Facts p={p} />
          <Wrong text={p.wouldCountAsWrong} />
        </>
      )}
      {!editing && (locked ? <LockLine p={p} /> : <p className="tp-note" data-testid="testplan-note">{LOCK_NOTE}{variant === 'story' && onEditInChat && task.state === 'proposed' && !noSentence ? <> <button type="button" className="tp-link" onClick={onEditInChat}>Edit it in the chat</button></> : null}</p>)}
    </section>
  );
}

export { EDITABLE };
