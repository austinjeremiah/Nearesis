'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import {
  Badge,
  CoverageChip,
  DataModeIndicator,
  EvidenceVerdict,
  RunStatus,
  SourceHealthChip,
} from '@/components/nx/evidence';
import {
  BudgetMeter,
  Button,
  Card,
  EmptyState,
  KeyValues,
  LinkButton,
  Notice,
  Textarea,
} from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.6 — Investigate.
 *
 * "Not a generic full-screen chat." Two columns: question, plan and run on the
 * left; the evidence feed on the right. Two rules drive the interaction. The
 * prompt alone never spawns an agent, so "Prepare plan" is side-effect free and
 * a separate, explicit "Approve and run" crosses the authorization boundary.
 * And the running state shows tool names, metrics and result ids, never
 * invented inner reasoning.
 */
type Stage = 'idle' | 'planned' | 'running';

export default function InvestigatePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = use(params);
  const ws = db.workspace(wid);
  const [question, setQuestion] = useState('');
  const [stage, setStage] = useState<Stage>('idle');

  const completedRun = db.runs(wid).find((r) => r.state === 'succeeded');
  const activeRun = db.activeRun(wid);
  const claims = db.claims(wid);
  const sources = db.sources();

  if (!ws) return null;

  return (
    <>
      <PageHeader
        title="Investigate"
        description="Ask one question. Review the plan before anything spends or runs."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Investigate' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <div className="grid c2" style={{ alignItems: 'start' }}>
          {/* ---- left column: question, plan, run ---- */}
          <div className="col gap4">
            <Card title="Ask" subtitle="Preparing a plan reads nothing and spends nothing.">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What would you like to test about the NEAR ecosystem?"
                style={{ minHeight: 96 }}
                aria-label="Research question"
              />

              <div className="col gap2">
                <span className="label">Scope</span>
                <div className="row gap2 wrap">
                  {sources.map((s) => (
                    <Badge key={s.id} outline title={`${s.provider} · ${s.health}`}>
                      {s.name}
                    </Badge>
                  ))}
                </div>
                <p className="tiny dim">
                  These are the sources this workspace is actually permitted to read. A source it
                  cannot reach is not listed.
                </p>
              </div>

              <div className="row gap4 wrap">
                <KeyValues
                  rows={[
                    { k: 'Dataset vintage', v: <span className="mono">{ws.snapshotId}</span> },
                    { k: 'Branch', v: <span className="mono">{ws.branch}</span> },
                  ]}
                />
                <BudgetMeter spentUsd={ws.spentUsd} budgetUsd={ws.budgetUsd} label="Workspace cap" />
              </div>

              <div className="row gap2">
                <Button
                  variant="primary"
                  onClick={() => setStage('planned')}
                  disabled={question.trim().length < 8}
                  disabledReason="Write a question first."
                >
                  Prepare plan
                </Button>
                <Button
                  onClick={() => {
                    setQuestion(
                      'Does lagged 1Click volume forecast organic NEAR activity better than price returns?',
                    );
                    setStage('planned');
                  }}
                >
                  Use research template
                </Button>
              </div>
            </Card>

            {stage !== 'idle' && (
              <Card
                title="Plan preview"
                subtitle="Side-effect free. Nothing has run."
                actions={<Badge tone="warn">Awaiting approval</Badge>}
              >
                <KeyValues
                  rows={[
                    { k: 'Question hash', v: <span className="mono">{shortHash(db.queryRefFor(['intents.daily_volume']).canonicalQueryHash)}</span> },
                    {
                      k: 'Certified metrics',
                      v: (
                        <div className="col gap1">
                          {['intents.daily_volume', 'near.daily_successful_actions', 'near.price_usd'].map((m) => (
                            <Link key={m} className="link mono" href={`/data/metrics/${m}`}>
                              {m}
                            </Link>
                          ))}
                        </div>
                      ),
                    },
                    { k: 'Semantic version', v: <span className="mono">{db.SEMANTIC_VERSION}</span> },
                    { k: 'Estimated cost', v: <span className="mono">{formatUsd(5.4)}</span> },
                    { k: 'Permissions', v: 'Semantic read, workspace write. No chain write.' },
                    { k: 'Expected artifacts', v: 'One experiment, one panel patch, one claim draft' },
                  ]}
                />

                <div className="col gap2">
                  <span className="label">Subtasks</span>
                  <ol className="col gap1">
                    {[
                      ['Director', 'Decompose into certified queries'],
                      ['Scout', 'Check source coverage and gaps'],
                      ['Quant', 'Rolling-origin forecast comparison, 18 origins'],
                      ['Skeptic', 'Alternative definitions and counterevidence'],
                      ['Composer', 'Propose panels for your review'],
                      ['Auditor', 'Score against the pre-registered protocol'],
                    ].map(([role, what]) => (
                      <li key={role} className="row gap3 small" style={{ borderBottom: '1px dashed var(--line)', padding: '6px 0' }}>
                        <Badge outline>{role}</Badge>
                        <span className="grow">{what}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <Notice tone="warn" title="Source coverage affects what this plan can conclude">
                  Intents Explorer is degraded (PARTNER_JWT_EXPIRED). Any claim that needs fresh
                  Intents data will come back BLOCKED_SOURCE rather than being computed on stale
                  rows.
                </Notice>

                <div className="row gap2">
                  <Button variant="primary" disabled disabledReason="Running a plan needs the authorized API.">
                    Approve and run
                  </Button>
                  <Button onClick={() => setStage('idle')}>Edit scope</Button>
                  <Button onClick={() => setStage('idle')}>Reject plan</Button>
                </div>
              </Card>
            )}

            {activeRun && (
              <Card
                title="Running now"
                subtitle={activeRun.question}
                actions={<RunStatus state={activeRun.state} />}
              >
                <ol className="col gap2">
                  {activeRun.tasks.map((t) => (
                    <li key={t.id} className="col gap1" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 8 }}>
                      <div className="row gap2">
                        <Badge outline>{t.role}</Badge>
                        <span className="small strong grow">{t.label}</span>
                        <RunStatus state={t.state} />
                      </div>
                      {t.toolCalls.map((c, i) => (
                        <div key={i} className="row gap2 tiny dim">
                          <span className="mono">{c.tool}</span>
                          <span>{c.detail}</span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ol>
                <p className="tiny dim">
                  Tool name, metric and result id. This is the activity stream, not the model&apos;s
                  inner reasoning, which is not shown because it is not evidence.
                </p>
                <div className="row gap2">
                  <LinkButton href={`/w/${wid}/runs/${activeRun.id}`}>View run</LinkButton>
                  <Button variant="danger" disabled disabledReason="Cancelling a run needs the authorized API.">
                    Cancel run
                  </Button>
                </div>
              </Card>
            )}
          </div>

          {/* ---- right column: evidence feed ---- */}
          <div className="col gap4">
            <Card title="Evidence feed" subtitle="Results from completed investigations in this workspace.">
              {!completedRun ? (
                <EmptyState title="Nothing yet" body="Approve a plan and results appear here as they land." />
              ) : (
                <div className="col gap3">
                  {claims.map((c) => (
                    <div key={c.id} className="col gap2" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 12 }}>
                      <Link className="small strong" href={`/w/${wid}/claims/${c.id}`}>
                        {c.statement}
                      </Link>
                      <EvidenceVerdict verdict={c.verdict} strength={c.strength} />
                      <p className="tiny dim">{c.estimate}</p>
                      {c.counterexample && (
                        <p className="tiny" style={{ color: 'var(--warn)' }}>
                          Counterevidence: {c.counterexample}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Proposed dashboard" subtitle="Reviewed as a diff before anything is committed.">
              <KeyValues
                rows={[
                  { k: 'Operations', v: '4 add, 0 update, 0 remove' },
                  { k: 'Query count', v: <span className="mono">4</span> },
                  { k: 'Estimated cost', v: <span className="mono">{formatUsd(0.18)}</span> },
                  { k: 'At risk', v: '1 panel depends on the degraded Intents Explorer' },
                ]}
              />
              <LinkButton href={`/w/${wid}/canvas`}>Preview proposed dashboard</LinkButton>
            </Card>

            <Card title="Source coverage at plan time">
              <KeyValues
                rows={sources.map((s) => ({
                  k: s.name,
                  v: (
                    <span className="row gap2 wrap">
                      <SourceHealthChip health={s.health} />
                      {s.coveragePct !== null ? (
                        <CoverageChip
                          coverage={{
                            expected: 180,
                            observed: Math.round(180 * s.coveragePct),
                            unknown: Math.round(180 * (1 - s.coveragePct)),
                            gaps: [],
                          }}
                        />
                      ) : (
                        <Badge outline>Not sampled</Badge>
                      )}
                      <span className="tiny dim mono">{formatUtc(s.watermark, false)}</span>
                    </span>
                  ),
                }))}
              />
            </Card>
          </div>
        </div>
      </Content>
    </>
  );
}
