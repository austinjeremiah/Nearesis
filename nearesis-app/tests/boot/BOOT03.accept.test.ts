import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "@nearesis/acceptance";
import { expect, it } from "vitest";
import {
  REGISTER_PATH,
  auditUrls,
  loadRegister,
  validateRegister,
} from "../../scripts/security/url-audit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

it("BOOT03: all production integration URLs have a documented doc or source", () => {
  const entries = loadRegister(REGISTER_PATH);
  expect(validateRegister(entries)).toEqual([]);
  for (const e of entries) {
    expect(e.officialDocUrl, e.id).toMatch(/^https:\/\//);
    expect(e.accessedAt, e.id).toMatch(/^\d{4}-\d{2}-\d{2}/);
  }
  const { undocumented, scanned } = auditUrls(repoRoot, entries);
  expect(undocumented.map((u) => `${u.host} ${u.file}:${u.line}`)).toEqual([]);
  const verified = entries.filter((e) => e.status === "VERIFIED").length;
  observe({
    testId: "BOOT03",
    observed: `${entries.length} register entries (${verified} VERIFIED, ${entries.length - verified} TO_VERIFY) schema-valid; ${scanned} tracked source files scanned; 0 undocumented hosts`,
    fixtureHash: createHash("sha256").update(readFileSync(REGISTER_PATH)).digest("hex"),
    evidence: { entries: entries.length, verified, scanned, undocumented: 0 },
  });
});
