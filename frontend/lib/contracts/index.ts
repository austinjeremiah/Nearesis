/**
 * Canonical frontend contracts for Nearesis, derived from the Frontend Product
 * Spec v1 (sections 4.1–4.5, 6.2, 7.1, 7.4).
 *
 * These are the shapes the UI reads. The backend is the source of truth, so when
 * the API lands these schemas are the compatibility check, not a second
 * definition: parse at the boundary, and a drift shows up as a validation error
 * in one place instead of as a wrong number on a chart.
 *
 * Nothing here duplicates authorization. ACLs and metric certification live on
 * the server; the client only renders what it is given.
 */

export * from './enums';
export * from './query';
export * from './panel';
export * from './events';
export * from './errors';
