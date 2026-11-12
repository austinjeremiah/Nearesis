/**
 * Local release image builds (ch.17): api, worker and web production images from the repository's pinned-base Dockerfiles,
 * built from a clean `git archive` export of a ref (never the dirty working tree), never pushed. The "digest" recorded for
 * each image is its content-addressed local image ID (`sha256:...`, the digest of the image config); a registry manifest
 * digest only exists after a push, which this tooling never performs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const IMAGE_DOCKERFILES = {
  api: "infrastructure/deploy/Dockerfile.api",
  /** The background worker is the ingestion scheduler image. */
  worker: "infrastructure/deploy/Dockerfile.ingestion",
  web: "infrastructure/deploy/Dockerfile.web",
} as const;
export type ImageName = keyof typeof IMAGE_DOCKERFILES;
export const IMAGE_NAMES = Object.keys(IMAGE_DOCKERFILES) as ImageName[];
export const REPO = "nearesis-release";

export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => { code: number; out: string; err: string };
export const realRun: Run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts?.cwd,
    input: opts?.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
};

export interface BuiltImage {
  tag: string;
  /** `sha256:<64 hex>`, the local content-addressed image ID. */
  digest: string;
  dockerfile: string;
  baseImage: string;
  baseDigestPinned: boolean;
  user: string;
  sizeBytes: number;
  nonRoot: boolean;
  envFilesInImage: string[];
}
export interface BuildRecord {
  label: string;
  ref: string;
  gitSha: string;
  builtAt: string;
  platform: string;
  pushed: false;
  images: Record<ImageName, BuiltImage>;
  sbom: { path: string; sha256: string; packages: number; osPackages: number } | null;
  vulnerabilityScan: { status: "NOT_RUN"; reason: string } | { status: "RAN"; tool: string; summary: string };
}

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function inspectImage(
  run: Run,
  ref: string,
): { id: string; user: string; size: number; labels: Record<string, string> } | null {
  const r = run("docker", ["image", "inspect", ref, "--format", "{{json .}}"]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.out) as {
    Id: string;
    Size: number;
    Config: { User: string; Labels: Record<string, string> | null };
  };
  return { id: j.Id, user: j.Config.User, size: j.Size, labels: j.Config.Labels ?? {} };
}

export function baseOf(dockerfileText: string): { image: string; pinned: boolean } {
  const froms = [...dockerfileText.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]!);
  const image = froms[froms.length - 1] ?? "";
  return { image, pinned: froms.length > 0 && froms.every((f) => /@sha256:[0-9a-f]{64}$/.test(f)) };
}

