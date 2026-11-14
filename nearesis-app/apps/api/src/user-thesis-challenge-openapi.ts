import { z } from "zod";
import type { RouteSpec } from "@nearesis/contracts";

const CHALLENGE =
  "{ challengeId, outcome: 'holds'|'weakened'|'unsupported'|'unavailable', notes: [{ text, group: 'coverage'|'window'|'measurement'|'causation'|'alternative', severity: 'minor'|'material', refs: [string] }], droppedNotes, cost: { usd, modelCalls }, by, createdAt, answer: string|null, answeredAt: ISO|null }";

/**
 * Thesis challenges (apps/api/src/user-thesis-challenge-routes.ts). Spread into ROUTES by openapi-routes.ts. The challenge is
 * the only thesis route that calls a model; it is charged to the caller's USD credits and counted in the global ceiling.
 */
export const USER_THESIS_CHALLENGE_ROUTES: RouteSpec[] = [
  {
    method: "post",
    path: "/v1/theses/:id/challenge",
    tag: "thesis",
    summary:
      "Challenge a thesis: one skeptic model call over its claim, test numbers and chart facts (uses credits)",
    description:
      "No body. Gate before the call: 402 CREDITS_EXHAUSTED when the caller's USD credits are used up, 402 GLOBAL_CEILING when the global model-spend ceiling is reached (nothing is stored then). The model's notes are untrusted: a note is kept only if every number in it matches a listed fact, it passes the wording rules and carries no advice; failing notes are dropped and counted in `droppedNotes`. The outcome is computed from the kept notes: no material note -> holds; three or more material notes, or a material alternative/measurement note about the test -> unsupported; other material notes -> weakened; a failed model call, or every note dropped -> unavailable (nothing stored as a note). The actual USD is charged once. The thesis document and its hash never change. Errors: 404 THESIS_NOT_FOUND, 429 TOO_MANY_CHALLENGES, 503 MODEL_NOT_CONFIGURED.",
    auth: "bearer",
    responses: { "200": { description: CHALLENGE, untyped: true } },
  },
  {
    method: "get",
    path: "/v1/theses/:id/challenges",
    tag: "thesis",
    summary: "The challenges of a thesis the caller can open (newest first)",
    auth: "bearer",
    responses: { "200": { description: `{ challenges: [${CHALLENGE}] }`, untyped: true } },
  },
  {
    method: "post",
    path: "/v1/theses/:id/challenges/:cid/answer",
    tag: "thesis",
    summary: "Answer a challenge as the thesis owner (editor or above; once per challenge)",
    description:
      "Only the organisation that owns the thesis (404 otherwise); the reference thesis has no owner (422 THESIS_IS_REFERENCE). A challenge with outcome `unavailable` cannot be answered (422 CHALLENGE_NOT_ANSWERABLE); an answered one cannot be answered again (422 CHALLENGE_ALREADY_ANSWERED). The wording rules apply (422 ANSWER_WORDING_REJECTED). An answer to every challenge with material notes restores the strength part `challenges_answered`.",
    auth: "bearer",
    role: "writer",
    body: z.strictObject({ text: z.string().min(1).max(600) }),
    responses: { "200": { description: CHALLENGE, untyped: true } },
  },
];
