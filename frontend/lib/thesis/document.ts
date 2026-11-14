import { intervalText, isV2, reasonText } from './doc';
import { readableCorrelation, readableNumber, stripRefs, stripStatusPrefix, plainLabel, isCorrelation } from './display';
import { partView, type Strength } from './strength';
import { groupNotes, type Challenge } from './challenge';
import { receiptsText, type Receipts, type ThesisKind } from './list';
import { formatUtc } from '@/lib/format';
import { queryTag, statusLabel, statusTone, type Thesis, type ThesisChart, type ThesisSection, type Tone } from '@/lib/thesis-track/model';

/**
 * View model of the thesis document (the A4 layout in the workspace report's design). Pure: a normalised thesis plus what
 * the API sends beside it goes in, plain fields and ordered lists come out, and the component only draws them. Nothing is
 * invented: a missing value stays null and is drawn as "unknown".
 */

const enc = encodeURIComponent;

/** The Agent tab and the workspace overview open this; the Theses tab keeps the interactive viewer at `/thesis/<id>`. */
export const thesisDocHref = (id: string): string => `/thesis/${enc(id)}/document`;
export const thesisFlowHref = (id: string): string => `/thesis/${enc(id)}`;
export const publicDocHref = (slug: string): string => `/t/${enc(slug)}/document`;
export const publicFlowHref = (slug: string): string => `/t/${enc(slug)}`;

/** Eight characters of a uuid; any other id (the reference thesis) is kept as a short slug. */
export const shortThesisId = (id: string): string => (/^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24).replace(/^-|-$/g, ''));

export const thesisPdfFilename = (id: string, now = new Date()): string => `nearesis-thesis-${shortThesisId(id)}-${now.toISOString().slice(0, 10)}.pdf`;

