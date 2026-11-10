/**
 * URL/source-register auditor (BOOT03). Extracts http(s) host literals from git-tracked source files and
 * requires every host to be listed in a source-register entry's `hosts`. localhost / 127.0.0.1 are allowed.
 * Exit code 1 when undocumented hosts exist.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface RegisterEntry {
  id: string;
  hosts: string[];
  officialDocUrl: string;
  accessedAt: string;
  version: string;
  auth: string;
  rateLimits: string;
  status: "TO_VERIFY" | "VERIFIED";
  notes: string;
}

const SRC_EXT = /\.(ts|tsx|js|py|sql|yaml|yml)$/;
const EXCLUDES: RegExp[] = [
  /(^|\/)test\//,
  /\.test\.ts$/,
  /(^|\/)docs\//,
  /(^|\/)generated\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)services\/outlayer-verifier\//,
  /(^|\/)tools\//,
  /(^|\/)NEARESIS_Build_Bible\//,
  /(^|\/)tests\/python\//,
];
const ALWAYS_ALLOWED = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const URL_RE = /https?:\/\/([A-Za-z0-9.-]+|\[[0-9a-f:]+\])/gi;

export function loadRegister(path: string): RegisterEntry[] {
  const doc = parse(readFileSync(path, "utf8")) as { sources?: RegisterEntry[] };
  if (!doc || !Array.isArray(doc.sources)) throw new Error("source register must have a `sources` list");
  return doc.sources;
}

export function validateRegister(entries: RegisterEntry[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    const tag = e.id ?? "<no id>";
    if (!e.id || ids.has(e.id)) errs.push(`${tag}: missing or duplicate id`);
    ids.add(e.id);
    if (!Array.isArray(e.hosts)) errs.push(`${tag}: hosts must be a list`);
    for (const k of ["officialDocUrl", "accessedAt", "version", "auth", "rateLimits", "notes"] as const) {
      if (typeof e[k] !== "string" || !e[k]) errs.push(`${tag}: ${k} must be a non-empty string`);
    }
    if (e.status !== "TO_VERIFY" && e.status !== "VERIFIED") errs.push(`${tag}: invalid status`);
    if (typeof e.officialDocUrl === "string" && !/^https:\/\//.test(e.officialDocUrl))
      errs.push(`${tag}: officialDocUrl must be https`);
  }
  return errs;
}

export interface UrlHit {
  host: string;
  file: string;
  line: number;
}

export function auditUrls(
  repoRoot: string,
  entries: RegisterEntry[],
): { undocumented: UrlHit[]; scanned: number } {
  const known = new Set(entries.flatMap((e) => e.hosts.map((h) => h.toLowerCase())));
  const ls = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 1 << 28 });
  if (ls.status !== 0) throw new Error("git ls-files failed");
  const files = ls.stdout.toString("utf8").split("\0").filter(Boolean);
  const undocumented: UrlHit[] = [];
  let scanned = 0;
  for (const file of files) {
    if (!SRC_EXT.test(file) || EXCLUDES.some((r) => r.test(file))) continue;
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue;
    scanned++;
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.matchAll(URL_RE)) {
          const host = m[1]!.toLowerCase().replace(/\.$/, "");
          if (ALWAYS_ALLOWED.has(host) || known.has(host)) continue;
          undocumented.push({ host, file, line: i + 1 });
        }
      });
  }
  return { undocumented, scanned };
}

const here = dirname(fileURLToPath(import.meta.url));
export const REGISTER_PATH = resolve(here, "..", "..", "docs", "refs", "source-register.yaml");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = loadRegister(REGISTER_PATH);
  const errs = validateRegister(entries);
  const { undocumented, scanned } = auditUrls(resolve(here, "..", "..", ".."), entries);
  for (const e of errs) console.error(`REGISTER ${e}`);
  for (const u of undocumented) console.error(`UNDOCUMENTED ${u.host} ${u.file}:${u.line}`);
  if (errs.length || undocumented.length) process.exit(1);
  console.log(
    `url-audit: ${scanned} files scanned, ${entries.length} register entries, 0 undocumented hosts`,
  );
}
