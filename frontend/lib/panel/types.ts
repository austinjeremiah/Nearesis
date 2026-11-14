import type { Schemas } from '@/lib/api/types';

/** Response of GET /v1/workspaces/:id/panels/:hash/data (semantic and analytics on one route). */
export type PanelData = Schemas['PanelDataResponse'];
export type PanelChart = NonNullable<PanelData['chart']>;

export type Layout = { x: number; y: number; w: number; h: number };

export type PanelEncoding = {
  x?: string;
  y?: string[];
  series?: string;
  tooltip?: string[];
  scale?: 'linear' | 'log' | 'index_100';
  aggregation?: string;
  interpolateGaps?: boolean;
};

export type PanelAnalytics = {
  label: string;
  analysis: string;
  capability: string;
  sourceTables: string[];
  certification: string;
  coverageState: string;
  metricVersion: string;
};

/** A panel as the canvas document stores it. */
export type CanvasPanel = {
  panelId: string;
  kind: 'timeSeries' | 'candlestick' | 'bar' | 'scatter' | 'heatmap' | 'cohort' | 'evidenceGraph' | 'table' | 'note' | 'waterfall';
  title: string;
  layout: Layout;
  encoding?: PanelEncoding;
  queryRef?: { hash: string; semanticVersion: string; snapshotPolicy?: 'live' | 'pinned'; resultKind?: 'semantic_query' | 'analytics_result' };
  dataBinding?: { fields: string[]; units: Record<string, string>; timezone: string; completeness: 'complete' | 'partial' | 'unavailable' };
  refreshPolicy?: { mode: string };
  note?: string;
  analytics?: PanelAnalytics;
  [k: string]: unknown;
};

export type MarkerAnchor =
  | { kind: 'time_point'; at: string }
  | { kind: 'time_range'; start: string; end: string }
  | { kind: 'threshold'; metricId: string; op: 'gt' | 'lt'; value: number }
  | { kind: 'source_event'; sourceId: string; eventId: string; at: string };

export type CanvasMarker = { markerId: string; panelId: string; anchor: MarkerAnchor; status: string; question?: string; createdAt?: string };

export type CanvasDocument = {
  id: string;
  workspaceId: string;
  documentRevision: number;
  dataRevision: number;
  layoutMode?: string;
  panels: CanvasPanel[];
  markers: CanvasMarker[];
  updatedAt?: string;
};

export type Lens = Schemas['LensListResponse']['lenses'][number];
export type LensResolution = {
  lensId: string;
  panels: { panelId: string; compatible: boolean; reason: string | null; appliedFilter: Lens['filter'] | null }[];
};

export type PanelProgress = 'QUERYING' | 'READY' | 'ERROR';
