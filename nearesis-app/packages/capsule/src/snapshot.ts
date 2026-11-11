import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CapsuleFileEntry, CapsuleLabel } from "@nearesis/contracts";
import { sha256Hex } from "./canonical.ts";
import { validateInput } from "./verifier-ref.ts";
import type { VerifierInput } from "./verifier-ref.ts";

const SeriesSpec = z.strictObject({
  column: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
});

/** `snapshot.json`: the descriptor of a frozen snapshot directory. Raw files are listed with their SHA-256. */
export const SnapshotDescriptor = z.strictObject({
  schema: z.literal("nearesis.snapshot.v1"),
  snapshotId: z.string().min(1).max(120),
  label: CapsuleLabel,
  /** Fixed at freeze time. Used as the capsule's createdAt so a rebuild is byte-identical. */
  frozenAt: z.iso.datetime({ offset: true }),
  dataset: z.string().min(1).max(200),
  claimId: z.string().min(1).max(120),
  analysisCodeCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  series: z.strictObject({ file: z.string().min(1), x: SeriesSpec, y: SeriesSpec }),
  metrics: z.array(z.string()).min(1),
  files: z.array(CapsuleFileEntry).min(1),
});
export type SnapshotDescriptor = z.infer<typeof SnapshotDescriptor>;

export class SnapshotError extends Error {
  constructor(
    readonly kind: "MANIFEST_INVALID" | "FILE_MISSING" | "RAW_HASH_MISMATCH" | "INPUT_INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface LoadedSnapshot {
  descriptor: SnapshotDescriptor;
  /** Raw bytes keyed by descriptor path. Hashes are verified before this is returned. */
  raw: Map<string, Buffer>;
}

export function loadSnapshot(dir: string): LoadedSnapshot {
  const p = join(dir, "snapshot.json");
  if (!existsSync(p)) throw new SnapshotError("FILE_MISSING", "snapshot.json is missing");
  const parsed = SnapshotDescriptor.safeParse(JSON.parse(readFileSync(p, "utf8")));
  if (!parsed.success)
    throw new SnapshotError("MANIFEST_INVALID", parsed.error.issues[0]?.message ?? "invalid descriptor");
  const descriptor = parsed.data;
  const raw = new Map<string, Buffer>();
  for (const f of descriptor.files) {
    const fp = join(dir, f.path);
    if (!existsSync(fp)) throw new SnapshotError("FILE_MISSING", `raw file missing: ${f.path}`);
    const b = readFileSync(fp);
    if (sha256Hex(b) !== f.sha256 || b.length !== f.bytes)
      throw new SnapshotError("RAW_HASH_MISMATCH", `raw bytes differ from the frozen hash: ${f.path}`);
    raw.set(f.path, b);
  }
  if (!raw.has(descriptor.series.file))
    throw new SnapshotError("MANIFEST_INVALID", "series file is not listed in files");
  return { descriptor, raw };
}

/** Deterministically derive the verifier input from raw bytes. Pure function of descriptor + raw CSV. */
export function deriveVerifierInput(descriptor: SnapshotDescriptor, csv: Uint8Array): VerifierInput {
  const lines = Buffer.from(csv)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const head = (lines[0] ?? "").split(",");
  const ix = head.indexOf(descriptor.series.x.column);
  const iy = head.indexOf(descriptor.series.y.column);
  if (head[0] !== "date" || ix < 0 || iy < 0)
    throw new SnapshotError("INPUT_INVALID", "csv header lacks date or the series columns");
  const x: Array<[string, string]> = [];
  const y: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c.length !== head.length)
      throw new SnapshotError("INPUT_INVALID", "csv row width differs from header");
    x.push([c[0]!, c[ix]!]);
    y.push([c[0]!, c[iy]!]);
  }
  const input: VerifierInput = {
    schema_version: "nearesis.verifier.input.v1",
    claim_id: descriptor.claimId,
    source: {
      dataset: descriptor.dataset,
      snapshot_id: descriptor.snapshotId,
      synthetic: descriptor.label === "SYNTHETIC",
    },
    series: {
      x: { name: descriptor.series.x.name, unit: descriptor.series.x.unit, points: x },
      y: { name: descriptor.series.y.name, unit: descriptor.series.y.unit, points: y },
    },
    metrics: [...descriptor.metrics],
  };
  const bad = validateInput(input);
  if (bad) throw new SnapshotError("INPUT_INVALID", `verifier input rejected: ${bad}`);
  return input;
}
