import { z } from "zod";
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

const TopupBody = z.strictObject({ txHash: z.string().describe("base58 NEAR testnet transaction hash") });

/**
 * Credits and paid OutLayer proof routes (apps/api/src/credits-routes.ts, proof-routes.ts). Amounts are exact yoctoNEAR
 * decimal strings. Spread into ROUTES by openapi-routes.ts.
 */
export const CREDITS_ROUTES: RouteSpec[] = [
  R(
    "get",
    "/v1/credits",
    "credits",
    "Caller's credits: balance, held, available, deposit account, proof hold estimate, newest 50 entries",
    {
      ok: "Credits object (proofEstimateYocto is null when OutLayer proofs are disabled or the chain cannot be read; ?capsuleId sizes it for that capsule)",
    },
  ),
  R(
    "post",
    "/v1/credits/topups",
    "credits",
    "Credit a testnet transfer to the deposit account (422 TX_NOT_FOUND/TX_FAILED/WRONG_SIGNER/WRONG_RECEIVER/NOT_A_TRANSFER; 409 TOPUP_ALREADY_CREDITED/NO_NEAR_ACCOUNT)",
    {
      body: TopupBody,
      ok: "The new credits object",
    },
  ),
  R(
    "post",
    "/v1/capsules/:id/proofs",
    "credits",
    "Request a paid OutLayer proof (202 running; 402 INSUFFICIENT_CREDITS; 503 PROOF_PROVIDER_DISABLED; 409 ALREADY_PROVED/TESTNET_CAP_REACHED/PROOF_IN_PROGRESS)",
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
  R("get", "/v1/proofs/:proofId", "credits", "One proof record (state, job, verification, cost)", {
    ok: "Proof",
  }),
];
