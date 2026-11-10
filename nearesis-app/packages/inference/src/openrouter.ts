import { z } from "zod";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { InferenceError, redact } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { SpendLedger, defaultLedgerPath, resolveBudgetUsd } from "./spend.ts";
import { validateWithRepair } from "./structured.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Per-run token cap (A21). */
export const RUN_TOKEN_CAP = 20_000;

export type FailureClass =
  | "ok"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "provider_unavailable"
  | "model_not_found"
  | "empty_completion"
  | "schema_invalid"
  | "auth"
  | "billing"
  | "bad_request"
  | "not_byok"
  | "metadata_unavailable";

export interface AttemptRecord {
  model: string;
  try: number;
  outcome: FailureClass;
  httpStatus: number | null;
  latencyMs: number;
  source: "http" | "catalog";
  detail?: string;
}

export interface CatalogModel {
  id: string;
  supportedParameters: string[];
  pricing: { prompt: number; completion: number; maxPrompt: number; maxCompletion: number } | null;
}

export interface ModelValidation {
  id: string;
  listed: boolean;
  structuredOutputs: boolean;
  tools: boolean;
  supported: boolean;
  pricing: { prompt: number; completion: number } | null;
}

export interface OpenRouterOptions {
  apiKey: string;
  primaryModel?: string;
  fallbackModels?: string[];
  allowedProviders?: string[];
  baseUrl?: string;
  ledger?: SpendLedger;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Max polls for generation metadata (it can lag the completion). */
  generationPolls?: number;
  tokenCap?: number;
}

interface Chat {
  id?: string;
  provider?: string;
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    cost_details?: { upstream_inference_cost?: number | null };
  };
}

interface GenerationMeta {
  id?: string;
  is_byok?: boolean;
  provider_name?: string;
  model?: string;
  total_cost?: number;
  upstream_inference_cost?: number | null;
  tokens_prompt?: number;
  tokens_completion?: number;
  latency?: number;
}

class ModelFailure extends Error {
  constructor(
    readonly cls: FailureClass,
    readonly httpStatus: number | null,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v: unknown): number => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN);

export function classifyHttp(
  status: number,
  body?: { error?: { code?: number | string; message?: string } },
): {
  cls: FailureClass;
  recoverable: boolean;
} {
  const code = typeof body?.error?.code === "number" ? body.error.code : status;
  const msg = (body?.error?.message ?? "").toLowerCase();
  if (code === 401 || code === 403) return { cls: "auth", recoverable: false };
  if (code === 402) return { cls: "billing", recoverable: false };
  if (code === 404 || (code === 400 && /model.*(not|invalid|unknown)|no such model/.test(msg)))
    return { cls: "model_not_found", recoverable: true };
  if (code === 429) return { cls: "rate_limited", recoverable: true };
  if (code === 408) return { cls: "timeout", recoverable: true };
  if (
    code === 503 ||
    /no (allowed )?providers?|no endpoints|provider.*(unavailable|returned error)/.test(msg)
  )
    return { cls: "provider_unavailable", recoverable: true };
  if (code >= 500) return { cls: "server_error", recoverable: true };
  return { cls: "bad_request", recoverable: false };
}

export class OpenRouterProvider implements InferenceProvider {
  readonly id = "openrouter";
  readonly primaryModel: string | undefined;
  readonly fallbackModels: string[];
  readonly allowedProviders: string[];
  readonly attempts: AttemptRecord[] = [];
  tokensUsed = 0;
  usdSpentThisRun = 0;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly polls: number;
  private readonly tokenCap: number;
  readonly spend: SpendLedger;
  private catalog: Map<string, CatalogModel> | null = null;

