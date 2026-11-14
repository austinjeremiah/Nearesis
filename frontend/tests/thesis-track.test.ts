import { describe, expect, it } from 'vitest';
import { errorFromResponse } from '@/lib/api/errors';
import { parseInline, parseMarkdown, safeHref } from '@/lib/thesis-track/markdown';
import {
  bytesBilledOf,
  chartSeries,
  formatBytes,
  isNotBuilt,
  observedPoints,
  orUnknown,
  pickSections,
  queryTag,
  statusLabel,
  statusTone,
  stripLeadingHeading,
} from '@/lib/thesis-track/model';

describe('markdown: safety', () => {
  it('never produces HTML nodes: tags stay text', () => {
    const inl = parseInline('<img src=x onerror=alert(1)> and <script>x</script>');
    expect(inl.every((n) => n.t === 'text')).toBe(true);
    expect(JSON.stringify(inl)).toContain('<script>');
  });
  it('drops javascript: and data: link targets but keeps the text', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('https://near.org')).toBe('https://near.org');
    expect(safeHref('/data/sources')).toBe('/data/sources');
    const inl = parseInline('[click](javascript:alert(1))');
    expect(inl).toEqual([{ t: 'text', v: 'click' }]);
  });
});

describe('markdown: blocks', () => {
  it('parses headings, paragraphs, lists, code, quotes and rules', () => {
    const b = parseMarkdown('# Title\n\nSome **bold** and *em* and `code`.\nSecond line.\n\n- a\n- b\n\n1. one\n2. two\n\n```sql\nSELECT 1;\n```\n\n> quoted\n\n---\n');
    expect(b.map((x) => x.t)).toEqual(['heading', 'p', 'list', 'list', 'code', 'quote', 'hr']);
    expect(b[0]).toMatchObject({ t: 'heading', level: 1 });
    expect(b[1]).toMatchObject({ t: 'p', c: [{ t: 'text', v: 'Some ' }, { t: 'strong' }, { t: 'text', v: ' and ' }, { t: 'em' }, { t: 'text', v: ' and ' }, { t: 'code', v: 'code' }, { t: 'text', v: '. Second line.' }] });
    expect(b[2]).toMatchObject({ ordered: false });
    expect(b[3]).toMatchObject({ ordered: true });
    expect(b[4]).toEqual({ t: 'code', lang: 'sql', v: 'SELECT 1;' });
  });
  it('parses a table with an escaped pipe and pads short rows', () => {
    const b = parseMarkdown('| Horizon | MAE |\n| --- | ---: |\n| 1 | 0.5 |\n| 7 | a\\|b |\n| 14 |\n');
    const t = b[0]!;
    expect(t.t).toBe('table');
    if (t.t !== 'table') return;
    expect(t.head).toHaveLength(2);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[1]![1]).toEqual([{ t: 'text', v: 'a|b' }]);
    expect(t.rows[2]![1]).toEqual([]);
  });
  it('keeps code fences literal', () => {
    const b = parseMarkdown('```\n# not a heading\n| a | b |\n```');
    expect(b).toEqual([{ t: 'code', lang: '', v: '# not a heading\n| a | b |' }]);
  });
  it('does not treat snake_case or a lone asterisk as emphasis', () => {
    expect(parseInline('block_date and near_price_daily')).toEqual([{ t: 'text', v: 'block_date and near_price_daily' }]);
    expect(parseInline('2 * 3')).toEqual([{ t: 'text', v: '2 * 3' }]);
  });
});