/** Export a clean checkout of `ref` (the app subtree) into a new directory. */
export function exportRef(
  run: Run,
  repoRoot: string,
  appDir: string,
  ref: string,
): { dir: string; gitSha: string } {
  const sha = run("git", ["-C", repoRoot, "rev-parse", ref]).out.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unknown ref ${ref}`);
  const dir = mkdtempSync(join(tmpdir(), "nearesis-ctx-"));
  const sh = run("sh", ["-c", `git -C '${repoRoot}' archive ${sha}:${appDir} | tar -x -C '${dir}'`]);
  if (sh.code !== 0) throw new Error(`git archive failed: ${sh.err.slice(0, 200)}`);
  return { dir, gitSha: sha };
}

export function buildImages(opts: {
  run?: Run;
  repoRoot: string;
  appDir: string;
  ref: string;
  label: string;
  outDir: string;
  noCache?: boolean;
  names?: ImageName[];
}): BuildRecord {
  const run = opts.run ?? realRun;
  const { dir, gitSha } = exportRef(run, opts.repoRoot, opts.appDir, opts.ref);
  const images = {} as Record<ImageName, BuiltImage>;
  try {
    for (const name of opts.names ?? IMAGE_NAMES) {
      const dockerfile = IMAGE_DOCKERFILES[name];
      const text = readFileSync(join(dir, dockerfile), "utf8");
      const base = baseOf(text);
      if (!base.pinned) throw new Error(`${dockerfile}: base image is not pinned by digest`);
      const tag = `${REPO}/${name}:${gitSha.slice(0, 12)}`;
      const args = [
        "build",
        "-q",
        "-f",
        dockerfile,
        "-t",
        tag,
        "--label",
        `org.nearesis.git-sha=${gitSha}`,
        "--label",
        `org.nearesis.image=${name}`,
        ...(opts.noCache ? ["--no-cache"] : []),
        ".",
      ];
      const b = run("docker", args, { cwd: dir });
      if (b.code !== 0) throw new Error(`docker build ${name} failed: ${b.err.slice(-400)}`);
      const info = inspectImage(run, tag);
      if (!info || !DIGEST.test(info.id)) throw new Error(`cannot inspect ${tag}`);
      const envFiles = run("docker", [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        tag,
        "-c",
        "find / -xdev \\( -name '.env' -o -name '.env.*' -o -name '*.pem' \\) -not -path '*/node_modules/*' 2>/dev/null; true",
      ]);
      images[name] = {
        tag,
        digest: info.id,
        dockerfile,
        baseImage: base.image,
        baseDigestPinned: base.pinned,
        user: info.user,
        sizeBytes: info.size,
        nonRoot: /^[1-9]\d*(:\d+)?$/.test(info.user),
        envFilesInImage: envFiles.out.split("\n").filter(Boolean),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const record: BuildRecord = {
    label: opts.label,
    ref: opts.ref,
    gitSha,
    builtAt: new Date().toISOString(),
    platform: run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).out.trim(),
    pushed: false,
    images,
    sbom: null,
    vulnerabilityScan: {
      status: "NOT_RUN",
      reason:
        "no offline image scanner (syft, grype, trivy) is installed and none may be downloaded without approval; lockfile dependency scanning is covered by SEC05",
    },
  };
  record.sbom = writeSbom(run, opts.repoRoot, opts.appDir, record, opts.outDir);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "build-record.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/** Image SBOM: OS packages read from each image (dpkg status) plus every package in the committed lockfile. */
export function writeSbom(
  run: Run,
  repoRoot: string,
  appDir: string,
  rec: BuildRecord,
  outDir: string,
): BuildRecord["sbom"] {
  const lock = run("git", ["-C", repoRoot, "show", `${rec.gitSha}:${appDir}/pnpm-lock.yaml`]).out;
  // every lockfile document: a package entry is a two-space-indented `name@version:` key followed by its resolution
  const pkgs = [...lock.matchAll(/^ {2}'?(@?[^\s'][^\s']*?)@([^\s'@]+)'?:\n {4}resolution:/gm)].map(
    (m) => `${m[1]}@${m[2]}`,
  );
  const unique = [...new Set(pkgs)].sort();
  const osPackages: Record<string, string[]> = {};
  for (const [name, img] of Object.entries(rec.images)) {
    const r = run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "dpkg-query",
      img.tag,
      "-W",
      "-f",
      "${Package} ${Version}\\n",
    ]);
    osPackages[name] = r.out.split("\n").filter(Boolean).sort();
  }
  const doc = {
    bomFormat: "nearesis-sbom-1",
    gitSha: rec.gitSha,
    images: Object.fromEntries(
      Object.entries(rec.images).map(([k, v]) => [k, { digest: v.digest, base: v.baseImage }]),
    ),
    lockfilePackages: unique,
    osPackages,
  };
  const body = JSON.stringify(doc, null, 2) + "\n";
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "image-sbom.json");
  writeFileSync(path, body);
  return {
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
    packages: unique.length,
    osPackages: Object.values(osPackages).reduce((n, a) => n + a.length, 0),
  };
}

export const readBuildRecord = (dir: string): BuildRecord | null => {
  const p = join(dir, "build-record.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BuildRecord) : null;
};
/** Recompute each image's digest from the local engine; `null` when the image is absent. */
export function recomputeDigests(run: Run, rec: BuildRecord): Record<ImageName, string | null> {
  return Object.fromEntries(
    IMAGE_NAMES.map((n) => [n, inspectImage(run, rec.images[n].digest)?.id ?? null]),
  ) as Record<ImageName, string | null>;
}
