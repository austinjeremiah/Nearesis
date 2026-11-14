import type { z } from "zod";
import { InferenceError } from "./errors.ts";

export const MAX_REPAIR_ATTEMPTS = 2;

export interface RawAttempt {
  text: string;
  meta: unknown;
}

/**
 * Validate model output with zod. On failure re-ask the model (never editing values ourselves) at most
 * MAX_REPAIR_ATTEMPTS times (ch.27), then throw SCHEMA_INVALID.
 */
export async function validateWithRepair<T>(
  schema: z.ZodType<T>,
  prompt: string,
  ask: (prompt: string, attempt: number) => Promise<RawAttempt>,
): Promise<{ output: T; attempt: RawAttempt; attempts: number }> {
  let currentPrompt = prompt;
  let lastIssue = "unknown";
  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const raw = await ask(currentPrompt, attempt);
    let parsedJson: unknown;
    let issue: string | null = null;
    try {
      parsedJson = JSON.parse(raw.text);
    } catch {
      issue = "output was not valid JSON";
    }
    if (issue === null) {
      const r = schema.safeParse(parsedJson);
      if (r.success) return { output: r.data, attempt: raw, attempts: attempt + 1 };
      issue = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
    lastIssue = issue;
    currentPrompt = `${prompt}\n\nYour previous reply was rejected by schema validation (${issue}). Reply again with only JSON that satisfies the schema.`;
  }
  throw new InferenceError(
    "SCHEMA_INVALID",
    `output failed schema validation after ${MAX_REPAIR_ATTEMPTS} repair attempts: ${lastIssue}`,
  );
}
