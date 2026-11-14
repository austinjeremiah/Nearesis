'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field, Input, Notice, Select } from '@/components/nx/ui';
import { MutationError } from '@/components/nx/research-kit';
import { ConditionEditor, describe, emptyCompare, MAX_DEPTH, MAX_NODES, shape } from '@/components/nx/condition-editor';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { research, rk, type Condition, type MonitorRule } from '@/lib/research/api';

/** Create or edit a monitor rule (commands `monitor.rule_create` and `monitor.rule_update`). */
export function RuleForm({ wid, rule, onSaved }: { wid: string; rule?: MonitorRule; onSaved?: (ruleId: string) => void }) {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: qk.sources(wid), queryFn: () => browserApi.sources(wid) });
  const metrics = useQuery({ queryKey: ['global', 'metrics'], queryFn: () => browserApi.get<{ metrics: { metricKey: string }[] }>('/v1/metrics') });
  const markers = useQuery({ queryKey: [...qk.markers(wid), 'list'], queryFn: () => research.markers(wid) });

  const [name, setName] = useState(rule?.name ?? '');
  const [sourceId, setSourceId] = useState(rule?.sourceId ?? '');
  const [condition, setCondition] = useState<Condition>(rule?.condition ?? emptyCompare());
  const [minInterval, setMinInterval] = useState(String(rule?.frequency.minIntervalSeconds ?? 0));
  const [debounce, setDebounce] = useState(String(rule?.debounceSeconds ?? 0));
  const [cooldown, setCooldown] = useState(String(rule?.cooldownSeconds ?? 0));
  const [action, setAction] = useState<'notify' | 'investigate'>(rule?.action ?? 'notify');
  const [maturity, setMaturity] = useState<'finalized_only' | 'any'>(rule?.dataMaturity ?? 'finalized_only');
  const [markerId, setMarkerId] = useState(rule?.markerId ?? '');
  const [maxRuns, setMaxRuns] = useState(rule?.maxRunsPerDay ? String(rule.maxRunsPerDay) : '');

  const sh = shape(condition);
  const okCondition = sh.depth <= MAX_DEPTH && sh.nodes <= MAX_NODES;
  const metricOk = (c: Condition): boolean => (c.kind === 'compare' || c.kind === 'zscore' ? /^[A-Za-z][A-Za-z0-9_.-]*$/.test(c.metricId) : c.kind === 'not' ? metricOk(c.term) : c.terms.every(metricOk));
  const valid = name.trim() && (rule || sourceId.trim()) && okCondition && metricOk(condition);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        condition,
        dataMaturity: maturity,
        frequency: { minIntervalSeconds: Number(minInterval) || 0 },
        debounceSeconds: Number(debounce) || 0,
        cooldownSeconds: Number(cooldown) || 0,
        action,
        markerId: markerId || null,
      };
      if (rule) {
        await research.updateRule(wid, { ruleId: rule.ruleId, ...body, maxRunsPerDay: maxRuns ? Number(maxRuns) : null });
        return rule.ruleId;
      }
      const ruleId = crypto.randomUUID();
      await research.createRule(wid, { ruleId, sourceId: sourceId.trim(), ...body, ...(maxRuns ? { maxRunsPerDay: Number(maxRuns) } : {}) });
      return ruleId;
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: qk.monitors(wid) });
      onSaved?.(id);
    },
  });

  return (
    <Card title={rule ? 'Edit rule' : 'New monitor rule'} subtitle="A rule watches a source's finalized watermark and fires when its condition holds. Conditions are a typed tree, never free text.">
      <div className="col gap3" data-testid="rule-form">
        <div className="rs-form">
          <Field label="Name" required>
            <Input aria-label="Rule name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Source" required help={rule ? 'A rule keeps its source.' : 'The provider whose watermark drives the rule.'}>
            <Input list="rule-sources" aria-label="Source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={!!rule} placeholder="e.g. explorer.swaps" />
            <datalist id="rule-sources">{sources.data?.sources.map((s) => <option key={s.sourceId} value={s.sourceId} />)}</datalist>
          </Field>
          <Field label="On fire">
            <Select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value as typeof action)} options={[{ value: 'notify', label: 'Notify' }, { value: 'investigate', label: 'Notify and start an investigation task' }]} />
          </Field>
          <Field label="Data maturity" help="Finalized only ignores provisional watermarks.">
            <Select aria-label="Data maturity" value={maturity} onChange={(e) => setMaturity(e.target.value as typeof maturity)} options={[{ value: 'finalized_only', label: 'Finalized only' }, { value: 'any', label: 'Any (including provisional)' }]} />
          </Field>
          <Field label="Linked marker">
            <Select aria-label="Linked marker" value={markerId} onChange={(e) => setMarkerId(e.target.value)} options={[{ value: '', label: 'None' }, ...(markers.data?.markers ?? []).map((m) => ({ value: m.markerId, label: (m.question ?? m.markerId).slice(0, 60) }))]} />
          </Field>
        </div>
        <div className="col gap2">
          <div className="label">Condition</div>
          <ConditionEditor value={condition} onChange={setCondition} metrics={(metrics.data?.metrics ?? []).map((m) => m.metricKey)} />
          <div className="tiny dim mono" data-testid="condition-text">{describe(condition)}</div>
          {!okCondition && <Notice tone="warn" title="Too large">A rule has at most {MAX_NODES} nodes and {MAX_DEPTH} levels.</Notice>}
        </div>
        <div className="rs-form">
          <Field label="Minimum seconds between evaluations" help="Frequency limit (watermark time).">
            <Input type="number" min={0} max={86400} aria-label="Frequency seconds" value={minInterval} onChange={(e) => setMinInterval(e.target.value)} />
          </Field>
          <Field label="Debounce seconds" help="The condition must hold this long before firing.">
            <Input type="number" min={0} max={86400} aria-label="Debounce seconds" value={debounce} onChange={(e) => setDebounce(e.target.value)} />
          </Field>
          <Field label="Cooldown seconds" help="After firing, repeats inside this window are suppressed (one notification per window).">
            <Input type="number" min={0} max={2592000} aria-label="Cooldown seconds" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
          </Field>
          <Field label="Max investigation runs per day" help="Caps agent tasks, not the deterministic check.">
            <Input type="number" min={1} max={1000} aria-label="Max runs per day" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} placeholder="no cap" />
          </Field>
        </div>
        <div>
          <Button variant="primary" disabled={!valid} disabledReason="Name, source and a valid condition are required." pending={save.isPending} onClick={() => save.mutate()} data-testid="save-rule">
            {rule ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
        <MutationError error={save.error} />
      </div>
    </Card>
  );
}

export { rk };
