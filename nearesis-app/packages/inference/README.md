# @nearesis/inference

Implements `InferenceProvider` (`@nearesis/contracts`). Providers: `MockInferenceProvider` (deterministic, `unattested_dev`), `OpenRouterProvider` (live, BYOK, unattested), `NearAiProvider` (attested, disabled by default). `assertPublishable` is fail-closed: only a genuinely `verified` result can be published, so OpenRouter output never can.

## Configuration (root `.env`, server-side only; never printed)

| Variable                                                 | Meaning                                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INFERENCE_PROVIDER`                                     | `openrouter` / `mock` / `near-ai`. Default: `openrouter` if `OPENROUTER_API_KEY` is set, else `mock`. `near-ai` only when set explicitly.                   |
| `OPENROUTER_API_KEY`                                     | OpenRouter key                                                                                                                                              |
| `OPENROUTER_PRIMARY_MODEL`, `OPENROUTER_FALLBACK_MODELS` | model ids (comma-separated fallbacks); each must list `structured_outputs` and `tools` in `/models` `supported_parameters` or it is refused before any call |
| `OPENROUTER_ALLOWED_PROVIDERS`                           | default `openai,anthropic` (sent as `provider.only` with `allow_fallbacks:false`)                                                                           |
| `INFERENCE_BUDGET_USD`                                   | can only lower the hard USD 5.00 cumulative cap (ledger `.data/spend/openrouter.json`, keyed by key hash). Per-run cap 20k tokens.                          |

## BYOK setup (OpenRouter dashboard)

1. Settings, Integrations (BYOK): add your OpenAI and Anthropic API keys.
2. Optionally enable "always use this key" (`is_byok_only`) on each so shared capacity is never used.
3. Keep a small credit balance: BYOK adds a ~5% OpenRouter fee. The adapter never buys credits or changes settings.
4. Every response is checked via `GET /generation?id=` and rejected (`NOT_BYOK_SHARED_CAPACITY`) unless `is_byok` is true and the provider is allowed.

## Commands

- Unit tests: `pnpm --filter @nearesis/inference test`
- A15 / A08 (offline): `pnpm accept --id A15 --session A5`, `pnpm accept --id A08 --session A5`
- Live A21: `pnpm accept --id A21 --live --session A5`
- A16 (NEAR AI, historical, disabled) must never be passed from OpenRouter output.
