import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BigQuery } from "@google-cloud/bigquery";
import type { BigQueryJobLike, BigQueryLike } from "./bigquery.ts";

/** Adapts the real @google-cloud/bigquery client (ADC, no keys) to the narrow BigQueryLike surface. */
export function createBigQueryClient(): BigQueryLike & {
  tableColumns(
    project: string,
    dataset: string,
    table: string,
  ): Promise<Array<{ name: string; type: string }>>;
} {
  const bq = new BigQuery();
  return {
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
  };
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
