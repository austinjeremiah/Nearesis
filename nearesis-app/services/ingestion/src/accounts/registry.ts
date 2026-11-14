import type { ClickHouseClient } from "@clickhouse/client";
import type { MappingInput } from "./sql.ts";

/** Reads the latest registry version's mappings from nearesis_live (the only registry store). */
export async function readRegistryMappings(
  ch: ClickHouseClient,
): Promise<{ registryVersion: string; mappings: MappingInput[] }> {
  const v = (await (
    await ch.query({
      query: "SELECT max(registry_version) AS v FROM entity_mappings FINAL",
      format: "JSONEachRow",
    })
  ).json()) as Array<{ v: string | null }>;
  const registryVersion = v[0]?.v;
  if (!registryVersion) return { registryVersion: "none", mappings: [] };
  const rs = await ch.query({
    query:
      "SELECT mapping_id, entity_id, network, match_type, account, toString(effective_from) AS effective_from, toString(effective_to) AS effective_to, verification, precedence FROM entity_mappings FINAL WHERE registry_version = {rv:String} ORDER BY mapping_id",
    query_params: { rv: registryVersion },
    format: "JSONEachRow",
    clickhouse_settings: { date_time_output_format: "simple" },
  });
  const rows = (await rs.json()) as Array<Record<string, string | number | null>>;
  return {
    registryVersion,
    mappings: rows.map((x) => ({
      mappingId: String(x.mapping_id),
      entityId: String(x.entity_id),
      network: String(x.network),
      matchType: x.match_type as "exact" | "suffix",
      account: String(x.account),
      effectiveFrom:
        String(x.effective_from)
          .replace(" ", "T")
          .replace(/\.\d+$/, "") + "Z",
      effectiveTo: x.effective_to
        ? String(x.effective_to)
            .replace(" ", "T")
            .replace(/\.\d+$/, "") + "Z"
        : null,
      verification: x.verification as "verified",
      precedence: Number(x.precedence),
    })),
  };
}