  constructor(opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new InferenceError("UPSTREAM_AUTH", "OPENROUTER_API_KEY not provided");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
    this.primaryModel = opts.primaryModel;
    this.fallbackModels = opts.fallbackModels ?? [];
    this.allowedProviders = opts.allowedProviders ?? ["openai", "anthropic"];
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.polls = opts.generationPolls ?? 8;
    this.tokenCap = opts.tokenCap ?? RUN_TOKEN_CAP;
    this.spend =
      opts.ledger ??
      new SpendLedger({
        apiKey: opts.apiKey,
        path: defaultLedgerPath("openrouter.json"),
        capUsd: resolveBudgetUsd(process.env.INFERENCE_BUDGET_USD),
      });
  }

  private scrub(t: string): string {
    return redact(t, [this.apiKey]);
  }

  /** Single HTTP call with AbortController timeout. Never includes Authorization in errors. */
  private async http(
    path: string,
    init: RequestInit = {},
    auth = true,
  ): Promise<{ res: Response; latencyMs: number }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: {
          ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(init.headers as Record<string, string>),
        },
      });
      return { res, latencyMs: Date.now() - t0 };
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new ModelFailure(
        aborted ? "timeout" : "server_error",
        null,
        this.scrub(`request to ${path} failed: ${aborted ? "timeout" : (e as Error).name}`),
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      const { res } = await this.http("/models", {}, false);
      await res.arrayBuffer();
      return { ok: res.ok, detail: `GET /models -> ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  private async loadCatalog(): Promise<Map<string, CatalogModel>> {
    if (this.catalog) return this.catalog;
    let res: Response;
    try {
      res = (await this.http("/models", {}, false)).res;
    } catch (e) {
      throw new InferenceError("UPSTREAM_DEGRADED", (e as Error).message);
    }
    if (!res.ok) {
      await res.arrayBuffer();
      throw new InferenceError("UPSTREAM_DEGRADED", `GET /models -> ${res.status}`, res.status);
    }
    const rows =
      (
        (await res.json()) as {
          data?: Array<{
            id: string;
            supported_parameters?: string[];
            pricing?: {
              prompt?: string;
              completion?: string;
              overrides?: Array<{ prompt?: string; completion?: string }>;
            };
          }>;
        }
      ).data ?? [];
    const map = new Map<string, CatalogModel>();
    for (const m of rows) {
      const p = num(m.pricing?.prompt);
      const c = num(m.pricing?.completion);
      let pricing: CatalogModel["pricing"] = null;
      if (Number.isFinite(p) && Number.isFinite(c) && p >= 0 && c >= 0) {
        // worst case includes long-context override tiers
        let mp = p;
        let mc = c;
        for (const o of m.pricing?.overrides ?? []) {
          const op = num(o.prompt);
          const oc = num(o.completion);
          if (Number.isFinite(op)) mp = Math.max(mp, op);
          if (Number.isFinite(oc)) mc = Math.max(mc, oc);
        }
        pricing = { prompt: p, completion: c, maxPrompt: mp, maxCompletion: mc };
      }
      map.set(m.id, { id: m.id, supportedParameters: m.supported_parameters ?? [], pricing });
    }
    this.catalog = map;
    return map;
  }

  async listModels() {
    const cat = await this.loadCatalog();
    return [...cat.values()].map((m) => {
      const modes = ["text"];
      if (m.supportedParameters.includes("structured_outputs")) modes.push("json_schema");
      if (m.supportedParameters.includes("response_format")) modes.push("json_object");
      if (m.supportedParameters.includes("tools")) modes.push("tools");
      return { id: m.id, attestation: "unsupported" as const, outputModes: modes };
    });
  }

  /** Discovery/validation of a set of model IDs (A21 a). */
  async validateModels(ids: string[]): Promise<ModelValidation[]> {
    const cat = await this.loadCatalog();
    return ids.map((id) => {
      const m = cat.get(id);
      const so = !!m?.supportedParameters.includes("structured_outputs");
      const tools = !!m?.supportedParameters.includes("tools");
      return {
        id,
        listed: !!m,
        structuredOutputs: so,
        tools,
        supported: !!m && so && tools,
        pricing: m?.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : null,
      };
    });
  }

  /** Configured primary and fallbacks must support structured outputs and tools, else refuse before any call. */
  async assertConfiguredModelsSupported(): Promise<ModelValidation[]> {
    const ids = [...new Set([this.primaryModel, ...this.fallbackModels].filter((x): x is string => !!x))];
    if (ids.length === 0) throw new InferenceError("MODEL_UNSUPPORTED", "no OpenRouter models configured");
    const report = await this.validateModels(ids);
    const bad = report.filter((r) => !r.supported);
    if (bad.length > 0) {
      throw new InferenceError(
        "MODEL_UNSUPPORTED",
        `configured model(s) refused: ${bad
          .map(
            (b) =>
              `${b.id} (${!b.listed ? "not listed in /models" : `structured_outputs=${b.structuredOutputs}, tools=${b.tools}`})`,
          )
          .join("; ")}`,
      );
    }
    return report;
  }

  private async generationMeta(genId: string): Promise<GenerationMeta | null> {
    for (let i = 0; i < this.polls; i++) {
      try {
        const { res } = await this.http(`/generation?id=${encodeURIComponent(genId)}`);
        if (res.ok) return ((await res.json()) as { data?: GenerationMeta }).data ?? null;
        await res.arrayBuffer();
        if (res.status === 401 || res.status === 403) return null;
      } catch {
        /* transient: poll again */
      }
      await this.sleep(1000);
    }
    return null;
  }

  private providerAllowed(name: string | undefined): boolean {
    if (!name) return false;
    const n = norm(name);
    return this.allowedProviders.some((a) => norm(a) === n);
  }

  async generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    this.attempts.length = 0;
    // configured models must be capable before any call
    await this.assertConfiguredModelsSupported();
    const catalog = await this.loadCatalog();
    const primary = args.model || this.primaryModel!;
    const chain = [...new Set([primary, ...this.fallbackModels])];
    const jsonSchema = z.toJSONSchema(args.schema);
    let lastFailure: ModelFailure | InferenceError | null = null;

    for (const model of chain) {
      const entry = catalog.get(model);
      if (!entry) {
        // Unlisted model: no published pricing, so nothing can be sent. Treated as model-not-found (recoverable).
        this.attempts.push({
          model,
          try: 0,
          outcome: "model_not_found",
          httpStatus: null,
          latencyMs: 0,
          source: "catalog",
          detail: "model id not present in /models",
        });
        lastFailure = new ModelFailure("model_not_found", null, `${model} not found`, true);
        continue;
      }
      const sup = entry.supportedParameters;
      if (!sup.includes("structured_outputs") || !sup.includes("tools")) {
        throw new InferenceError(
          "MODEL_UNSUPPORTED",
          `${model} does not support structured outputs and tools`,
        );
      }
      try {
        const out = await validateWithRepair(args.schema, args.prompt, (prompt) =>
          this.askModel(model, entry, args, prompt, jsonSchema),
        ).then((r) => r);
        const meta = out.attempt.meta as {
          genId: string;
          provider: string;
          requestId: string | null;
          usage: { inputTokens: number; outputTokens: number };
          costUsd: number;
          generation: GenerationMeta;
          bodySha: string;
        };
        return {
          output: out.output,
          provider: this.id,
          model,
          requestId: meta.requestId,
          usage: meta.usage,
          evidence: {
            kind: "openrouter/v1",
            attestation: "none",
            modelRequested: primary,
            modelUsed: model,
            upstreamProvider: meta.provider,
            byok: true,
            generationId: meta.genId,
            generation: {
              is_byok: meta.generation.is_byok,
              provider_name: meta.generation.provider_name,
              total_cost: meta.generation.total_cost ?? null,
              upstream_inference_cost: meta.generation.upstream_inference_cost ?? null,
              latency: meta.generation.latency ?? null,
            },
            estimatedCostUsd: meta.costUsd,
            retryPolicy: { maxRetriesPerModel: 1, timeoutMs: this.timeoutMs, maxRepairs: 2 },
            attempts: structuredClone(this.attempts),
          },
          rawResponseSha256: meta.bodySha,
        };
      } catch (e) {
        if (e instanceof ModelFailure && e.recoverable) {
          lastFailure = e;
          continue;
        }
        if (e instanceof InferenceError && e.code === "SCHEMA_INVALID") {
          this.attempts.push({
            model,
            try: 0,
            outcome: "schema_invalid",
            httpStatus: null,
            latencyMs: 0,
            source: "http",
            detail: "output invalid after bounded repairs",
          });
          lastFailure = e;
          continue;
        }
        if (e instanceof ModelFailure) {
          throw this.toInferenceError(e);
        }
        throw e;
      }
    }
    if (lastFailure instanceof InferenceError) throw lastFailure;
    throw new InferenceError(
      "UPSTREAM_DEGRADED",
      this.scrub(
        `all models failed (${this.attempts.map((a) => `${a.model}:${a.outcome}`).join(", ")}): ${lastFailure?.message ?? "no models"}`,
      ),
    );
  }

  private toInferenceError(e: ModelFailure): InferenceError {
    const code =
      e.cls === "auth"
        ? "UPSTREAM_AUTH"
        : e.cls === "billing"
          ? "UPSTREAM_BILLING"
          : e.cls === "not_byok"
            ? "NOT_BYOK_SHARED_CAPACITY"
            : "UPSTREAM_DEGRADED";
    return new InferenceError(code, this.scrub(e.message), e.httpStatus ?? undefined);
  }

  /** One completion attempt (with at most one transient retry) against one model. */
  private async askModel(
    model: string,
    entry: CatalogModel,
    args: { system: string; maxTokens: number },
    prompt: string,
    jsonSchema: unknown,
  ) {
    const price = entry.pricing;
    if (!price)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `published pricing unavailable for ${model}; refusing to spend`,
      );
    const estIn = Math.ceil((args.system.length + prompt.length + JSON.stringify(jsonSchema).length) / 3);
    if (this.tokensUsed + estIn + args.maxTokens > this.tokenCap) {
      throw new InferenceError("BUDGET_EXCEEDED", `per-run token cap ${this.tokenCap} would be exceeded`);
    }
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: prompt },
      ],
      max_tokens: args.maxTokens,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: jsonSchema },
      },
      provider: { only: this.allowedProviders, allow_fallbacks: false, require_parameters: true },
    });
    let lastErr: ModelFailure | null = null;
    for (let t = 0; t <= 1; t++) {
      if (t > 0) await this.sleep(Math.round(500 + this.random() * 1000));
      // refuses with BUDGET_EXCEEDED before anything is sent
      const worst = estIn * price.maxPrompt + args.maxTokens * price.maxCompletion;
      const resId = await this.spend.reserve(model, worst);
      const t0 = Date.now();
      const info: Record<string, unknown> = { try: t };
      let chat: Chat | null = null;
      let httpStatus: number | null = null;
      let requestId: string | null = null;
      let rawBody: Buffer | null = null;
      let failure: ModelFailure | null = null;
      try {
        const { res, latencyMs } = await this.http("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        httpStatus = res.status;
        info.latencyMs = latencyMs;
        requestId = res.headers.get("x-request-id") ?? res.headers.get("x-generation-id");
        rawBody = Buffer.from(await res.arrayBuffer());
        try {
          chat = JSON.parse(rawBody.toString("utf8")) as Chat;
        } catch {
          chat = null;
        }
        if (!res.ok || chat?.error) {
          const c = classifyHttp(res.ok ? Number(chat?.error?.code ?? 502) : res.status, chat ?? undefined);
          failure = new ModelFailure(
            c.cls,
            res.status,
            `${model}: ${c.cls} (HTTP ${res.status}${chat?.error?.message ? `: ${chat.error.message.slice(0, 160)}` : ""})`,
            c.recoverable,
          );
        } else if (!chat?.choices?.[0]?.message?.content) {
          failure = new ModelFailure("empty_completion", res.status, `${model}: empty completion`, true);
        }
      } catch (e) {
        failure = e as ModelFailure;
        info.latencyMs = Date.now() - t0;
      }

      if (failure) {
        info.httpStatus = httpStatus;
        info.errorClass = failure.cls;
        this.attempts.push({
          model,
          try: t,
          outcome: failure.cls,
          httpStatus,
          latencyMs: Number(info.latencyMs ?? 0),
          source: "http",
          detail: this.scrub(failure.message).slice(0, 200),
        });
        // pre-processing rejections cost nothing; transport errors / 5xx keep the worst-case reservation charged
        if (httpStatus !== null && httpStatus < 500 && failure.cls !== "empty_completion")
          await this.spend.release(resId, { model, ...info });
        else if (failure.cls === "empty_completion" && chat?.usage) {
          // billed but unusable: settle actual
          const u = this.usageOf(chat, price);
          this.tokensUsed += u.inputTokens + u.outputTokens;
          this.usdSpentThisRun += u.usd;
          await this.spend.settle(resId, { ...u, requestId }, { model, ...info });
        } else
          await this.spend.settle(
            resId,
            { usd: worst, inputTokens: estIn, outputTokens: args.maxTokens, requestId },
            { model, ...info, charged: "worst_case" },
          );
        if (!failure.recoverable) throw failure;
        // retry only transient classes
        if (
          ["rate_limited", "server_error", "timeout", "provider_unavailable"].includes(failure.cls) &&
          t === 0
        ) {
          lastErr = failure;
          continue;
        }
        throw failure;
      }

      // success path: usage, then generation metadata for the BYOK check
      const u = this.usageOf(chat!, price);
      this.tokensUsed += u.inputTokens + u.outputTokens;
      this.usdSpentThisRun += u.usd;
      const genId = chat!.id ?? "";
      const gen = genId ? await this.generationMeta(genId) : null;
      info.httpStatus = httpStatus;
      info.generationId = genId;
      info.upstreamProvider = gen?.provider_name ?? chat!.provider ?? null;
      info.byok = gen?.is_byok ?? null;
      const record = (outcome: FailureClass, detail?: string) =>
        this.attempts.push({
          model,
          try: t,
          outcome,
          httpStatus,
          latencyMs: Number(info.latencyMs ?? 0),
          source: "http",
          detail,
        });
      if (!gen) {
        info.errorClass = "metadata_unavailable";
        await this.spend.settle(resId, { ...u, requestId }, { model, ...info });
        record("metadata_unavailable", "generation metadata unavailable; BYOK not provable");
        throw new ModelFailure(
          "metadata_unavailable",
          httpStatus,
          `${model}: generation metadata unavailable; BYOK cannot be verified`,
          false,
        );
      }
      if (gen.is_byok !== true || !this.providerAllowed(gen.provider_name)) {
        info.errorClass = "not_byok";
        await this.spend.settle(
          resId,
          { ...u, usd: Math.max(u.usd, gen.total_cost ?? 0), requestId },
          { model, ...info },
        );
        record("not_byok", `is_byok=${String(gen.is_byok)} provider=${gen.provider_name ?? "unknown"}`);
        throw new ModelFailure(
          "not_byok",
          httpStatus,
          `NOT_BYOK_SHARED_CAPACITY: ${model} was served with is_byok=${String(gen.is_byok)} by ${gen.provider_name ?? "unknown"}; output discarded`,
          false,
        );
      }
      await this.spend.settle(resId, { ...u, requestId }, { model, ...info });
      record("ok");
      return {
        text: chat!.choices![0]!.message!.content!,
        meta: {
          genId,
          provider: gen.provider_name!,
          requestId,
          usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens },
          costUsd: u.usd,
          generation: gen,
          bodySha: sha256Hex(rawBody!),
        },
      };
    }
    throw lastErr!;
  }

  /** Estimated cost: upstream inference cost (BYOK) or tokens x published price, plus OpenRouter's own fee (`cost`). */
  private usageOf(chat: Chat, price: NonNullable<CatalogModel["pricing"]>) {
    const inputTokens = chat.usage?.prompt_tokens ?? 0;
    const outputTokens = chat.usage?.completion_tokens ?? 0;
    const computed = inputTokens * price.prompt + outputTokens * price.completion;
    const upstream = chat.usage?.cost_details?.upstream_inference_cost;
    const fee = typeof chat.usage?.cost === "number" ? chat.usage.cost : 0;
    const base = typeof upstream === "number" && upstream > 0 ? Math.max(upstream, computed) : computed;
    return { inputTokens, outputTokens, usd: base + fee };
  }

  async *streamText(args: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
  }): AsyncIterable<string> {
    const catalog = await this.loadCatalog();
    const model = args.model || this.primaryModel!;
    const entry = catalog.get(model);
    if (!entry?.pricing)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `published pricing unavailable for ${model}; refusing to spend`,
      );
    const estIn = Math.ceil((args.system.length + args.prompt.length) / 3);
    if (this.tokensUsed + estIn + args.maxTokens > this.tokenCap)
      throw new InferenceError("BUDGET_EXCEEDED", "per-run token cap would be exceeded");
    const worst = estIn * entry.pricing.maxPrompt + args.maxTokens * entry.pricing.maxCompletion;
    const resId = await this.spend.reserve(model, worst);
    let res: Response;
    try {
      ({ res } = await this.http("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: args.maxTokens,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.prompt },
          ],
          provider: { only: this.allowedProviders, allow_fallbacks: false },
        }),
      }));
    } catch (e) {
      await this.spend.settle(
        resId,
        { usd: worst, inputTokens: estIn, outputTokens: args.maxTokens, requestId: null },
        { errorClass: "transport" },
      );
      throw this.toInferenceError(e as ModelFailure);
    }
    if (!res.ok || !res.body) {
      await res.arrayBuffer().catch(() => undefined);
      await this.spend.release(resId, { httpStatus: res.status });
      const c = classifyHttp(res.status);
      throw this.toInferenceError(
        new ModelFailure(c.cls, res.status, `stream ${model}: ${c.cls} (HTTP ${res.status})`, c.recoverable),
      );
    }
    let genId = "";
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { id?: string; choices?: Array<{ delta?: { content?: string } }> };
          if (j.id) genId = j.id;
          const d = j.choices?.[0]?.delta?.content;
          if (d) yield d;
        } catch {
          /* ignore keep-alive */
        }
      }
    }
    this.tokensUsed += args.maxTokens;
    const gen = genId ? await this.generationMeta(genId) : null;
    const usd = Math.max(
      gen?.total_cost ?? 0,
      estIn * entry.pricing.prompt + args.maxTokens * entry.pricing.completion,
    );
    this.usdSpentThisRun += usd;
    await this.spend.settle(
      resId,
      {
        usd,
        inputTokens: gen?.tokens_prompt ?? estIn,
        outputTokens: gen?.tokens_completion ?? args.maxTokens,
        requestId: genId || null,
      },
      { model, byok: gen?.is_byok ?? null, upstreamProvider: gen?.provider_name ?? null },
    );
    if (!gen || gen.is_byok !== true || !this.providerAllowed(gen.provider_name)) {
      throw new InferenceError(
        "NOT_BYOK_SHARED_CAPACITY",
        `stream ${model}: BYOK not confirmed by generation metadata`,
      );
    }
  }

  async verifyResponse(): Promise<VerificationResult> {
    return { verified: false, status: "unsupported", checks: [], reason: "PROVIDER_HAS_NO_ATTESTATION" };
  }
}
