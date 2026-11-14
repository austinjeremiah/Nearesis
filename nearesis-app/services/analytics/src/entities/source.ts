import type { ClickHouseClient } from "@clickhouse/client";
import type { ActivityInput, EntityDataSource, RegistrySnapshot } from "./types.ts";

const D = /^\d{4}-\d{2}-\d{2}$/;
const iso = (s: string): string => `${s.replace(" ", "T").replace(/\.\d+$/, "")}Z`;

/** ClickHouse-backed source over nearesis_live. Dates are validated, then passed as typed query parameters. */
export class ClickHouseEntitySource implements EntityDataSource {
  constructor(private readonly ch: ClickHouseClient) {}

  private async rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const rs = await this.ch.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0, date_time_output_format: "simple" },
    });
    return (await rs.json()) as T[];
  }

  async registry(): Promise<RegistrySnapshot> {
    const ver = await this.rows<{ v: string | null }>(
      "SELECT max(registry_version) AS v FROM entities FINAL",
    );
    const registryVersion = ver[0]?.v;
    if (!registryVersion) return { registryVersion: "none", entities: [], mappings: [], relations: [] };
    const p = { rv: registryVersion };
    const [e, m, r] = await Promise.all([
      this.rows<Record<string, string | null>>(
        "SELECT entity_id, entity_type, name, category_id, parent_entity_id, description, registry_version FROM entities FINAL WHERE registry_version = {rv:String} ORDER BY entity_id",
        p,
      ),
      this.rows<Record<string, string | number | null>>(
        "SELECT mapping_id, entity_id, network, match_type, account, role, toString(effective_from) AS effective_from, toString(effective_to) AS effective_to, registry_version, methodology, verification, confidence, evidence_kind, evidence_url, evidence_note, limitations, precedence FROM entity_mappings FINAL WHERE registry_version = {rv:String} ORDER BY entity_id, account",
        p,
      ),
      this.rows<Record<string, string | null>>(
        "SELECT relation_id, from_entity_id, to_entity_id, relation, toString(effective_from) AS effective_from, toString(effective_to) AS effective_to, verification, evidence_url, note, registry_version FROM entity_relations FINAL WHERE registry_version = {rv:String} ORDER BY relation_id",
        p,
      ),
    ]);
    return {
      registryVersion,
      entities: e.map((x) => ({
        entityId: x.entity_id!,
        entityType: x.entity_type as never,
        name: x.name!,
        categoryId: x.category_id ?? null,
        parentEntityId: x.parent_entity_id ?? null,
        description: x.description!,
        registryVersion: x.registry_version!,
      })),
      mappings: m.map((x) => ({
        mappingId: String(x.mapping_id),
        entityId: String(x.entity_id),
        network: String(x.network),
        matchType: x.match_type as "exact",
        account: String(x.account),
        role: String(x.role),
        effectiveFrom: iso(String(x.effective_from)),
        effectiveTo: x.effective_to ? iso(String(x.effective_to)) : null,
        registryVersion: String(x.registry_version),
        methodology: String(x.methodology),
        verification: x.verification as "verified",
        confidence: x.confidence as "high",
        evidenceKind: String(x.evidence_kind),
        evidenceUrl: String(x.evidence_url),
        evidenceNote: String(x.evidence_note),
        limitations: String(x.limitations),
        precedence: Number(x.precedence),
      })),
      relations: r.map((x) => ({
        relationId: x.relation_id!,
        fromEntityId: x.from_entity_id!,
        toEntityId: x.to_entity_id!,
        relation: x.relation as "alias_of",
        effectiveFrom: x.effective_from ? iso(x.effective_from) : null,
        effectiveTo: x.effective_to ? iso(x.effective_to) : null,
        verification: x.verification as "verified",
        evidenceUrl: x.evidence_url!,
        note: x.note!,
        registryVersion: x.registry_version!,
      })),
    };
  }

  async activity(from: string, to: string): Promise<ActivityInput> {
    if (!D.test(from) || !D.test(to)) throw new Error("dates must be YYYY-MM-DD");
    const p = { from, to };
    const [receivers, remainder] = await Promise.all([
      this.rows<{ date: string; receiver: string; interactions: number }>(
        "SELECT toString(block_date) AS date, receiver_account_id AS receiver, sum(interactions) AS interactions FROM contract_interactions FINAL WHERE block_date BETWEEN {from:Date} AND {to:Date} GROUP BY date, receiver",
        p,
      ),
      this.rows<{ date: string; interactions: number }>(
        "SELECT toString(block_date) AS date, sum(interactions) AS interactions FROM contract_interactions_below_threshold FINAL WHERE block_date BETWEEN {from:Date} AND {to:Date} GROUP BY date",
        p,
      ),
    ]);
    return {
      receivers: receivers.map((r) => ({ ...r, interactions: Number(r.interactions) })),
      remainder: remainder.map((r) => ({ ...r, interactions: Number(r.interactions) })),
    };
  }

  async latestDate(): Promise<string | null> {
    const r = await this.rows<{ d: string | null }>(
      "SELECT toString(max(block_date)) AS d FROM contract_interactions",
    );
    return r[0]?.d && r[0].d !== "1970-01-01" ? r[0].d : null;
  }
}
