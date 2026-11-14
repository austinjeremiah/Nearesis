import type { HttpMethod, ResponseSpec, RouteSpec } from "@nearesis/contracts";

const R = (
  method: HttpMethod,
  path: string,
  tag: string,
  summary: string,
  extra: Partial<RouteSpec> & { ok?: ResponseSpec | string; status?: string } = {},
): RouteSpec => {
  const { ok, status, ...rest } = extra;
  const okResp: ResponseSpec =
    typeof ok === "string" || ok === undefined ? { description: ok ?? "OK", untyped: true } : ok;
  return { method, path, tag, summary, auth: "bearer", responses: { [status ?? "200"]: okResp }, ...rest };
};

/**
 * Unified USD credits and the paid OutLayer proof routes (apps/api/src/credits-routes.ts, proof-routes.ts). One balance per
 * user in USD (6-place decimal strings); it pays for model calls and, converted at the latest local NEAR/USD close, for
 * OutLayer proofs and publication anchor gas. There are no top-ups. Spread into ROUTES by openapi-routes.ts.
 */
export const CREDITS_ROUTES: RouteSpec[] = [
  R(
    "get",
    "/v1/credits",
    "credits",
    "Caller's USD credits: allowance, spent, held, available, exhausted, per-category totals, NEAR/USD rate, proof hold estimate, newest 100 entries",
    {
      ok: "{ allowanceUsd, spentUsd, heldUsd, availableUsd, exhausted, contactEmail, byCategory: { modelUsd, outlayerUsd, anchorUsd }, nearUsdRate: { rate, date } | null, proofEstimateUsd: string | null, entries: [{ id, kind: grant|hold|charge|release, category: model|outlayer|anchor|grant, amountUsd, refKind, refId, detail, createdAt }] }. The allowance is granted on first use. proofEstimateUsd is null when proofs are disabled, the chain cannot be read or no NEAR/USD close is held; ?capsuleId sizes it for that capsule. Exhausted accounts get 402 BUDGET_EXCEEDED / CREDITS_EXHAUSTED on every paid route, with details { allowanceUsd, spentUsd, availableUsd, requiredUsd | null, contactEmail }.",
    },
  ),
  R(
    "post",
    "/v1/capsules/:id/proofs",
    "credits",
    "Request a paid OutLayer proof (202 running; 402 CREDITS_EXHAUSTED; 503 PROOF_PROVIDER_DISABLED/PRICE_UNAVAILABLE; 409 ALREADY_PROVED/TESTNET_CAP_REACHED/PROOF_IN_PROGRESS)",
    {
      headers: [
        { name: "Idempotency-Key", description: "8-200 chars; a repeated key replays the first result." },
      ],
      status: "202",
      ok: "{ proofId, state: running }",
    },
  ),
  R(
    "get",
    "/v1/capsules/:id/proofs",
    "credits",
    "Proof records of a capsule, newest first (includes a stored legacy proof file)",
    {
      ok: "{ items: Proof[] }",
    },
  ),
  R(
    "get",
    "/v1/proofs/:proofId",
    "credits",
    "One proof record (state, job, verification, cost: { heldUsd, chargedUsd, gasUsd, totalUsd, chargedYocto, gasYocto, totalYocto, nearUsdRate, rateDate })",
    {
      ok: "Proof",
    },
  ),
];
