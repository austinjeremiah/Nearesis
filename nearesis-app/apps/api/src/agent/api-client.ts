import type { FastifyInstance } from "fastify";
import type { StepError } from "./types.ts";

export interface AgentUser {
  userId: string;
  orgId: string;
}
export interface ApiResponse {
  status: number;
  body: unknown;
}
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** Calls a public route in-process as the user (a session minted for that user, never a shared credential). */
export type AgentApi = (
  user: AgentUser,
  method: Method,
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => Promise<ApiResponse>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reasonCode: string,
    message: string,
    readonly retryable: boolean,
    readonly details: string[] = [],
  ) {
    super(message);
  }
  toStepError(): StepError {
    return {
      reasonCode: this.reasonCode,
      message: this.message,
      retryable: this.retryable,
      ...(this.reasonCode === "ACKNOWLEDGEMENT_REQUIRED" && this.details.length
        ? { acknowledge: this.details }
        : {}),
    };
  }
}

export function apiErrorOf(r: ApiResponse): ApiError {
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
  const reasonCode = typeof b.reasonCode === "string" ? b.reasonCode : `HTTP_${r.status}`;
  const message = typeof b.message === "string" ? b.message : `The request failed with status ${r.status}.`;
  const retryable = typeof b.retryable === "boolean" ? b.retryable : r.status >= 500 || r.status === 429;
  const details = Array.isArray(b.details)
    ? (b.details as Array<{ issue?: unknown }>).map((d) => String(d?.issue ?? "")).filter(Boolean)
    : [];
  return new ApiError(r.status, reasonCode, message, retryable, details);
}

export function injectApi(
  app: Pick<FastifyInstance, "inject">,
  mint: (u: AgentUser) => Promise<string>,
): AgentApi {
  return async (user, method, url, payload, headers) => {
    const token = await mint(user);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(headers ?? {}) },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: unknown;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = null;
    }
    return { status: res.statusCode, body };
  };
}

/** Calls and returns the JSON body, or throws the API's own reason as an ApiError. */
export async function call<T = Record<string, unknown>>(
  api: AgentApi,
  user: AgentUser,
  method: Method,
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const r = await api(user, method, url, payload, headers);
  if (r.status < 200 || r.status >= 300) throw apiErrorOf(r);
  return { status: r.status, body: r.body as T };
}
