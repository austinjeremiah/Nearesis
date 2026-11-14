import { z } from "zod";
import { AttestationClient, type ModelAttestation } from "@nearai/inference-sdk";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { InferenceError, redact } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { loadDefaultPolicy } from "./policy.ts";
import { SpendLedger } from "./spend.ts";
import { validateWithRepair } from "./structured.ts";
import {
  verifyNearAiResult,
  verifyPreflight,
  type PreflightSummary,
  type NearAiEvidence,
  type NearAiVerificationPolicy,
  type VerifyDeps,
} from "./near-verify.ts";

export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";

export interface NearAiOptions {
  apiKey: string;
  baseUrl?: string;
  policy?: Partial<NearAiVerificationPolicy>;
  /** Total tokens (input est. + max output) this provider instance may spend. Default 20000. */
  tokenBudget?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  verifyDeps?: VerifyDeps;
  /** Cumulative USD ledger. Defaults to .data/spend/near-ai.json with a 5.00 USD cap (NEAR_AI_BUDGET_USD can lower it). */
  ledger?: SpendLedger;
  /** Override published pricing (USD per token), mainly for tests. */
  pricing?: (model: string) => Promise<{ input: number; output: number } | null>;
}

export interface ModelDiscovery {
  id: string;
  providerType: string | null;
  attestationSupported: boolean;
  /** "near-tdx-dstack" = NEAR-operated report that this adapter verifies; "other-tee" = different evidence format. */
  proofType: "near-tdx-dstack" | "other-tee" | "none";
  attestation: "supported" | "unsupported" | "unknown";
  outputModes: string[];
  pricing: { prompt: string | null; completion: string | null };
}

interface ModelRow {
  id: string;
  supported_features?: string[];
  pricing?: { prompt?: string; completion?: string };
}

export class NearAiProvider implements InferenceProvider {
  readonly id = "near-ai";
  readonly policy: NearAiVerificationPolicy;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly verifyDeps: VerifyDeps;
  private readonly tokenBudget: number;
  private tokensSpent = 0;
  private readonly spend: SpendLedger;
  private readonly pricingOverride?: NearAiOptions["pricing"];
  private readonly priceCache = new Map<string, { input: number; output: number }>();
  usdSpentThisRun = 0;
  readonly ledger: Array<{
    requestId: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    usd?: number;
  }> = [];

  constructor(opts: NearAiOptions) {
    if (!opts.apiKey) throw new InferenceError("UPSTREAM_DEGRADED", "NEAR_AI_API_KEY not provided");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.verifyDeps = opts.verifyDeps ?? {};
    this.tokenBudget = opts.tokenBudget ?? 20_000;
    this.spend = opts.ledger ?? new SpendLedger({ apiKey: opts.apiKey });
    this.pricingOverride = opts.pricing;
    this.policy = { ...loadDefaultPolicy(), ...opts.policy };
  }

  budgetRemainingUsd(): Promise<number> {
    return this.spend.remainingUsd();
  }

