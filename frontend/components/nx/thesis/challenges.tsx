'use client';

import './strength.css';
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { FlowCard } from '@/components/nx/flow/flow';
import { ConfirmDialog } from '@/components/nx/overlays';
import { MutationError } from '@/components/nx/research-kit';
import { Button } from '@/components/nx/ui';
import { ApiRequestError } from '@/lib/api/errors';
import { formatAge, formatUtc } from '@/lib/format';
import { formatUsdString } from '@/lib/agent/tasks';
import { answerChallenge, challengeThesis } from '@/lib/thesis/api';
import { ANSWER_MAX, CHALLENGE_CONFIRM, UNAVAILABLE_TEXT, challengeRefusal, OUTCOME_TONE, OUTCOME_WORD, SEVERITY_TONE, droppedText, groupNotes, needsAnswer, type Challenge } from '@/lib/thesis/challenge';

/** "Challenge it": confirm (it uses credits), run the skeptic once, then show the result in the Challenges stage. */
export function ChallengeButton({ thesisId }: { thesisId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: () => challengeThesis(thesisId),
    onSuccess: async () => {
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ['thesis'] });
      setTimeout(() => document.getElementById('th-challenges')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    },
    onError: () => setOpen(false),
  });
  const said = run.error instanceof ApiRequestError && run.error.status !== 402 ? challengeRefusal(run.error.status, run.error.reasonCode) : null;
  return (
    <>
      <Button onClick={() => setOpen(true)} pending={run.isPending} data-testid="thesis-challenge" title="Runs the skeptic against this thesis. Uses your credits.">
        <ShieldQuestion size={14} /> Challenge it
      </Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Challenge this thesis?" body={CHALLENGE_CONFIRM} confirmLabel="Run the skeptic" pending={run.isPending} onConfirm={() => run.mutate()} />
      {said ? (
        <span className="small" role="alert" data-testid="thesis-challenge-refused" style={{ flexBasis: '100%', color: 'var(--text-2)' }}>{said}</span>
      ) : run.error ? (
        <div style={{ flexBasis: '100%' }}><MutationError error={run.error} /></div>
      ) : null}
    </>
  );
}

function AnswerBox({ thesisId, challenge }: { thesisId: string; challenge: Challenge }) {
  const id = useId();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => answerChallenge(thesisId, challenge.id, text.trim()),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['thesis'] });
    },
  });
  const ok = text.trim().length > 0 && text.length <= ANSWER_MAX;
  return (
    <form
      className="ch-form"
      data-testid="challenge-answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !send.isPending) send.mutate();
      }}
    >
      <label htmlFor={id}>Your answer{needsAnswer(challenge) ? ' (material notes are unanswered)' : ''}</label>
      <textarea id={id} rows={3} maxLength={ANSWER_MAX + 40} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say what the notes miss, or what you would check next. No new numbers." />
      <div className="ch-form-row">
        <Button type="submit" variant="primary" pending={send.isPending} disabled={!ok} disabledReason={text.trim() ? `At most ${ANSWER_MAX} characters.` : 'Write an answer first.'} data-testid="challenge-answer-send">Post the answer</Button>
        <span className="ch-count">{text.length}/{ANSWER_MAX}</span>
      </div>
      <MutationError error={send.error} />
    </form>
  );
}

function ChallengeCard({ c, thesisId, owner }: { c: Challenge; thesisId: string | null; owner: boolean }) {
  const groups = groupNotes(c.notes);
  const dropped = droppedText(c.droppedNotes);
  return (
    <li>
      <FlowCard
        testid="challenge"
        tone={OUTCOME_TONE[c.outcome] || undefined}
        title="Skeptic review"
        badges={
          <Badge tone={OUTCOME_TONE[c.outcome]} outline={c.outcome === 'unavailable'}>{OUTCOME_WORD[c.outcome]}</Badge>
        }
        foot={
          <>
            <span>by {c.by ?? 'unknown'}</span>
            <span title={c.createdAt ?? undefined}>{c.createdAt ? `${formatUtc(c.createdAt)} (${formatAge(c.createdAt)})` : 'time unknown'}</span>
            <span>cost {c.cost.usd === null ? 'unknown' : formatUsdString(c.cost.usd)}{c.cost.modelCalls !== null ? `, ${c.cost.modelCalls} model ${c.cost.modelCalls === 1 ? 'call' : 'calls'}` : ''}</span>
          </>
        }
      >
        {c.outcome === 'unavailable' && <p className="small dim" data-testid="challenge-unavailable">{UNAVAILABLE_TEXT}</p>}
        {c.outcome === 'holds' && c.notes.length === 0 && <p className="small">The skeptic found nothing to flag.</p>}
        {groups.length > 0 && (
          <div className="ch-groups">
            {groups.map((g) => (
              <section key={g.label} className="ch-group" data-testid="challenge-group">
                <h4>{g.label}</h4>
                <ul className="ch-notes">
                  {g.notes.map((n, i) => (
                    <li key={i} className="ch-note" data-testid="challenge-note">
                      {n.severity ? <Badge tone={SEVERITY_TONE[n.severity]} outline={n.severity === 'minor'}>{n.severity}</Badge> : <Badge outline>note</Badge>}
                      <p>{n.text}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {dropped && <p className="ch-dropped" data-testid="challenge-dropped">{dropped}</p>}
        {c.answer && (
          <div className="ch-answer" data-testid="challenge-answer">
            <span className="ch-answer-k">Owner&apos;s answer</span>
            <p>{c.answer.text}</p>
            {(c.answer.by || c.answer.at) && <span className="tiny dim mono">{[c.answer.by, c.answer.at ? formatUtc(c.answer.at) : null].filter(Boolean).join(' · ')}</span>}
          </div>
        )}
        {owner && thesisId && !c.answer && c.outcome !== 'unavailable' && <AnswerBox thesisId={thesisId} challenge={c} />}
      </FlowCard>
    </li>
  );
}

/** The Challenges stage body: each challenge newest first. `owner` adds the answer box; without it the list is read-only. */
export function ChallengesBody({ items, thesisId, owner, action }: { items: Challenge[]; thesisId: string | null; owner: boolean; action?: React.ReactNode }) {
  return (
    <div className="fl-stage-body" data-testid="thesis-challenges">
      {items.length === 0 ? (
        <FlowCard title="No challenges yet" testid="challenges-empty">
          <p className="small">{owner ? 'Challenge it to have a skeptic read this thesis once and say where it is weak. It never changes the thesis.' : 'Nobody has challenged this thesis yet.'}</p>
          {action}
        </FlowCard>
      ) : (
        <ul className="ch-list" aria-label="Challenges, newest first">
          {items.map((c) => (
            <ChallengeCard key={c.id} c={c} thesisId={thesisId} owner={owner} />
          ))}
        </ul>
      )}
    </div>
  );
}
