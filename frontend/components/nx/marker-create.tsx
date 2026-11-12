'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/nx/ui';
import { MutationError } from '@/components/nx/research-kit';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { research, rk } from '@/lib/research/api';

export const AGENT_ROLES = ['director', 'semantic_analyst', 'data_scout', 'quant', 'skeptic', 'economics', 'composer', 'monitoring', 'auditor', 'publisher'] as const;

type PanelSpecLite = {
  panelId: string;
  title: string;
  kind: string;
  queryRef?: { hash: string; semanticVersion: string };
  encoding?: { y?: string[] };
  dataBinding?: { units?: Record<string, string> };
};

/** A chart range selection, as the chart reports it. */
export type MarkerSelection = {
  panelId: string;
  start: string;
  end: string;
  seriesIds?: string[];
  sourceWatermark?: string | null;
};

const toIso = (local: string) => new Date(local.length === 10 ? `${local}T00:00:00Z` : local).toISOString();

/**
 * Create a marker (command `marker.create`). `selection` is what a chart range selection hands over (panel and
 * interval); with it the form is pre-filled and the selection context (query hash, semantic version, series, units)
 * is read from the panel's stored spec. Without it the person picks a panel and a range here.
 * Creating a marker never starts an agent by itself: optionally assign agents in the same step.
 */
export function MarkerCreateForm({ wid, selection, onCreated }: { wid: string; selection?: MarkerSelection; onCreated?: (markerId: string) => void }) {
  const qc = useQueryClient();
  const canvas = useQuery({ queryKey: qk.canvas(wid), queryFn: () => browserApi.canvas(wid) });
  const panels = useMemo(() => ((canvas.data as unknown as { panels?: PanelSpecLite[] })?.panels ?? []), [canvas.data]);

  const [panelId, setPanelId] = useState(selection?.panelId ?? '');
  const [kind, setKind] = useState<'time_range' | 'time_point' | 'threshold'>('time_range');
  const [start, setStart] = useState(selection?.start?.slice(0, 10) ?? '');
  const [end, setEnd] = useState(selection?.end?.slice(0, 10) ?? '');
  const [metricId, setMetricId] = useState('');
  const [op, setOp] = useState<'gt' | 'lt'>('gt');
  const [value, setValue] = useState('');
  const [question, setQuestion] = useState('');
  const [agent, setAgent] = useState('');

  const panel = panels.find((p) => p.panelId === panelId);
  const metricChoices = panel?.encoding?.y ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const markerId = crypto.randomUUID();
      const anchor =
        kind === 'time_range'
          ? { kind, start: toIso(start), end: toIso(end) }
          : kind === 'time_point'
            ? { kind, at: toIso(start) }
            : { kind, metricId: metricId || metricChoices[0] || '', op, value: Number(value) };
      const payload: Record<string, unknown> = { panelId, markerId, anchor };
      if (question.trim()) payload.question = question.trim();
      if (kind === 'time_range' && panel?.queryRef) {
        payload.selection = {
          queryHash: panel.queryRef.hash,
          semanticVersion: panel.queryRef.semanticVersion,
          interval: { start: toIso(start), end: toIso(end) },
          seriesIds: selection?.seriesIds ?? panel.encoding?.y ?? [],
          axisUnits: panel.dataBinding?.units ?? {},
          sourceWatermark: selection?.sourceWatermark ?? null,
        };
      }
      await research.createMarker(wid, payload);
      if (agent) {
        // A marker is DRAFT until activated; the agent task needs it ACTIVE.
        await research.transitionMarker(wid, markerId, 'ACTIVE');
        await research.assignMarker(wid, markerId, [agent]);
      }
      return markerId;
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: qk.markers(wid) });
      void qc.invalidateQueries({ queryKey: rk.graph(wid) });
      setQuestion('');
      onCreated?.(id);
    },
  });

  const valid =
    !!panelId && (kind === 'threshold' ? value !== '' && !Number.isNaN(Number(value)) : !!start && (kind === 'time_point' || !!end));

  return (
    <Card title="Create a marker" subtitle="Anchor a question to a panel. Selecting a range does not start an agent; assigning one below does.">
      <div className="rs-form" data-testid="marker-form">
        <Field label="Panel" required>
          <Select
            aria-label="Panel"
            value={panelId}
            onChange={(e) => setPanelId(e.target.value)}
            options={[{ value: '', label: panels.length ? 'Select a panel' : 'No panels on the canvas' }, ...panels.map((p) => ({ value: p.panelId, label: p.title }))]}
          />
        </Field>
        <Field label="Anchor">
          <Select aria-label="Anchor kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} options={[{ value: 'time_range', label: 'Time range' }, { value: 'time_point', label: 'Time point' }, { value: 'threshold', label: 'Threshold' }]} />
        </Field>
        {kind !== 'threshold' && (
          <Field label={kind === 'time_range' ? 'From (UTC)' : 'At (UTC)'}>
            <Input type="date" aria-label="Start" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
        )}
        {kind === 'time_range' && (
          <Field label="To (UTC)">
            <Input type="date" aria-label="End" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        )}
        {kind === 'threshold' && (
          <>
            <Field label="Metric">
              <Select aria-label="Metric" value={metricId} onChange={(e) => setMetricId(e.target.value)} options={metricChoices.length ? metricChoices.map((m) => ({ value: m, label: m })) : [{ value: '', label: 'Select a panel first' }]} />
            </Field>
            <Field label="Operator">
              <Select aria-label="Operator" value={op} onChange={(e) => setOp(e.target.value as 'gt' | 'lt')} options={[{ value: 'gt', label: 'greater than' }, { value: 'lt', label: 'less than' }]} />
            </Field>
            <Field label="Value">
              <Input type="number" aria-label="Threshold value" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </>
        )}
        <div className="wide">
          <Field label="Question (optional)">
            <Textarea rows={2} aria-label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={4000} />
          </Field>
        </div>
        <Field label="Assign an agent now (optional)" help="Activates the marker and starts a sub-agent run, which spends budget.">
          <Select aria-label="Assign agent" value={agent} onChange={(e) => setAgent(e.target.value)} options={[{ value: '', label: 'No agent' }, ...AGENT_ROLES.map((a) => ({ value: a, label: a.replace('_', ' ') }))]} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" disabled={!valid} disabledReason="Choose a panel and complete the anchor." pending={create.isPending} onClick={() => create.mutate()} data-testid="create-marker">
          Create marker
        </Button>
      </div>
      <MutationError error={create.error} />
    </Card>
  );
}
