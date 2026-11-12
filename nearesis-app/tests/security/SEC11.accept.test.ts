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
import { basename, dirname, join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  evaluatePolicy,
  plantedArtifactDir,
  readWaivers,
  scanFs,
  scannerInfo,
} from "../../scripts/release/vuln-scan.ts";

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

/** Production container checks: the final stage runs as a numeric non-root user, no secret is baked in, rootfs read-only. */
export function checkProdDockerfile(file: string, text: string, ignoreText: string | null): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n").map((l) => l.replace(/^\s+|\s+$/g, ""));
  const finalFrom = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter((i) => i >= 0);
  const finalStage = lines.slice(finalFrom.at(-1) ?? 0);
  const users = finalStage.filter((l) => /^USER\s/i.test(l));
  const user = users.at(-1)?.replace(/^USER\s+/i, "") ?? "";
  if (!/^[1-9]\d*(:[1-9]\d*)?$/.test(user))
    out.push({
      file,
      line: 0,
      problem: `final stage user is "${user || "unset (root)"}", not a numeric non-root uid`,
    });
  lines.forEach((l, i) => {
    if (
      /^(ENV|ARG)\s+\S*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|JWT)\S*\s*=?\s*\S+/i.test(l) &&
      !/^ARG\s+\S+\s*$/i.test(l)
    )
      out.push({ file, line: i + 1, problem: "secret-looking ENV/ARG with a value baked into the image" });
    if (/^(COPY|ADD)\s.*(\.env\b|\.pem\b|id_rsa|\.key\b)/i.test(l))
      out.push({ file, line: i + 1, problem: "copies a secret-bearing file into the image" });
  });
  if (!ignoreText || !/^\.env\s*$/m.test(ignoreText))
    out.push({ file, line: 0, problem: "no .dockerignore excluding .env" });
  return out;
}