describe('view model', () => {
  it('maps status to tone and label', () => {
    expect(statusTone('SUPPORTED')).toBe('ok');
    expect(statusTone('NOT_SUPPORTED')).toBe('bad');
    expect(statusTone('MIXED')).toBe('info');
    expect(statusTone('INSUFFICIENT_DATA')).toBe('warn');
    expect(statusTone('weird')).toBe('');
    expect(statusTone(undefined)).toBe('');
    expect(statusLabel('INSUFFICIENT_DATA')).toBe('INSUFFICIENT DATA');
    expect(statusLabel(undefined)).toBe('unknown');
  });
  it('keeps nulls as gaps and exact strings, and pads short series with null, never 0', () => {
    const s = chartSeries({ x: ['d1', 'd2', 'd3'], series: [{ name: 'v', values: ['1.50', null] }] });
    expect(s).toEqual([{ name: 'v', points: [{ x: 'd1', y: '1.50' }, { x: 'd2', y: null }, { x: 'd3', y: null }] }]);
    expect(chartSeries({})).toEqual([]);
  });
  it('counts only observed points', () => {
    expect(observedPoints({ x: ['a', 'b'], series: [{ name: 'v', values: [null, null] }] })).toBe(0);
    expect(observedPoints({ x: ['a', 'b'], series: [{ name: 'v', values: ['0', null] }] })).toBe(1);
  });
  it('formats bytes in binary units and says unknown when absent', () => {
    expect(formatBytes('512')).toBe('512 B');
    expect(formatBytes('1536')).toBe('1.50 KiB');
    expect(formatBytes('1073741824')).toBe('1.00 GiB');
    expect(formatBytes('796917760')).toBe('760 MiB');
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes('abc')).toBe('unknown');
    expect(formatBytes('0')).toBe('0 B');
  });
  it('reads bytes billed from the field or the SQL header', () => {
    expect(bytesBilledOf({ bigQueryBytesBilled: '2048' })).toBe('2048');
    expect(bytesBilledOf({ sqlBigQuery: '-- bytes billed: 1,048,576\nSELECT 1' })).toBe('1048576');
    expect(bytesBilledOf({ sqlExecuted: 'SELECT 1' })).toBeNull();
  });
  it('tags a query as executed only when the bundle says so', () => {
    expect(queryTag({ bigQueryExecuted: false })).toEqual({ executed: false, text: 'Not executed in this build' });
    expect(queryTag({})).toEqual({ executed: false, text: 'Not executed in this build' });
    expect(queryTag({ bigQueryExecuted: true, bigQueryBytesBilled: '1073741824' })).toEqual({ executed: true, text: 'Executed on BigQuery · 1.00 GiB billed' });
    expect(queryTag({ bigQueryExecuted: true }).text).toBe('Executed on BigQuery · bytes billed unknown');
  });
  it('picks the prominent sections and leaves the rest in order', () => {
    const sections = [
      { id: 'executive-claim', title: 'Executive claim', markdown: '' },
      { id: 'evidence-for', title: 'Evidence for', markdown: '' },
      { id: 'evidence-against', title: 'Evidence against', markdown: '' },
      { id: 'what-would-change-our-mind', title: 'What would change our mind', markdown: '' },
      { id: 'limits', title: 'Limits', markdown: '' },
    ];
    const p = pickSections(sections);
    expect(p.evidenceFor?.id).toBe('evidence-for');
    expect(p.evidenceAgainst?.id).toBe('evidence-against');
    expect(p.changeMind?.id).toBe('what-would-change-our-mind');
    expect(p.rest.map((s) => s.id)).toEqual(['executive-claim', 'limits']);
    expect(pickSections(undefined).rest).toEqual([]);
  });
  it('strips only a leading heading that repeats the title', () => {
    expect(stripLeadingHeading('## Evidence for\n\nBody', 'Evidence for')).toBe('Body');
    expect(stripLeadingHeading('## Other\n\nBody', 'Evidence for')).toBe('## Other\n\nBody');
  });
  it('shows unknown, never zero, for missing values', () => {
    expect(orUnknown(null)).toBe('unknown');
    expect(orUnknown('')).toBe('unknown');
    expect(orUnknown('0')).toBe('0');
    expect(orUnknown(0)).toBe('0');
  });
  it('recognises the THESIS_NOT_BUILT refusal', () => {
    expect(isNotBuilt(errorFromResponse(503, { errorCode: 'UPSTREAM_DEGRADED', reasonCode: 'THESIS_NOT_BUILT', message: 'x', retryable: true }))).toBe(true);
    expect(isNotBuilt(errorFromResponse(503, { errorCode: 'UPSTREAM_DEGRADED', reasonCode: 'OTHER', message: 'x', retryable: true }))).toBe(false);
    expect(isNotBuilt(new Error('THESIS_NOT_BUILT'))).toBe(false);
  });
});
