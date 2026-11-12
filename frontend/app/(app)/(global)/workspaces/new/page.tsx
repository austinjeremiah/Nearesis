'use client';

import { useState } from 'react';
import { Content, PageHeader } from '@/components/nx/shell';
import {
  Button,
  Card,
  Field,
  Input,
  KeyValues,
  LinkButton,
  Notice,
  Select,
  Textarea,
} from '@/components/nx/ui';
import { Badge, CoverageChip, SourceHealthChip } from '@/components/nx/evidence';
import * as db from '@/lib/data/client';
import { formatUsd } from '@/lib/format';

/**
 * Spec 5.4 — new workspace wizard.
 *
 * Four steps: objective, evidence, agents and budget, review. Two rules from
 * the spec shape it. No fake disabled networks, so only the plugin pack that
 * actually exists is offered. And the coverage preview shows the real state of
 * each source, including the degraded one, rather than implying everything is
 * live.
 */
const STEPS = ['Objective', 'Evidence', 'Agents and budget', 'Review'] as const;

export default function NewWorkspacePage() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [description, setDescription] = useState('');
  const [window, setWindow] = useState('180');
  const [grain, setGrain] = useState('day');
  const [acceptVisibility, setAcceptVisibility] = useState(false);
  const [runCap, setRunCap] = useState('8');
  const [totalCap, setTotalCap] = useState('40');
  const [team, setTeam] = useState<string[]>(['director', 'scout', 'quant', 'skeptic']);

  const nameValid = name.trim().length >= 3 && name.trim().length <= 80;
  const canAdvance =
    step === 0 ? nameValid && objective.trim().length > 0 : step === 1 ? acceptVisibility : true;

  const sources = db.sources();

  return (
    <>
      <PageHeader
        title="New workspace"
        description="A workspace holds one objective. Opening a different thesis later is a fork, not an edit."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: 'New' }]}
      />
      <Content>
        <ol className="row gap4 wrap" style={{ listStyle: 'none' }}>
          {STEPS.map((s, i) => (
            <li key={s} className="row gap2">
              <span
                className="badge"
                style={
                  i === step
                    ? { background: 'var(--accent)', color: '#000' }
                    : i < step
                      ? { background: 'var(--ink)', color: 'var(--invert)' }
                      : undefined
                }
              >
                {i + 1}
              </span>
              <span className={i === step ? 'small strong' : 'small dim'}>{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <Card title="Step 1 · Objective" subtitle="One question. Narrow beats broad.">
            <Field
              label="Workspace name"
              required
              help="3 to 80 characters."
              error={name.length > 0 && !nameValid ? 'Needs to be 3 to 80 characters.' : undefined}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Intents economic durability"
                maxLength={80}
              />
            </Field>
            <Field label="Research question" required help="The one thing this workspace exists to settle.">
              <Textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Are NEAR Intents flows economically durable, or transient execution volume?"
              />
            </Field>
            <Field label="Description" help="Optional context for collaborators.">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Plugin pack">
              <Select
                value="near-thesis"
                onChange={() => undefined}
                options={[{ value: 'near-thesis', label: 'NEAR Investment Thesis (plugin.near.thesis@1)' }]}
              />
            </Field>
            <p className="tiny dim">
              Only enabled plugin packs are listed. Packs that are not installed are absent rather
              than shown greyed out.
            </p>
          </Card>
        )}

        {step === 1 && (
          <Card title="Step 2 · Evidence" subtitle="What this workspace may read, and what it will not be able to see.">
            <div className="col gap2">
              <span className="label">Source scope</span>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Health</th>
                      <th>Coverage</th>
                      <th>Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <div className="col gap1">
                            <span className="strong">{s.name}</span>
                            {s.note && <span className="tiny dim">{s.note}</span>}
                          </div>
                        </td>
                        <td>
                          <SourceHealthChip health={s.health} />
                        </td>
                        <td>
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
                        </td>
                        <td>
                          <Badge outline>Frozen · fixture</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="row gap4 wrap">
              <Field label="Time window (days)">
                <Input value={window} onChange={(e) => setWindow(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Grain">
                <Select
                  value={grain}
                  onChange={(e) => setGrain(e.target.value)}
                  options={[
                    { value: 'day', label: 'Day (UTC)' },
                    { value: 'hour', label: 'Hour (UTC)' },
                  ]}
                />
              </Field>
            </div>

            <Notice tone="warn" title="Acknowledge the visibility limits before continuing">
              <ul style={{ paddingLeft: 16, listStyle: 'disc' }}>
                <li>
                  After {db.SETTLEMENT_BOUNDARY} a growing share of 1Click settlement cannot be
                  reconstructed from public NEAR transaction hashes.
                </li>
                <li>
                  Intents Explorer is provider-scoped. Its completed swaps are not all NEAR Intents
                  volume.
                </li>
                <li>The signer proxy counts accounts, not people.</li>
                <li>1Click samples are dry quotes. They are not executed trades or realized revenue.</li>
              </ul>
              <label className="row gap2" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={acceptVisibility}
                  onChange={(e) => setAcceptVisibility(e.target.checked)}
                />
                <span className="small">
                  I understand these limits apply to every claim this workspace produces.
                </span>
              </label>
            </Notice>
          </Card>
        )}

        {step === 2 && (
          <Card title="Step 3 · Agents and budget" subtitle="Read-only by default. Nothing spends without a cap.">
            <div className="col gap2">
              <span className="label">Initial team</span>
              {(['director', 'scout', 'quant', 'skeptic', 'composer', 'auditor'] as const).map((r) => (
                <label key={r} className="row gap2">
                  <input
                    type="checkbox"
                    checked={team.includes(r)}
                    onChange={(e) =>
                      setTeam((t) => (e.target.checked ? [...t, r] : t.filter((x) => x !== r)))
                    }
                  />
                  <span className="small strong" style={{ textTransform: 'capitalize', minWidth: 90 }}>
                    {r}
                  </span>
                  <span className="tiny dim">
                    {r === 'director' && 'Decomposes the question into certified queries.'}
                    {r === 'scout' && 'Checks source coverage and finds gaps.'}
                    {r === 'quant' && 'Runs forecast models and paired error tests.'}
                    {r === 'skeptic' && 'Proposes alternatives and collects counterevidence.'}
                    {r === 'composer' && 'Lays out panels for your review.'}
                    {r === 'auditor' && 'Scores results against the pre-registered protocol.'}
                  </span>
                </label>
              ))}
            </div>

            <div className="row gap4 wrap">
              <Field label="Per-investigation cap (USD)" help="A run stops and asks when it reaches this.">
                <Input value={runCap} onChange={(e) => setRunCap(e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Workspace total cap (USD)">
                <Input value={totalCap} onChange={(e) => setTotalCap(e.target.value)} inputMode="decimal" />
              </Field>
            </div>

            <Notice tone="info" title="What these agents may do">
              Read certified measures in the scope above, write findings into this workspace, and
              nothing else. They cannot create peer agents, widen their own scope, raise a cap,
              publish under your name or write to any chain. Each of those needs an approval bound
              to the exact action.
            </Notice>
          </Card>
        )}

        {step === 3 && (
          <Card title="Step 4 · Review" subtitle="This summary is what gets created.">
            <KeyValues
              rows={[
                { k: 'Name', v: name || <span className="unavailable" /> },
                { k: 'Question', v: objective || <span className="unavailable" /> },
                { k: 'Description', v: description || <span className="unavailable" /> },
                { k: 'Template', v: 'NEAR Investment Thesis' },
                { k: 'Window', v: `${window} days at ${grain} grain, UTC` },
                { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
                { k: 'Data mode', v: <Badge outline>Frozen · fixture</Badge> },
                { k: 'Team', v: team.join(', ') },
                {
                  k: 'Caps',
                  v: `${formatUsd(Number(runCap) || 0)} per investigation, ${formatUsd(Number(totalCap) || 0)} total`,
                },
                { k: 'Default permissions', v: 'Semantic read, workspace write. No chain write.' },
              ]}
            />
            <Notice tone="warn" title="Creation needs the backend">
              Workspace creation is an idempotent server command, and the API is not connected yet.
              You can review the exact payload above, and open the existing fixture workspace to see
              what gets built.
            </Notice>
          </Card>
        )}

        <div className="row gap2">
          <Button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} disabledReason="You are on the first step.">
            Back
          </Button>
          {step < 3 ? (
            <Button
              variant="primary"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance}
              disabledReason={
                step === 0
                  ? 'Enter a name of 3 to 80 characters and a research question.'
                  : 'Acknowledge the visibility limits to continue.'
              }
            >
              Continue
            </Button>
          ) : (
            <Button variant="primary" disabled disabledReason="Workspace creation needs the authorized API.">
              Create workspace
            </Button>
          )}
          <div className="grow" />
          <LinkButton href="/w/intents-adoption/overview">Open the fixture workspace</LinkButton>
        </div>
      </Content>
    </>
  );
}
