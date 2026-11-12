/** Read-only ClickHouse access for the independent numeric checks. Anything but a single SELECT/WITH statement is refused. */
const URL_ = process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123";
const USER = process.env.NEARESIS_CH_USER ?? "nearesis";
const PASS = process.env.NEARESIS_CH_PASSWORD ?? "nearesis";
const DB = process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live";

export function assertReadOnly(sql: string): void {
  const s = sql.trim();
  if (
    !/^(select|with)\b/i.test(s) ||
    s.includes(";") ||
    /\b(insert|alter|drop|create|truncate|optimize|system|attach|detach|rename|grant)\b/i.test(s)
  )
    throw new Error("evals: only a single read-only SELECT is allowed");
}

export async function chScalar(sql: string): Promise<number> {
  assertReadOnly(sql);
  const r = await fetch(`${URL_}/?database=${DB}&readonly=1&default_format=TSV`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` },
    body: sql,
  });
  const t = (await r.text()).trim();
  if (!r.ok) throw new Error(`clickhouse ${r.status}: ${t.slice(0, 200)}`);
  return Number(t.split("\n")[0]!.split("\t")[0]);
}
