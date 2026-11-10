/** Typed runtime errors with stable `reasonCode` (A3 brief §10). All are non-retryable policy decisions. */
export type ReasonCode =
  | "DEPTH_LIMIT"
  | "FANOUT_LIMIT"
  | "TOOL_CALL_BUDGET"
  | "STAGE_TIMEOUT"
  | "TOOL_NOT_GRANTED"
  | "UNKNOWN_TOOL"
  | "TOOL_INPUT_INVALID"
  | "APPROVAL_INVALID"
  | "APPROVAL_REJECTED"
  | "BUDGET_EXCEEDED"
  | "CAPABILITY_ESCALATION"
  | "ILLEGAL_TRANSITION"
  | "SOURCE_UNAVAILABLE"
  | "CANNOT_COMPUTE"
  | "UNGROUNDED_NUMBER"
  | "CANCELLED";

export class AgentRuntimeError extends Error {
  readonly retryable = false;
  constructor(
    readonly reasonCode: ReasonCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

export function isRuntimeError(e: unknown): e is AgentRuntimeError {
  return e instanceof AgentRuntimeError;
}
