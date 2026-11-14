import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterProvider, SpendLedger } from "../../src/index.ts";

export const KEY = "sk-or-v1-TESTSECRET0123456789";

export interface Scripted {
  status?: number;
  body?: unknown;
  throwAbort?: boolean;
  /** model-specific content */
  content?: string;
  usage?: Record<string, unknown>;
}

export interface Fake {
  fetch: typeof fetch;
  calls: Array<{ path: string; body?: Record<string, unknown>; headers: Record<string, string> }>;
  /** per-model queue of scripted chat responses; last one repeats */
  chat: Record<string, Scripted[]>;
  generation: (id: string, model: string) => { status?: number; data?: Record<string, unknown> };
}

export const catalog = [
  {
    id: "openai/primary",
    supported_parameters: ["structured_outputs", "tools", "response_format"],
    pricing: { prompt: "0.000001", completion: "0.000004" },
  },
  {
    id: "anthropic/fallback",
    supported_parameters: ["structured_outputs", "tools", "response_format"],
    pricing: { prompt: "0.000002", completion: "0.00001" },
  },
  {
    id: "openai/no-tools",
    supported_parameters: ["structured_outputs", "response_format"],
    pricing: { prompt: "0.000001", completion: "0.000001" },
  },
  { id: "openai/no-price", supported_parameters: ["structured_outputs", "tools"], pricing: {} },
];

export function makeFake(): Fake {
  const calls: Fake["calls"] = [];
  const chat: Fake["chat"] = {};
  let n = 0;
  const idModel = new Map<string, string>();
  const fake: Fake = {
    calls,
    chat,
    generation: (_id, model) => ({
      data: {
        id: _id,
        is_byok: true,
        provider_name: model.startsWith("anthropic") ? "Anthropic" : "OpenAI",
        total_cost: 0.0001,
        upstream_inference_cost: 0.0009,
        latency: 400,
      },
    }),
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, "") + url.search;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (path === "/models") return new Response(JSON.stringify({ data: catalog }));
      if (path.startsWith("/generation")) {
        const id = url.searchParams.get("id")!;
        const g = fake.generation(id, idModel.get(id) ?? "openai/primary");
        return new Response(JSON.stringify({ data: g.data }), { status: g.status ?? 200 });
      }
      if (path === "/chat/completions") {
        const model = String(body!.model);
        const q = chat[model] ?? [{}];
        const s = q.length > 1 ? q.shift()! : q[0]!;
        if (s.throwAbort) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        if (s.status && s.status !== 200)
          return new Response(JSON.stringify(s.body ?? { error: { code: s.status, message: "err" } }), {
            status: s.status,
          });
        const id = `gen-${++n}`;
        idModel.set(id, model);
        return new Response(
          JSON.stringify(
            s.body ?? {
              id,
              provider: "OpenAI",
              model,
              choices: [
                {
                  message: {
                    content: s.content ?? JSON.stringify({ city: "Atlantis", population_millions: 1.5 }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 50,
                completion_tokens: 20,
                cost: 0.00001,
                cost_details: { upstream_inference_cost: 0.0004 },
                ...s.usage,
              },
            },
          ),
          { headers: { "x-request-id": `req-${n}` } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}

export function makeProvider(
  fake: Fake,
  over: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {},
) {
  const path = join(mkdtempSync(join(tmpdir(), "or-spend-")), "openrouter.json");
  const ledger = new SpendLedger({ apiKey: KEY, path });
  const provider = new OpenRouterProvider({
    apiKey: KEY,
    primaryModel: "openai/primary",
    fallbackModels: ["anthropic/fallback"],
    allowedProviders: ["openai", "anthropic"],
    ledger,
    fetch: fake.fetch,
    sleep: async () => {},
    random: () => 0,
    generationPolls: 2,
    ...over,
  });
  return { provider, ledger };
}
