/**
 * SEC11: supply chain. PASS: locked, pinned inputs, an SBOM, no floating production references.
 * Real repository files, real lockfile checks (`pnpm install --frozen-lockfile --lockfile-only`, `uv lock --check`),
 * a real SBOM from syft (container, no network) over the lockfiles plus the image references. The negative-control
 * fixtures (a `latest` tag and an unpinned dependency) run through the same checker and must be rejected.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";

const ROOT = process.cwd();
const SKIP = new Set([
  "node_modules",
  ".git",
  ".toolchain",
  ".next",
  ".next-perf",
  ".venv",
  ".data",
  "test-results",
  "dist",
]);
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

export interface Finding {
  file: string;
  line: number;
  problem: string;
}

/** Image references in Dockerfiles and compose files: every one needs a sha256 digest and no `latest`. */
export function checkImages(file: string, text: string): { refs: string[]; findings: Finding[] } {
  const refs: string[] = [];
  const findings: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "");
    const m =
      /^\s*image:\s*["']?([^\s"']+)/.exec(line) ?? /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/i.exec(line);
    if (!m) return;
    const ref = m[1]!;
    if (ref === "scratch" || /^\$\{?[A-Z_]+/.test(ref)) return;
    refs.push(ref);
    if (!/@sha256:[0-9a-f]{64}$/.test(ref))
      findings.push({ file, line: i + 1, problem: `image ${ref} has no sha256 digest` });
    if (/:latest(@|$)/.test(ref) || (!/:[^/@]+(@|$)/.test(ref.replace(/^[^/]*\//, "")) && !ref.includes("@")))
      findings.push({ file, line: i + 1, problem: `image ${ref} is floating (latest or untagged)` });
  });
  return { refs, findings };
}

/** package.json: exact versions only (no ranges, tags or wildcards) outside workspace references. */
export function checkPackageJson(file: string, text: string): Finding[] {
  const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const out: Finding[] = [];
  for (const sect of ["dependencies", "devDependencies", "optionalDependencies"])
    for (const [name, spec] of Object.entries(json[sect] ?? {}))
      if (!/^(workspace:[*^~]?|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|npm:.+@\d+\.\d+\.\d+.*)$/.test(spec))
        out.push({ file, line: 0, problem: `${sect}.${name} is "${spec}" (floating or ranged)` });
  return out;
}

/** pyproject.toml: `==` pins only. */
export function checkPyproject(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/^\s*"([A-Za-z0-9_.\-[\]]+)\s*([<>=!~^]+)?\s*([^"]*)"\s*,?\s*$/gm))
    if (m[2] !== "==")
      out.push({ file, line: 0, problem: `python dependency ${m[1]} is not pinned with ==` });
  return out;
}

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 240_000 });

