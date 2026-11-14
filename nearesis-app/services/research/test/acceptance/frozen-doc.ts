import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DOC_PATH = resolve(APP_ROOT, "docs/research/PREREGISTRATION.md");
export const FREEZE_PATH = resolve(APP_ROOT, "docs/research/PREREGISTRATION.freeze.json");

/** Independent canonical hash: CRLF and lone CR to LF, Unicode NFC, UTF-8, trailing whitespace preserved. */
export function canonicalHash(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").normalize("NFC");
  return "sha256:" + createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the frozen block is an open JSON document read by path
export function loadFrozenDoc(): { text: string; params: any; hash: string; freeze: any } {
  const text = readFileSync(DOC_PATH, "utf8");
  const m = text.match(
    /<!-- frozen-parameters:begin -->\s*```json\n([\s\S]*?)\n```\s*<!-- frozen-parameters:end -->/,
  );
  if (!m) throw new Error("frozen-parameters block not found");
  return {
    text,
    params: JSON.parse(m[1] as string),
    hash: canonicalHash(text),
    freeze: JSON.parse(readFileSync(FREEZE_PATH, "utf8")),
  };
}

/** The document on disk is the frozen one, and Python used exactly that document (independent check in TypeScript). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- measurement JSON from the Python case
export function frozenChecks(m: any) {
  const d = loadFrozenDoc();
  return {
    docMatchesFreezeRecord: d.hash === d.freeze.documentHash,
    pythonUsedThisDocument: m.frozen.documentHash === d.hash,
    intact: m.frozen.intact === true,
    freezePrecedesFirstResult: m.frozen.firstResultAt === null || d.freeze.frozenAt <= m.frozen.firstResultAt,
    params: d.params,
  };
}