export function checkProdCompose(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const svcBlocks = text.split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).slice(1);
  for (const b of svcBlocks) {
    const name = b.split(":")[0];
    if (!/^\s*read_only:\s*true/m.test(b))
      out.push({ file, line: 0, problem: `${name}: rootfs not read-only` });
    const u = /^\s*user:\s*["']?([^"'\s]+)/m.exec(b)?.[1];
    if (!u || /^(0|root)(:|$)/.test(u))
      out.push({ file, line: 0, problem: `${name}: user is "${u ?? "unset"}" (root)` });
    if (!/cap_drop:\s*\[?\s*ALL/.test(b))
      out.push({ file, line: 0, problem: `${name}: capabilities not dropped` });
    if (/privileged:\s*true/.test(b)) out.push({ file, line: 0, problem: `${name}: privileged` });
    if (/^\s*(?:\w*(SECRET|TOKEN|PASSWORD|KEY)\w*):\s*["']?[^$"'\s][^\s]{7,}/im.test(b))
      out.push({ file, line: 0, problem: `${name}: literal secret in environment` });
  }
  return out;
}

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 240_000 });

it("SEC11: locked, pinned inputs with an SBOM; the negative-control branch is rejected", () => {
  const composeFiles = walk(
    ROOT,
    (n) => /^(docker-)?compose.*\.ya?ml$/.test(n) || /^Dockerfile(\.[a-z]+)?$/.test(n),
  );
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

  // scanner pin and a real scan of exactly the SBOM inputs (the two lockfiles), with a planted negative control
  const scanner = scannerInfo();
  let scan: Record<string, unknown> = { ran: false, reason: "trivy not installed" };
  if (scanner) {
    expect(scanner.pinOk, "trivy must be the pinned version and binary").toBe(true);
    const found = scanFs(work);
    const v = evaluatePolicy(found, readWaivers());
    expect(v.blockers).toEqual([]);
    const planted = plantedArtifactDir();
    tmp.push(planted);
    const neg = evaluatePolicy(scanFs(planted), []);
    expect(neg.verdict).toBe("BLOCK");
    scan = {
      ran: true,
      scanner: `${scanner.name} ${scanner.version}`,
      dbUpdatedAt: scanner.dbUpdatedAt,
      lockfileFindings: found.length,
      verdict: v.verdict,
      negativeControlBlockers: neg.blockers.length,
    };
  }

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

  // (d) production containers: non-root, read-only rootfs, pinned digests (checked above), no secrets in images
  const deployDir = join(ROOT, "infrastructure", "deploy");
  const prodDockerfiles = composeFiles.filter((f) => /Dockerfile/.test(f) && f.startsWith(deployDir));
  const prodComposes = composeFiles.filter((f) => /compose/.test(f) && f.startsWith(deployDir));
  const containerFindings: Finding[] = [];
  for (const f of prodDockerfiles) {
    const ign = join(dirname(f), `${basename(f)}.dockerignore`);
    containerFindings.push(
      ...checkProdDockerfile(
        relative(ROOT, f),
        readFileSync(f, "utf8"),
        existsSync(ign) ? readFileSync(ign, "utf8") : null,
      ),
    );
  }
  for (const f of prodComposes)
    containerFindings.push(...checkProdCompose(relative(ROOT, f), readFileSync(f, "utf8")));
  const badContainers = [
    ...checkProdDockerfile(
      "neg/Dockerfile",
      "FROM node@sha256:" + "a".repeat(64) + "\nUSER root\nENV API_KEY=abcdef123\n",
      null,
    ),
    ...checkProdCompose("neg/compose.yml", 'services:\n  x:\n    image: a\n    user: "0:0"\n'),
  ];
  const containerNegRejected =
    badContainers.some((f) => /not a numeric non-root/.test(f.problem)) &&
    badContainers.some((f) => /secret-looking/.test(f.problem)) &&
    badContainers.some((f) => /not read-only/.test(f.problem)) &&
    badContainers.some((f) => /root/.test(f.problem));
  const dockerfiles = prodDockerfiles;
  const rootUsers = composeFiles
    .filter((f) => /compose/.test(f) && !f.startsWith(deployDir))
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /^\s*user:\s*["']?0(:0)?["']?/.test(l))
        .map(() => relative(ROOT, f)),
    );

  expect(dockerfiles.length).toBeGreaterThanOrEqual(3);
  expect(containerFindings).toEqual([]);
  expect(containerNegRejected).toBe(true);
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
    productionContainerDefinitions: dockerfiles.map((f) => relative(ROOT, f)),
    devComposeRootUsers: rootUsers,
    vulnerabilityScan: scan,
  };
  const observed = `${imageRefs.length} image references in ${composeFiles.length} compose/Dockerfile(s), all with sha256 digests; ${manifests.length} package.json and ${pyprojects.length} pyproject files with exact pins only (0 findings); pnpm install --frozen-lockfile --lockfile-only exit ${pnpmCheck.status}, uv lock --check exit ${uvCheck.status}; SBOM (syft ${"v1.56.0"}) lists ${lockedJs.length} locked JS and ${lockedPy.length} locked Python packages (0 missing) plus ${new Set(imageRefs).size} images, sbomSha256 ${sbomSha256.slice(0, 16)}; negative-control branch (latest tag, unpinned FROM, ^ and latest npm specs, unpinned python) rejected with ${bad.length} findings; production container definitions (infrastructure/deploy): ${dockerfiles.length} Dockerfiles and ${prodComposes.length} compose file, all final stages numeric non-root, read-only rootfs, cap_drop ALL, no secret in image or compose (0 findings), container negative control (root user, baked secret, writable rootfs) rejected with ${badContainers.length} findings; pinned trivy scan of the two SBOM lockfiles: ${JSON.stringify(scan)}; images are not built or deployed by this test; the dev compose root user entries (infrastructure/compose, not production) are in: ${rootUsers.join(", ") || "none"}`;
  observe({ testId: "SEC11", observed, fixtureHash: sbomSha256, evidence });
}, 600_000);