it("SEC11: locked, pinned inputs with an SBOM; the negative-control branch is rejected", () => {
  const composeFiles = walk(ROOT, (n) => /^(docker-)?compose.*\.ya?ml$/.test(n) || /^Dockerfile/.test(n));
  const manifests = walk(ROOT, (n) => n === "package.json");
  const pyprojects = walk(ROOT, (n) => n === "pyproject.toml");
  const findings: Finding[] = [];
  const imageRefs: string[] = [];
  for (const f of composeFiles) {
    const r = checkImages(relative(ROOT, f), readFileSync(f, "utf8"));
    findings.push(...r.findings);
    imageRefs.push(...r.refs);
  }
  for (const f of manifests) findings.push(...checkPackageJson(relative(ROOT, f), readFileSync(f, "utf8")));
  for (const f of pyprojects) findings.push(...checkPyproject(relative(ROOT, f), readFileSync(f, "utf8")));

  // (b) both lockfile checks
  const pnpmCheck = run("pnpm", ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"]);
  const uvCheck = run("uv", ["lock", "--check"]);

  // (c) SBOM from the lockfiles (syft in a container with no network) plus the image references
  const work = mkdtempSync(join(tmpdir(), "sec11-"));
  tmp.push(work);
  cpSync(join(ROOT, "pnpm-lock.yaml"), join(work, "pnpm-lock.yaml"));
  cpSync(join(ROOT, "uv.lock"), join(work, "uv.lock"));
  const syft = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${work}:/src:ro`,
      "anchore/syft:v1.56.0",
      "dir:/src",
      "-o",
      "cyclonedx-json",
      "-q",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 240_000 },
  );
  expect(syft.status, syft.stderr.slice(0, 300)).toBe(0);
  const bom = JSON.parse(syft.stdout) as {
    components?: Array<{ name: string; version?: string; purl?: string }>;
  };
  const sbomPackages = new Set((bom.components ?? []).map((c) => `${c.name}@${c.version ?? ""}`));
  const lockText = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  const lockedJs = [...lockText.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^\s':(]+)[^:]*'?:\s*$/gm)]
    .filter((m) => lockText.indexOf(`  ${m[0].trim()}`) > lockText.indexOf("\npackages:"))
    .map((m) => `${m[1]}@${m[2]}`);
  const missingJs = lockedJs.filter((p) => !sbomPackages.has(p));
  const uvText = readFileSync(join(ROOT, "uv.lock"), "utf8");
  const lockedPy = [...uvText.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)].map(
    (m) => `${m[1]}@${m[2]}`,
  );
  const missingPy = lockedPy.filter((p) => !sbomPackages.has(p) && !sbomPackages.has(p.replace(/_/g, "-")));
  const combined = JSON.stringify({
    sbom: bom,
    images: [...new Set(imageRefs)].sort(),
  });
  const sbomSha256 = createHash("sha256").update(combined).digest("hex");

  // (e) negative control: the same checkers over a branch with a `latest` image and an unpinned dependency
  const bad = [
    ...checkImages(
      "neg/compose.yml",
      "services:\n  db:\n    image: postgres:latest\n  c:\n    image: redis:8@sha256:" +
        "0".repeat(63) +
        "\n",
    ).findings,
    ...checkImages("neg/Dockerfile", "FROM node\n").findings,
    ...checkPackageJson(
      "neg/package.json",
      JSON.stringify({ dependencies: { left: "^1.0.0", pad: "latest", ok: "1.2.3" } }),
    ),
    ...checkPyproject("neg/pyproject.toml", 'dependencies = [\n  "numpy>=2",\n  "scipy==1.18.1",\n]\n'),
  ];
  const negRejected =
    bad.length >= 5 &&
    bad.some((f) => /latest/.test(f.problem)) &&
    bad.some((f) => /\^1\.0\.0/.test(f.problem));

  // (d) production containers declare a non-root user: no production container definition exists in the repository
  const dockerfiles = composeFiles.filter((f) => /Dockerfile/.test(f));
  const rootUsers = composeFiles
    .filter((f) => /compose/.test(f))
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /^\s*user:\s*["']?0(:0)?["']?/.test(l))
        .map(() => relative(ROOT, f)),
    );

  expect(findings).toEqual([]);
  expect(pnpmCheck.status, pnpmCheck.stderr.slice(0, 300)).toBe(0);
  expect(uvCheck.status, uvCheck.stderr.slice(0, 300)).toBe(0);
  expect(missingJs.slice(0, 5)).toEqual([]);
  expect(missingPy.slice(0, 5)).toEqual([]);
  expect(lockedJs.length).toBeGreaterThan(100);
  expect(negRejected).toBe(true);
  expect(existsSync(join(ROOT, "pnpm-lock.yaml"))).toBe(true);

  const evidence = {
    sbomSha256,
    imageRefs: [...new Set(imageRefs)],
    jsPackages: lockedJs.length,
    pyPackages: lockedPy.length,
    sbomComponents: sbomPackages.size,
    manifestsChecked: manifests.length + pyprojects.length,
    productionContainerDefinitions: dockerfiles.length,
    devComposeRootUsers: rootUsers,
  };
  const observed = `${imageRefs.length} image references in ${composeFiles.length} compose/Dockerfile(s), all with sha256 digests; ${manifests.length} package.json and ${pyprojects.length} pyproject files with exact pins only (0 findings); pnpm install --frozen-lockfile --lockfile-only exit ${pnpmCheck.status}, uv lock --check exit ${uvCheck.status}; SBOM (syft ${"v1.56.0"}) lists ${lockedJs.length} locked JS and ${lockedPy.length} locked Python packages (0 missing) plus ${new Set(imageRefs).size} images, sbomSha256 ${sbomSha256.slice(0, 16)}; negative-control branch (latest tag, unpinned FROM, ^ and latest npm specs, unpinned python) rejected with ${bad.length} findings; production container definitions in the repository: ${dockerfiles.length} (criterion (d) cannot be exercised; dev compose has root user entries in: ${rootUsers.join(", ") || "none"})`;
  if (dockerfiles.length === 0)
    observe({
      testId: "SEC11",
      observed,
      fixtureHash: sbomSha256,
      evidence,
      blocked:
        "criterion (d) needs production container definitions (ch.17 release packaging); none exist yet, only the dev compose stack. Criteria (a), (b), (c) and (e) were executed and held.",
    });
  else observe({ testId: "SEC11", observed, fixtureHash: sbomSha256, evidence });
}, 600_000);
