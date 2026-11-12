import { z } from 'zod';

const n = z.coerce.number();
const s = z.string();
const sOpt = z.string().nullable().optional();

export const zConfig = z.object({
  network: s,
  capability: s,
  topicId: s,
  operatorId: s,
  asset: s,
  assetDecimals: n,
  mirrorUrl: s,
  hashscan: s,
  providers: z.array(z.object({ id: s, name: s, price: s.or(n).transform(String), payTo: s })),
  baselineAgents: z.array(s),
  world: z.object({ issuer: s, subStable: z.boolean() }),
});
export type Config = z.infer<typeof zConfig>;

export const zLoginStart = z.object({
  attemptId: s, userCode: s, verificationUri: s, verificationUriComplete: s, expiresIn: n, interval: n,
});
export const zLoginPoll = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'FAILED']),
  reason: sOpt,
  token: s.optional(),
  human: z.object({ humanHash: s, budgetAccountId: s }).optional(),
});

export const zAgent = z.object({
  agentAddr: s, label: s, accountId: s, epoch: n, status: s, linkedAt: s.or(n).transform(String),
});
export type Agent = z.infer<typeof zAgent>;

export const zPolicy = z.object({ capPerPayment: s, dailyCap: s, allowlist: z.array(s), spentToday: s });
export type Policy = z.infer<typeof zPolicy>;

export const zMe = z.object({
  humanHash: s,
  budgetAccountId: s,
  balance: z.object({ asset: s, amount: s, display: s.optional(), hbar: s }),
  policy: zPolicy,
  agents: z.array(zAgent),
  pairing: z.object({ code: s, expiresAt: s.or(n).transform(String) }).nullable().optional(),
  world: z.object({ subStable: z.boolean() }).optional(),
});
export type Me = z.infer<typeof zMe>;

export const zPairing = z.object({ code: s, expiresAt: s.or(n).transform(String) });

export const zApprovalStart = z.object({
  approvalId: s, userCode: s, verificationUri: s, verificationUriComplete: s, expiresIn: n, interval: n,
});
export const zApproval = z.object({
  approvalId: s,
  kind: s,
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'USED']),
  action: z.unknown(),
  digest: s,
  expiresAt: s.or(n).transform(String),
});

export const INTENT_STATUS = ['CREATED', 'SENT', 'PAYMENT_UNKNOWN', 'PAID', 'DONE', 'REFUNDED', 'REJECTED', 'FAILED', 'VOID'] as const;
export const zIntent = z.object({
  intentId: s,
  jobKey: s,
  round: n,
  agentAddr: s,
  providerId: s,
  payTo: s,
  asset: s,
  amount: s.or(n).transform(String),
  txId: s,
  deadline: n,
  status: z.enum(INTENT_STATUS),
  attempts: n.optional(),
  consensusTimestamp: sOpt,
  lastError: sOpt,
  result: z.any().optional(),
});
export type Intent = z.infer<typeof zIntent>;

export const zJobClaim = z.object({
  seq: n, cts: s.optional(), agent: s, human: s.optional(), epoch: n.optional(), svc: s, price: s.or(n).transform(String),
  valid: z.boolean().optional(), reason: sOpt,
});
export const zJob = z.object({
  jobKey: s,
  round: n,
  status: z.enum(['OPEN', 'CLAIMED', 'PAYING', 'PAID', 'DONE', 'REFUNDED']),
  winner: zJobClaim.nullable().optional(),                 // referee ClaimView of the current round's winner
  claims: z.array(zJobClaim).default([]),
  intent: zIntent.nullable().optional(),                   // DB intentPublic (latest round) — the route overrides the HCS one
  onchainIntent: z.object({ seq: n, tx: s, deadline: n }).nullable().optional(), // HCS INTENT seen by the referee
  settled: z.object({ seq: n, tx: s, cts: s }).nullable().optional(),
  history: z.array(z.object({ round: n, tx: s.optional(), seq: n.optional() })).optional(),
  lastSeq: n.optional(),
});
export type Job = z.infer<typeof zJob>;

const zTx = z.object({ txId: s, cts: s, to: s, amount: s.or(n).transform(String) });
export const zCounter = z.object({
  jobKey: s,
  source: s,
  forkos: z.object({ payments: n, txs: z.array(zTx) }),
  baseline: z.object({ payments: n, txs: z.array(zTx) }),
});
export type Counter = z.infer<typeof zCounter>;

// Service directory entry from an HCS SERVICE announcement (registered provider accounts only).
export const zService = z.object({
  providerId: s, name: s, capability: s, network: s, asset: s, price: s, endpoint: s, payTo: s, seq: n, cts: s,
});
export const zDirectory = z.object({ services: z.array(zService) });


// HCS messages are spread into each event, so only seq/cts/t are guaranteed; keep the rest as a record.
export const zTimelineEv = z.looseObject({ seq: n, cts: s, payer: s.optional(), t: s });
export type TimelineEv = z.infer<typeof zTimelineEv>;
export const zTimeline = z.object({ events: z.array(zTimelineEv) });

export const zDemoJob = z.object({ audioUrl: s, inputHash: s });
export const zArmed = z.object({ armed: z.boolean() });
export const zAny = z.any();
