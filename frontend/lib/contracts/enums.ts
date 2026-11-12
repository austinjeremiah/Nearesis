import { z } from 'zod';

/**
 * Canonical vocabularies from the Frontend Product Spec v1, sections 4.1, 4.4,
 * 4.5 and 6.2. Everything the UI renders as a status, verdict or reason resolves
 * to one of these. Screens never invent their own status strings: the spec
 * requires one shared enum mapped consistently to icon, label and tooltip.
 */

/** 4.1 — when the data is from. Independent of where it came from. */
export const DataMode = z.enum(['live', 'frozen', 'replay']);
export type DataMode = z.infer<typeof DataMode>;

/**
 * 4.1 — what the data actually is. Deliberately separate from DataMode: a frozen
 * synthetic dataset is both FROZEN and SYNTHETIC, and collapsing the two is how a
 * mock number ends up under a LIVE badge.
 */
export const DatasetOrigin = z.enum(['live_provider', 'recorded', 'synthetic', 'fixture']);
export type DatasetOrigin = z.infer<typeof DatasetOrigin>;

/** 4.5 — panel lifecycle. */
export const PanelStatus = z.enum([
  'draft',
  'validating',
  'querying',
  'ready',
  'stale',
  'refreshing',
  'error',
  'archived',
]);
export type PanelStatus = z.infer<typeof PanelStatus>;

/** How complete the underlying observations are at the time of reading. */
export const SourceMaturity = z.enum(['finalized', 'provisional', 'partial', 'stale']);
export type SourceMaturity = z.infer<typeof SourceMaturity>;

/**
 * 4.4 — the missingness and uncertainty vocabulary. These are rendered verbatim
 * so a reader can tell an observed zero from an unavailable value. A chart that
 * cannot produce a number emits one of these instead of a plausible curve.
 */
export const ReasonCode = z.enum([
  'PARTIAL', // some contributing observations unavailable
  'STALE', // last known data older than expected
  'NOT_OBSERVABLE', // unavailable under source visibility rules
  'INSUFFICIENT_DATA', // statistical requirement unmet
  'METHOD_NOT_VALIDATED', // method lacks sufficient calibration
  'BLOCKED_DEPENDENCY', // external prerequisite not available
  'BLOCKED_SOURCE', // study needs fresh data, source is degraded
  'REPLAY', // simulated historical delivery
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/**
 * 4.4 — a measure cell is a number or an explicit absence. `null` is "—", not 0.
 * Keeping this a union at the type level stops a zero being substituted silently.
 */
export const MeasureValue = z.union([z.number(), z.null()]);
export type MeasureValue = z.infer<typeof MeasureValue>;

/** Claim verdicts. Four, fixed. A null result is a passing result. */
export const ClaimVerdict = z.enum(['supported', 'mixed', 'unsupported', 'insufficient_data']);
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

/**
 * Evidence strength is reported beside the verdict, never multiplied into it.
 * Spec 0: "confidence" must distinguish model uncertainty, statistical
 * significance, evidence strength and source coverage.
 */
export const EvidenceStrength = z.enum(['strong', 'moderate', 'weak', 'none']);
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;

/** 5.6 — the visible agent roles in the investigation progression. */
export const AgentRole = z.enum([
  'director',
  'scout',
  'quant',
  'skeptic',
  'composer',
  'auditor',
  'maintainer',
  'publisher',
  'monitor',
  'reviewer',
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Durable run lifecycle. Owned by the workflow engine, mirrored in the UI. */
export const RunState = z.enum([
  'planning',
  'awaiting_approval',
  'queued',
  'running',
  'partial',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);
export type RunState = z.infer<typeof RunState>;

/** 1.3 — workspace roles. Drives which actions render enabled. */
export const PrincipalRole = z.enum([
  'owner',
  'analyst',
  'reviewer',
  'data_maintainer',
  'agent_principal',
  'public_reader',
]);
export type PrincipalRole = z.infer<typeof PrincipalRole>;

/** 5.10 — source health as shown in the sources list. */
export const SourceHealth = z.enum([
  'healthy',
  'degraded',
  'auth_needed',
  'backfill',
  'unavailable',
]);
export type SourceHealth = z.infer<typeof SourceHealth>;

/** 5.26 — approval lifecycle. An approval is invalidated by any payload change. */
export const ApprovalState = z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded']);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** Thesis lifecycle as surfaced on Overview. */
export const ThesisStatus = z.enum([
  'draft',
  'under_investigation',
  'review_required',
  'published',
]);
export type ThesisStatus = z.infer<typeof ThesisStatus>;
