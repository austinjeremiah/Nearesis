import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BigQuery } from "@google-cloud/bigquery";
import { getAmbientSpendGate } from "../cost/ambient.ts";
import { gateBigQuery } from "../cost/gates.ts";
import type { BigQueryJobLike, BigQueryLike } from "./bigquery.ts";

/** Adapts the real @google-cloud/bigquery client (ADC, no keys) to the narrow BigQueryLike surface. */
export type BigQueryClient = BigQueryLike & {
  tableColumns(
    project: string,
    dataset: string,
    table: string,
  ): Promise<Array<{ name: string; type: string }>>;
  /** Free load job: (re)creates a one-column (`h` STRING) scratch table from `hashes`, expiring in 24 h as a backstop. */
  loadScratchTable(ref: ScratchRef, hashes: string[], location: string): Promise<void>;
  deleteScratchTable(ref: ScratchRef, location: string): Promise<void>;
};
export interface ScratchRef {
  projectId: string;
  datasetId: string;
  tableId: string;
}
export function createBigQueryClient(): BigQueryClient {
  const bq = new BigQuery();
  const real: BigQueryClient = {
    getProjectId: () => bq.getProjectId(),
    async getDatasetMetadata(projectId, datasetId) {
      const [m] = await bq.dataset(datasetId, { projectId }).getMetadata();
      return { location: (m as { location?: string }).location };
    },
    async createQueryJob(opts) {
      const [job] = await bq.createQueryJob(opts);
      return [job as unknown as BigQueryJobLike];
    },
    async tableColumns(project, dataset, table) {
      const [m] = await bq.dataset(dataset, { projectId: project }).table(table).getMetadata();
      const fields = (
        (m as { schema?: { fields?: Array<{ name: string; type: string }> } }).schema?.fields ?? []
      ).map((f) => ({ name: f.name, type: f.type }));
      return fields;
    },
    async loadScratchTable(ref, hashes, location) {
      const dir = mkdtempSync(join(tmpdir(), "bq-scratch-"));
      const file = join(dir, "h.ndjson");
      try {
        writeFileSync(file, hashes.map((h) => JSON.stringify({ h })).join("\n"));
        const table = bq.dataset(ref.datasetId, { projectId: ref.projectId }).table(ref.tableId);
        await table.load(file, {
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          schema: { fields: [{ name: "h", type: "STRING" }] },
          writeDisposition: "WRITE_TRUNCATE",
          createDisposition: "CREATE_IF_NEEDED",
          location,
        });
        await table.setMetadata({ expirationTime: String(Date.now() + 24 * 3_600_000) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async deleteScratchTable(ref) {
      await bq
        .dataset(ref.datasetId, { projectId: ref.projectId })
        .table(ref.tableId)
        .delete({ ignoreNotFound: true });
    },
  };
  // NEARESIS_COST_CONTROL=1: billed jobs are authorised against the dry-run estimate and settled with billed bytes.
  return { ...real, ...gateBigQuery(real, getAmbientSpendGate()) };
}

/** Credential kind from the ADC file (type only; never reads or returns secret fields). */
export function adcCredentialKind(): string | null {
  const path =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  try {
    const t = (JSON.parse(readFileSync(path, "utf8")) as { type?: string }).type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}