  /** Published per-token USD pricing for a model; null if unavailable (callers must then refuse). */
  async modelPricing(model: string): Promise<{ input: number; output: number } | null> {
    if (this.pricingOverride) return this.pricingOverride(model);
    const hit = this.priceCache.get(model);
    if (hit) return hit;
    let price: { input: number; output: number } | null = null;
    try {
      const r = await this.http(`/model/${encodeURIComponent(model)}`);
      if (r.ok) {
        const j = (await r.json()) as {
          inputCostPerToken?: { amount?: number; scale?: number };
          outputCostPerToken?: { amount?: number; scale?: number };
        };
        const f = (c?: { amount?: number; scale?: number }) =>
          c && typeof c.amount === "number" && typeof c.scale === "number" ? c.amount / 10 ** c.scale : NaN;
        const input = f(j.inputCostPerToken);
        const output = f(j.outputCostPerToken);
        if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0)
          price = { input, output };
      } else await r.arrayBuffer();
    } catch {
      price = null;
    }
    if (price) this.priceCache.set(model, price);
    return price;
  }

  /** Worst case = estimated input tokens x input price + max_tokens x output price. Refuses on unknown pricing. */
  private async reserveBudget(model: string, estInputTokens: number, maxTokens: number) {
    const price = await this.modelPricing(model);
    if (!price)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `published pricing unavailable for ${model}; refusing to spend`,
      );
    const worst = estInputTokens * price.input + maxTokens * price.output;
    const id = await this.spend.reserve(model, worst);
    return { id, price };
  }

  /** Refuse early (before any other network traffic) when the worst case cannot fit; reservation happens just before sending. */
  private async precheckBudget(model: string, estInputTokens: number, maxTokens: number): Promise<void> {
    const price = await this.modelPricing(model);
    if (!price)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `published pricing unavailable for ${model}; refusing to spend`,
      );
    const worst = estInputTokens * price.input + maxTokens * price.output;
    const remaining = await this.spend.remainingUsd();
    if (worst > remaining + 1e-12) {
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `worst-case cost USD ${worst.toFixed(6)} exceeds remaining budget USD ${remaining.toFixed(6)}`,
      );
    }
  }

  get tokensUsed(): number {
    return this.tokensSpent;
  }

  private async http(path: string, init: RequestInit = {}): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers as Record<string, string>) },
      });
    } catch (e) {
      throw new InferenceError(
        "UPSTREAM_DEGRADED",
        redact(`request to ${path} failed: ${(e as Error).name}`, [this.apiKey]),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      const r = await this.http("/models");
      await r.arrayBuffer();
      return { ok: r.ok, detail: `GET /models -> ${r.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** Discovery report: model, proof type, output modes (A16 a). */
  async discover(): Promise<ModelDiscovery[]> {
    const r = await this.http("/models");
    if (!r.ok) throw new InferenceError("UPSTREAM_DEGRADED", `GET /models -> ${r.status}`, r.status);
    const rows = ((await r.json()) as { data?: ModelRow[] }).data ?? [];
    const out: ModelDiscovery[] = [];
    for (const m of rows) {
      let providerType: string | null = null;
      let supported = false;
      const mr = await this.http(`/model/${encodeURIComponent(m.id)}`);
      if (mr.ok) {
        const md = (
          (await mr.json()) as { metadata?: { providerType?: string; attestationSupported?: boolean } }
        ).metadata;
        providerType = md?.providerType ?? null;
        supported = md?.attestationSupported === true;
      } else await mr.arrayBuffer();
      const feats = m.supported_features ?? [];
      const outputModes = ["text"];
      if (feats.includes("structured_outputs")) outputModes.push("json_schema");
      if (feats.includes("json_mode")) outputModes.push("json_object");
      if (feats.includes("tools")) outputModes.push("tools");
      const near = supported && providerType === "vllm";
      out.push({
        id: m.id,
        providerType,
        attestationSupported: supported,
        proofType: near ? "near-tdx-dstack" : supported ? "other-tee" : "none",
        attestation: near ? "supported" : supported ? "unknown" : "unsupported",
        outputModes,
        pricing: { prompt: m.pricing?.prompt ?? null, completion: m.pricing?.completion ?? null },
      });
    }
    return out;
  }

  async listModels() {
    return (await this.discover()).map((d) => ({
      id: d.id,
      attestation: d.attestation,
      outputModes: d.outputModes,
    }));
  }

  private charge(inputTokens: number, outputTokens: number, requestId: string | null, model: string) {
    this.tokensSpent += inputTokens + outputTokens;
    this.ledger.push({ requestId, model, inputTokens, outputTokens });
  }

  async generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(args.schema);
    const client = new AttestationClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    let lastEvidence: NearAiEvidence | null = null;
    let lastMeta: {
      requestId: string | null;
      usage: { inputTokens: number; outputTokens: number };
      bodySha: string;
    } | null = null;

    const { output } = await validateWithRepair(args.schema, args.prompt, async (prompt) => {
      const estIn = Math.ceil((args.system.length + prompt.length + JSON.stringify(jsonSchema).length) / 3);
      if (this.tokensSpent + estIn + args.maxTokens > this.tokenBudget) {
        throw new InferenceError("BUDGET_EXCEEDED", `token budget ${this.tokenBudget} would be exceeded`);
      }
      await this.precheckBudget(args.model, estIn, args.maxTokens);
      // 1. preflight attestation (fresh client nonce) strictly before the completion
      const fetchedAtMs = Date.now();
      let fetched;
      try {
        fetched = await client.fetchModelAttestations({ model: args.model, signingAlgo: "ecdsa" });
      } catch (e) {
        throw new InferenceError(
          "UPSTREAM_DEGRADED",
          redact(`attestation fetch failed: ${(e as Error).name}`, [this.apiKey]),
        );
      }
      // 2. completion with exact request bytes retained
      const requestBody = Buffer.from(
        JSON.stringify({
          model: args.model,
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
        }),
        "utf8",
      );
      const reservation = await this.reserveBudget(args.model, estIn, args.maxTokens);
      const atMs = Date.now();
      // a transport failure keeps the worst-case reservation charged (cost unknown)
      const r = await this.http("/chat/completions", {
        method: "POST",
        body: requestBody,
        headers: {
          "Content-Type": "application/json",
          "x-no-aliasing": "true",
          "Accept-Encoding": "identity",
        },
      });
      const responseBody = Buffer.from(await r.arrayBuffer());
      const requestId = r.headers.get("x-request-id");
      if (!r.ok) {
        if ([400, 401, 402, 403, 404, 422, 429].includes(r.status)) await this.spend.release(reservation.id);
        throw new InferenceError(
          "UPSTREAM_DEGRADED",
          redact(`chat/completions -> ${r.status} (request ${requestId ?? "n/a"})`, [this.apiKey]),
          r.status,
        );
      }
      let parsed: {
        id?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw new InferenceError("UPSTREAM_DEGRADED", "completion response was not JSON");
      }
      const usage = {
        inputTokens: parsed.usage?.prompt_tokens ?? estIn,
        outputTokens: parsed.usage?.completion_tokens ?? args.maxTokens,
      };
      this.charge(usage.inputTokens, usage.outputTokens, requestId, args.model);
      const usd = usage.inputTokens * reservation.price.input + usage.outputTokens * reservation.price.output;
      this.usdSpentThisRun += usd;
      await this.spend.settle(reservation.id, { usd, ...usage, requestId });
      this.ledger[this.ledger.length - 1]!.usd = usd;
      // 3. signature over the exact bytes (bounded retry: it may be recorded shortly after the response)
      let signature = null;
      if (parsed.id) {
        for (let i = 0; i < 6 && !signature; i++) {
          try {
            signature = await client.fetchCompletionSignature({
              completionId: parsed.id,
              signingAlgo: "ecdsa",
            });
          } catch {
            await new Promise((res) => setTimeout(res, 1000));
          }
        }
      }
      lastEvidence = {
        kind: "near-ai/v1",
        model: args.model,
        nonce: fetched.clientBinding.nonce,
        signingAlgo: "ecdsa",
        preflight: { fetchedAtMs, attestations: fetched.attestations as ModelAttestation[] },
        completion: {
          completionId: parsed.id ?? "",
          atMs,
          requestBodyB64: requestBody.toString("base64"),
          responseBodyB64: responseBody.toString("base64"),
        },
        signature,
      };
      lastMeta = { requestId, usage, bodySha: sha256Hex(responseBody) };
      return { text: parsed.choices?.[0]?.message?.content ?? "", meta: null };
    });

    const m = lastMeta!;
    return {
      output,
      provider: this.id,
      model: args.model,
      requestId: m.requestId,
      usage: m.usage,
      evidence: lastEvidence,
      rawResponseSha256: m.bodySha,
    };
  }

  async *streamText(args: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
  }): AsyncIterable<string> {
    if (this.tokensSpent + args.maxTokens + 1000 > this.tokenBudget) {
      throw new InferenceError("BUDGET_EXCEEDED", `token budget ${this.tokenBudget} would be exceeded`);
    }
    const estIn = Math.ceil((args.system.length + args.prompt.length) / 3);
    const reservation = await this.reserveBudget(args.model, estIn, args.maxTokens);
    const r = await this.http("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        stream: true,
        max_tokens: args.maxTokens,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
      }),
    });
    if (!r.ok || !r.body) {
      if ([400, 401, 402, 403, 404, 422, 429].includes(r.status)) await this.spend.release(reservation.id);
      throw new InferenceError("UPSTREAM_DEGRADED", `stream -> ${r.status}`, r.status);
    }
    // conservative: streamed usage is not reported, so charge the worst case (already reserved) at the cap
    this.tokensSpent += args.maxTokens;
    this.usdSpentThisRun += reservation.price.input * estIn + reservation.price.output * args.maxTokens;
    await this.spend.settle(reservation.id, {
      usd: reservation.price.input * estIn + reservation.price.output * args.maxTokens,
      inputTokens: estIn,
      outputTokens: args.maxTokens,
      requestId: r.headers.get("x-request-id"),
    });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
            .choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* ignore malformed keep-alive lines */
        }
      }
    }
  }

  /**
   * Fetch and genuinely verify (Intel DCAP quote, nonce/signer binding, RTMR3 replay, MRCONFIGID, NVIDIA GPU) the
   * model attestation for `model` without sending a completion. Used for discovery and as supplementary evidence only:
   * it never yields verified status for any response.
   */
  async preflight(model: string): Promise<PreflightSummary[]> {
    const client = new AttestationClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    const fetched = await client.fetchModelAttestations({ model, signingAlgo: "ecdsa" });
    return verifyPreflight(
      fetched.attestations as ModelAttestation[],
      fetched.clientBinding.nonce,
      this.policy,
      this.verifyDeps,
    );
  }

  verifyResponse(
    result: StructuredResult<unknown>,
    opts: { mode?: "development" | "production" } = {},
  ): Promise<VerificationResult> {
    return verifyNearAiResult(result, this.policy, this.verifyDeps, opts.mode);
  }
}