/** The claim as the PDF header and the tab title show it. */
export const shortClaim = (s: string | null | undefined, max = 70): string => {
  const t = (s ?? 'Thesis').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const nearblocksTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${enc(hash)}`;

export type DocMeta = {
  id: string;
  kind: ThesisKind;
  owner: string | null;
  strength: Strength | null;
  receipts: Receipts | null;
  challenges: Challenge[];
  published: boolean;
};

/* ------------------------------------------------------------------ cover */

const win = (w: { from?: string | null; to?: string | null } | null | undefined): string | null => (w && (w.from || w.to) ? `${w.from ?? 'unknown'} to ${w.to ?? 'unknown'}` : null);

export const windowOf = (t: Thesis): string | null => win(t.test?.window) ?? win(t.charts?.find((c) => c.window?.from || c.window?.to)?.window);

export type CoverField = { key: string; label: string; value: string; mono?: boolean };

export function coverLabel(m: Pick<DocMeta, 'kind'>): string {
  return m.kind === 'reference' ? 'Reference thesis' : 'Thesis';
}

export function coverFields(t: Thesis, m: DocMeta): CoverField[] {
  const out: CoverField[] = [
    { key: 'generated', label: 'Generated', value: t.generatedAt ? formatUtc(t.generatedAt) : 'unknown' },
    { key: 'owner', label: 'Owner', value: m.owner ?? (m.kind === 'reference' ? 'Nearesis (reference)' : 'unknown') },
    { key: 'window', label: 'Data window', value: windowOf(t) ?? 'unknown' },
    { key: 'days', label: 'Days compared', value: t.test?.n !== null && t.test?.n !== undefined ? String(t.test.n) : 'unknown' },
    { key: 'version', label: 'Version', value: t.version ?? 'unknown', mono: true },
    { key: 'id', label: 'Thesis id', value: m.id, mono: true },
  ];
  return out;
}

/** "Test plan locked 2026-11-14 09:20 UTC, before the data was seen", with the short fingerprint; null when no lock time is recorded. */
export function lockLine(t: Thesis): { text: string; fingerprint: string | null } | null {
  const p = t.test?.plan;
  if (!p?.lockedAt) return null;
  return { text: `Test plan locked ${formatUtc(p.lockedAt)}, before the data was seen`, fingerprint: p.sha256 ? p.sha256.slice(0, 12) : null };
}

export const COVER_NOTE = 'Every number in this report comes from a stored result cell. Unknown values are shown as unknown, never as zero.';

/* ------------------------------------------------------------------ tiles */

export type Tile = { key: string; label: string; value: string; sub: string | null; exact?: string; tone: Tone; small?: boolean };

const corr = (label: string, v: string | null | undefined, sub: string | null, key: string): Tile => ({ key, label, value: v ? readableCorrelation(v) : 'unknown', exact: v ?? undefined, sub, tone: '' });

/**
 * The stat tiles of the executive summary. A relationship-v2 thesis shows verdict, days, level, change, rank and strength;
 * a v1 thesis the numbers it has (same-day and lagged Pearson, window); the reference thesis its first comparison rows.
 */
export function documentTiles(t: Thesis, strength: Strength | null): Tile[] {
  const status = t.verdict?.status;
  const tiles: Tile[] = [{ key: 'verdict', label: 'Verdict', value: statusLabel(status), sub: null, tone: statusTone(status), small: true }];
  const test = t.test;
  if (test && isV2(test)) {
    if (test.n !== null && test.n !== undefined) tiles.push({ key: 'days', label: 'Days compared', value: String(test.n), sub: 'aligned days', tone: '' });
    tiles.push(corr('Level correlation', test.level, test.interval ? `${test.interval.levelPercent ?? 95}% interval ${intervalText(test.interval)}` : 'same day, no interval', 'level'));
    tiles.push(corr('Change correlation', test.change, 'day-over-day changes', 'change'));
    tiles.push(corr('Rank correlation', test.spearman, 'Spearman, of the levels', 'rank'));
  } else if (test && ((test.n !== null && test.n !== undefined) || test.pearson)) {
    if (test.n !== null && test.n !== undefined) tiles.push({ key: 'days', label: 'Days compared', value: String(test.n), sub: 'aligned days', tone: '' });
    tiles.push(corr('Same-day correlation', test.pearson, 'Pearson, levels', 'pearson'));
    const lag = (test.lag ?? [])[0];
    if (lag) tiles.push(corr(`Correlation at ${lag.days ?? 'unknown'}-day lag`, lag.value, 'Pearson, lagged', 'lag'));
    const w = win(test.window);
    if (w) tiles.push({ key: 'window', label: 'Window', value: w.replace(' to ', '\nto '), exact: w, sub: 'first to last aligned day', tone: '', small: true });
  } else {
    const rows = (t.verdict?.comparison ?? t.verdict?.intentsVsPrice)?.rows ?? [];
    for (const r of rows.slice(0, 4)) {
      const p = plainLabel(r.label, r.unit);
      const v = r.value === null || r.value === undefined || r.value === '' ? null : r.value;
      tiles.push({ key: `row-${tiles.length}`, label: p.label.length > 48 ? `${p.label.slice(0, 47)}…` : p.label, value: v === null ? 'unknown' : isCorrelation(r.label, r.unit) ? readableCorrelation(v) : readableNumber(v), exact: v ?? undefined, sub: r.unit ?? null, tone: '' });
    }
  }
  if (strength) tiles.push({ key: 'strength', label: 'Strength', value: `${strength.score} / 100`, sub: strength.band ?? 'unknown band', tone: '' });
  return tiles.slice(0, 6);
}

/** Why the verdict, in plain words; null when the document gives no reason codes. */
export function whyVerdict(t: Thesis): string | null {
  const r = t.test?.reasons ?? [];
  return r.length ? `${r.map(reasonText).join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : null;
}

export const verdictHeadline = (t: Thesis): string | null => stripStatusPrefix(t.verdict?.headline, t.verdict?.status);

/* ------------------------------------------------------------------ evidence */

export type Chip = { text: string; tone: string };
export type EvCard = { text: string; chips: Chip[]; cited: string[]; contradicting: boolean };
export type EvGroup = { label: string; notes: string[]; more: string[] };
export type EvPiece = { kind: 'cards' | 'table' | 'para' | 'groups' | 'heading'; cards?: EvCard[]; table?: string; text?: string; groups?: EvGroup[] };
export type Evidence = { intro: string[]; cards: EvCard[]; groups: EvGroup[]; tables: string[]; notes: string[] };

const CITE = /\[(\d{1,3})\]/g;

/** Pieces of a sentence: plain text and citation numbers. A marker is a citation only when the section lists references. */
export function citeParts(text: string, hasRefs: boolean): (string | number)[] {
  const t = stripRefs(text).replace(/\*\*|`/g, '').trim();
  if (!hasRefs) return [t];
  const out: (string | number)[] = [];
  let last = 0;
  for (const m of t.matchAll(CITE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(t.slice(last, at).replace(/\s+$/, last === 0 ? '' : ' '));
    out.push(Number(m[1]));
    last = at + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out.filter((p) => p !== '');
}

const noCite = (s: string): string => s.replace(CITE, '').replace(/\s+/g, ' ').trim();

const MORE = /^\d+ more .*notes? in the capsule/i;

/**
 * An evidence section's markdown as cards and notes. Bullets are statements, `> Finding (status, basis): ...` is a quoted
 * finding, `Cited value:` bullets belong to the card before them, bold lines name a group of skeptic notes, quoted lines
 * under a group are its notes and "n more ... notes in the capsule" is kept as the line it is. In the against section the
 * quoted findings (and a statement that says it cuts against the verdict) come first.
 */
export function parseEvidence(markdown: string | null | undefined, kind: 'for' | 'against'): Evidence {
  const ev: Evidence = { intro: [], cards: [], groups: [], tables: [], notes: [] };
  if (!markdown) return ev;
  const lines = markdown.split(/\r?\n/);
  let group: EvGroup | null = null;
  let last: EvCard | null = null;
  let para: string[] = [];
  let table: string[] = [];
  const flushPara = () => {
    const s = para.join(' ').trim();
    if (s) ev.notes.push(s);
    para = [];
  };
  const flushTable = () => {
    if (table.length) ev.tables.push(table.join('\n'));
    table = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      flushPara();
      table.push(line);
      continue;
    }
    flushTable();
    if (line === '') {
      flushPara();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flushPara();
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (bold) {
      flushPara();
      group = { label: bold[1]!.trim(), notes: [], more: [] };
      ev.groups.push(group);
      last = null;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      const q = quote[1]!.trim();
      const f = /^Finding \(([^)]*)\):\s*(.*)$/i.exec(q);
      if (f && !group) {
        const chips: Chip[] = f[1]!.split(',').map((x) => x.trim()).filter(Boolean).map((x, i) => ({ text: x, tone: i === 0 ? x.toLowerCase() : 'info' }));
        last = { text: f[2]!, chips, cited: [], contradicting: kind === 'against' };
        ev.cards.push(last);
        continue;
      }
      const note = q.replace(/^Skeptic note:\s*/i, '').replace(/^Limitation recorded with a finding:\s*/i, 'Limitation: ');
      (group ?? (group = { label: 'Other notes', notes: [], more: [] }, ev.groups.push(group), group)).notes.push(note);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const b = bullet[1]!.trim();
      if (MORE.test(noCite(b))) {
        (group ?? (group = { label: 'Other notes', notes: [], more: [] }, ev.groups.push(group), group)).more.push(b);
        continue;
      }
      const cited = /^Cited value:\s*(.*)$/i.exec(b);
      if (cited) {
        if (last) last.cited.push(cited[1]!);
        else {
          last = { text: cited[1]!, chips: [{ text: 'cited value', tone: 'info' }], cited: [], contradicting: false };
          ev.cards.push(last);
        }
        continue;
      }
      if (group) {
        group.notes.push(b);
        continue;
      }
      if (/^Heuristic phrase match:/i.test(b)) {
        ev.intro.push(b.replace(/^Heuristic phrase match:\s*/i, ''));
        last = null;
        continue;
      }
      const hn = /^Note \(heuristic check\):\s*(.*)$/i.exec(b);
      last = { text: hn ? hn[1]! : b, chips: hn ? [{ text: 'heuristic check', tone: 'warn' }] : [], cited: [], contradicting: false };
      ev.cards.push(last);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushTable();
  // contradicting first, otherwise the document's own order
  ev.cards = ev.cards.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c.contradicting) - Number(a.c.contradicting) || a.i - b.i).map((x) => x.c);
  return ev;
}

/** The first lines of evidence for the executive summary: contradicting cards first, then the statements, as plain text. */
export function firstEvidence(ev: Evidence, n = 2): string[] {
  return ev.cards.slice(0, n).map((c) => noCite(stripRefs(c.text)));
}

export const evidenceSections = (t: Thesis): { forSec: ThesisSection | null; againstSec: ThesisSection | null; mind: ThesisSection | null } => {
  const all = t.sections ?? [];
  const f = (id: string) => all.find((s) => s.id.toLowerCase().replace(/[^a-z0-9]+/g, '-') === id) ?? null;
  return { forSec: f('evidence-for'), againstSec: f('evidence-against'), mind: f('what-would-change-our-mind') };
};

/** What would change our mind: the verdict's list, else the bullets of the section. */
export function changeMind(t: Thesis): string[] {
  const v = (t.verdict?.whatWouldChangeOurMind ?? []).map((m) => noCite(stripRefs(m))).filter(Boolean);
  if (v.length) return v;
  const sec = evidenceSections(t).mind;
  if (!sec) return [];
  return sec.markdown.split(/\r?\n/).map((l) => /^[-*]\s+(.*)$/.exec(l.trim())?.[1]).filter((x): x is string => !!x).map((x) => noCite(stripRefs(x)));
}

/* ------------------------------------------------------------------ test plan */

export type PlanLine = { label: string; value: string; mono?: boolean };

export function planView(t: Thesis): { statement: string | null; lines: PlanLine[]; warnChosen: string | null; lock: { text: string; fingerprint: string | null } | null; locked: boolean } | null {
  const p = t.test?.plan;
  const test = t.test;
  if (!p) return null;
  const by = p?.chosenBy ?? (test?.pairSelection?.chosenBy === 'user' || test?.pairSelection?.chosenBy === 'planner' || test?.pairSelection?.chosenBy === 'rule' ? test.pairSelection.chosenBy : null);
  const chosen = by === 'user' ? 'the person who asked' : by === 'planner' ? 'the planner' : by === 'rule' ? 'a rule, not named in advance' : 'unknown';
  const relation = p?.relation === 'moves_with' ? 'moves with' : p?.relation === 'leads' ? (p.lagDays === null ? 'leads by an unknown number of days' : `leads by ${p.lagDays} ${p.lagDays === 1 ? 'day' : 'days'}`) : 'unknown';
  const sign = p?.expectedSign === 'either' ? 'either direction' : (p?.expectedSign ?? 'unknown');
  const lines: PlanLine[] = [];
  lines.push({ label: 'First series', value: p?.resolved?.x ?? test?.x ?? 'unknown' });
  lines.push({ label: 'Second series', value: p?.resolved?.y ?? test?.y ?? 'unknown' });
  lines.push({ label: 'Relation', value: p?.relation ? `${relation}` : 'unknown' });
  lines.push({ label: 'Expected direction', value: sign });
  lines.push({ label: 'Window', value: win(test?.window) ?? 'unknown' });
  lines.push({ label: 'Would count as wrong', value: p?.wouldCountAsWrong ?? 'unknown' });
  lines.push({ label: 'Pair chosen by', value: `${chosen}${p?.editedByUser && by !== 'user' ? ' (edited by the owner)' : ''}` });
  if (p?.why) lines.push({ label: 'Why this pair', value: p.why });
  const warn = by === 'rule' || test?.pairSelection?.label ? (test?.pairSelection?.label ?? 'pair chosen by rule, not named in advance') : null;
  return { statement: p?.statement ?? null, lines, warnChosen: warn, lock: lockLine(t), locked: !!p?.lockedAt };
}

/* ------------------------------------------------------------------ charts */

export type ChartView = {
  id: string;
  title: string;
  type: 'line' | 'bar';
  x: string[];
  series: { name: string; points: { x: string; y: number | null }[] }[];
  unit: string | null;
  meta: { k: string; v: string }[];
  sentence: string | null;
  against: string | null;
  caveats: string[];
  sql: string | null;
  sqlBigQuery: string | null;
  tag: { executed: boolean; text: string };
  resultHash: string | null;
  points: number;
  hidden: number;
};

const toNum = (v: string | null | undefined): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * A chart as drawn: the primary series when the document names one among several (the others stay in the data), otherwise
 * every series. A missing value is a gap, never zero.
 */
export function chartView(c: ThesisChart): ChartView {
  const all = c.series ?? [];
  const primary = (c as { primary?: unknown }).primary;
  const only = typeof primary === 'string' && all.length > 1 ? all.find((s) => s.name === primary) : undefined;
  const use = only ? [only] : all;
  const x = c.x ?? [];
  const series = use.map((s) => ({ name: s.name, points: x.map((px, i) => ({ x: px, y: toNum(s.values?.[i]) })) }));
  const points = series.reduce((n, s) => n + s.points.filter((p) => p.y !== null).length, 0);
  const perDataset = (c as { queries?: { sqlExecuted?: string | null }[] }).queries;
  const sql = c.sqlExecuted ?? ((Array.isArray(perDataset) ? perDataset : []).map((q) => q?.sqlExecuted).filter((s): s is string => !!s).join('\n\n') || null);
  const meta: { k: string; v: string }[] = [];
  if (only) meta.push({ k: 'metric', v: only.name });
  else if (c.unit) meta.push({ k: 'unit', v: c.unit });
  if (only && c.unit && !c.unit.includes(',')) meta.push({ k: 'unit', v: c.unit });
  meta.push({ k: 'source', v: c.source ?? 'unknown' });
  meta.push({ k: 'window', v: win(c.window) ?? 'unknown' });
  meta.push({ k: 'points', v: String(x.length) });
  return {
    id: c.id,
    title: c.title,
    type: c.kind === 'bar' ? 'bar' : 'line',
    x,
    series,
    unit: only ? null : (c.unit ?? null),
    meta,
    sentence: c.sentence ?? null,
    against: c.evidenceAgainst ?? null,
    caveats: c.caveats ?? [],
    sql,
    sqlBigQuery: c.sqlBigQuery ?? null,
    tag: queryTag(c),
    resultHash: (c as { resultHash?: string }).resultHash ?? c.sha256 ?? null,
    points,
    hidden: only ? all.length - 1 : 0,
  };
}

/* ------------------------------------------------------------------ sections */

export type SecId = 'summary' | 'plan' | 'for' | 'against' | 'charts' | 'claims' | 'mind' | 'monitors' | 'verification' | 'reproduction' | 'challenges' | 'limits' | 'sources';

/** Which sections the document has, in order, by their rules. The number printed in front of each is its place in this list. */
export function sectionPlan(t: Thesis, m: DocMeta): SecId[] {
  const { forSec, againstSec } = evidenceSections(t);
  const out: SecId[] = ['summary'];
  if (t.test?.plan) out.push('plan');
  if (forSec || againstSec) out.push('for', 'against');
  out.push('charts');
  if ((t.claims?.length ?? 0) > 0) out.push('claims');
  if (changeMind(t).length > 0) out.push('mind');
  if ((t.monitors?.length ?? 0) > 0 || (t.markers?.length ?? 0) > 0) out.push('monitors');
  out.push('verification', 'reproduction');
  if (m.challenges.length > 0) out.push('challenges');
  out.push('limits');
  if (sourceGroups(t).length > 0) out.push('sources');
  return out;
}

export const SECTION_TITLE: Record<SecId, string> = {
  summary: 'Executive summary',
  plan: 'Test plan',
  for: 'Evidence for',
  against: 'Evidence against',
  charts: 'Charts and tables',
  claims: 'Claims',
  mind: 'What would change our mind',
  monitors: 'Monitors and markers',
  verification: 'Verification',
  reproduction: 'Reproduction and receipts',
  challenges: 'Challenges',
  limits: 'Limits',
  sources: 'Sources',
};

export const sectionNumber = (plan: SecId[], id: SecId): string => String(plan.indexOf(id) + 1).padStart(2, '0');

/** The numbered references of each section that has some, for the small-type sources list. */
export function sourceGroups(t: Thesis): { title: string; refs: string[] }[] {
  return (t.sections ?? []).filter((s) => (s.references?.length ?? 0) > 0).map((s) => ({ title: s.title, refs: s.references! }));
}

/* ------------------------------------------------------------------ verification, receipts, strength, challenges */

export function strengthRows(s: Strength | null): { label: string; points: string; full: boolean; detail: string }[] {
  return (s?.parts ?? []).map(partView).map((p) => ({ label: p.label, points: `${p.points} / ${p.max}`, full: p.full, detail: p.explain }));
}

export const receiptsLine = (r: Receipts | null): string | null => (r ? receiptsText(r) : null);

export function challengeView(c: Challenge) {
  return { ...c, groups: groupNotes(c.notes) };
}

/** The rounding record as readable lines. */
export function roundingLines(t: Thesis): string[] {
  const r = t.test?.rounding;
  if (!r || r.series.length === 0) return [];
  return r.series.map((s) => `${s.name}: kept ${s.decimalsKept ?? 'unknown'} decimals, largest change from rounding ${s.maxAbsRoundingDifference ?? 'unknown'}`);
}
