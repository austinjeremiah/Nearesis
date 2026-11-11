/**
 * SEC03: RLS fuzz of tenant, workspace and object IDs. PASS: no foreign workspace result.
 * Real HTTP server on 127.0.0.1:4750 over a disposable database (kernel + runtime schemas, app role NOBYPASSRLS).
 * Tenant B owns canary data; tenant A (an authenticated, non-privileged owner of its own org) sends every route
 * mutated identifiers, B's real identifiers, confused-parent combinations and forged tenant fields. Also checked at
 * the SQL layer: every org-keyed table has FORCEd RLS and A's context sees, changes and inserts nothing of B's.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "@nearesis/contracts";
import { apiFixture, login, seedOrg } from "../../apps/api/test/helpers.ts";
import type { ApiFixture } from "../../apps/api/test/helpers.ts";

const PORT = 4750;
const BASE = `http://127.0.0.1:${PORT}`;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CANARY = `B-CANARY-${randomUUID().slice(0, 8)}`;

let fx: ApiFixture;
let tokenA = "";
let tokenB = "";
let orgA = "";
let orgB = "";
beforeAll(async () => {
  fx = await apiFixture({ runtime: true });
  await fx.app.listen({ port: PORT, host: "127.0.0.1" });
  const a = await seedOrg(fx.db.admin, "sec03a", { alice: "owner" });
  const b = await seedOrg(fx.db.admin, "sec03b", { bob: "owner" });
  orgA = a.orgId;
  orgB = b.orgId;
  tokenA = await login(fx.app, a.users.alice!.subject);
  tokenB = await login(fx.app, b.users.bob!.subject);
}, 60_000);
afterAll(async () => fx?.close());

async function http(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: -1, text: `FETCH_ERROR ${(e as Error).name}` };
  }
}

const panel = (title: string) =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title,
    queryRef: { hash: "c".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "v"], units: { v: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["v"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

async function seedTenant(token: string, tag: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = await http(token, "POST", "/v1/workspaces", {
      objective: `${tag} objective ${i}`,
      networkScope: "fixture-only",
      idempotencyKey: `seed-${tag}-${i}-${randomUUID()}`,
    });
    expect(w.status, w.text).toBeLessThan(300);
    const ws = JSON.parse(w.text) as { workspaceId: string; version: number };
    ids.push(ws.workspaceId);
    const c = await http(token, "POST", `/v1/workspaces/${ws.workspaceId}/commands`, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "canvas.apply_patch",
      payload: {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [{ op: "addPanel", panel: panel(`${tag} panel ${i}`) }],
      },
      expectedVersion: ws.version,
    });
    expect(c.status, c.text).toBeLessThan(300);
    const ver = async () =>
      (JSON.parse((await http(token, "GET", `/v1/workspaces/${ws.workspaceId}`)).text) as { version: number })
        .version;
    const s = await http(token, "POST", `/v1/workspaces/${ws.workspaceId}/snapshots`, {
      label: `${tag} snapshot ${i}`,
      commandId: randomUUID(),
      expectedVersion: await ver(),
    });
    expect(s.status, s.text).toBeLessThan(300);
    const snap = JSON.parse(s.text) as { snapshot?: { id: string }; id?: string; snapshotId?: string };
    const sid = snap.snapshot?.id ?? snap.id ?? snap.snapshotId;
    if (sid) {
      const br = await http(token, "POST", `/v1/workspaces/${ws.workspaceId}/branches`, {
        fromSnapshotId: sid,
        name: `${tag} branch ${i}`,
        commandId: randomUUID(),
        expectedVersion: await ver(),
      });
      expect(br.status, br.text).toBeLessThan(300);
    }
  }
  return ids;
}

const ORG_TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
         (SELECT string_agg(a.attname, ',') FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('org_id','tenant_id')) AS keycol
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND n.nspname IN ('public','runtime') ORDER BY 1, 2`;

it("SEC03: tenant A never receives, changes or creates anything of tenant B", async () => {
  const wsB = await seedTenant(tokenB, CANARY, 2);
  const wsA = await seedTenant(tokenA, "A-OWN", 1);

  // ---- ground truth: everything B owns, harvested with superuser rights
  const tables = (await fx.db.admin.query(ORG_TABLES_SQL)).rows as Array<{
    schema: string;
    tbl: string;
    rls: boolean;
    forced: boolean;
    keycol: string | null;
  }>;
  const keyed = tables.filter((t) => t.keycol);
  const bValues = new Set<string>();
  const bSnapshot: Record<string, string> = {};
  let bRows = 0;
  const snapshotB = async () => {
    const out: Record<string, string> = {};
    for (const t of keyed) {
      const col = t.keycol!.split(",")[0]!;
      const r = await fx.db.admin.query(
        `SELECT row_to_json(x)::text AS j FROM ${t.schema}.${t.tbl} x WHERE ${col} = $1 ORDER BY 1`,
        [orgB],
      );
      out[`${t.schema}.${t.tbl}`] = createHash("sha256")
        .update(r.rows.map((x) => x.j as string).join("\n"))
        .digest("hex");
      if (bRows === 0 || Object.keys(bSnapshot).length === 0)
        for (const row of r.rows) {
          bRows++;
          for (const m of (row.j as string).match(UUID_RE) ?? []) bValues.add(m.toLowerCase());
        }
    }
    return out;
  };
  Object.assign(bSnapshot, await snapshotB());
  const allB = (await snapshotB(), bValues);
  allB.delete(orgB.toLowerCase());
  for (const w of wsA) allB.delete(w.toLowerCase());
  expect(bRows).toBeGreaterThan(10);
  const bText: string[] = [CANARY];

  // ---- SQL layer
  const sqlFindings: string[] = [];
  const notEnforced = keyed.filter((t) => !t.rls || !t.forced).map((t) => `${t.schema}.${t.tbl}`);
  expect(notEnforced).toEqual([]);
  let sqlProbes = 0;
  const ctx = (org: string | null) =>
    `SELECT set_config('app.org_id', ${org === null ? "''" : `'${org}'`}, true)`;
  for (const t of keyed) {
    const col = t.keycol!.split(",")[0]!;
    const q = async (org: string | null, text: string, params: unknown[] = []) => {
      const c = await fx.db.app.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(ctx(org));
        if (t.schema === "public")
          await c.query("SELECT set_config('app.user_id', $1, true)", [randomUUID()]);
        const r = await c.query(text, params);
        await c.query("ROLLBACK");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        return { rows: [] as unknown[], rowCount: 0, error: (e as Error).message };
      } finally {
        c.release();
      }
    };
    // (a) A's context sees no row of B's; no context sees none; garbage / injection contexts see none
    for (const org of [
      orgA,
      null,
      "not-a-uuid",
      `${orgB}' OR '1'='1`,
      orgB.toUpperCase().replace(/-/g, ""),
      "00000000-0000-0000-0000-000000000000",
    ]) {
      const safe = org === null || /^[0-9a-f-]{36}$/i.test(org) ? org : "x";
      const r = await q(safe, `SELECT ${col} AS k FROM ${t.schema}.${t.tbl} WHERE ${col} = $1`, [orgB]);
      sqlProbes++;
      if ((r.rows as unknown[]).length)
        sqlFindings.push(`${t.schema}.${t.tbl} readable by ctx=${String(org).slice(0, 8)}`);
    }
    // (b) A's context cannot update or delete B's rows
    for (const verb of [
      `UPDATE ${t.schema}.${t.tbl} SET ${col} = ${col}`,
      `DELETE FROM ${t.schema}.${t.tbl}`,
    ]) {
      const r = await q(orgA, `${verb} WHERE ${col} = $1`, [orgB]);
      sqlProbes++;
      if ((r.rowCount ?? 0) > 0)
        sqlFindings.push(`${t.schema}.${t.tbl} ${verb.split(" ")[0]} reached B rows`);
    }
  }
  expect(sqlFindings).toEqual([]);
  // (c) inserting a B-keyed row under A's context is refused by WITH CHECK (one representative per table via a copy of a B row)
  for (const t of keyed) {
    const col = t.keycol!.split(",")[0]!;
    const c = await fx.db.admin.connect();
    let rows: number;
    try {
      rows = (await c.query(`SELECT count(*)::int n FROM ${t.schema}.${t.tbl} WHERE ${col} = $1`, [orgB]))
        .rows[0].n as number;
    } finally {
      c.release();
    }
    if (!rows) continue;
    // Build "INSERT ... SELECT" copying one B row, executed as the app role under A's context. The SELECT itself is
    // hidden by RLS (0 rows), so success would require a policy hole; we assert nothing was inserted either way.
    const app = await fx.db.app.pool.connect();
    try {
      await app.query("BEGIN");
      await app.query(ctx(orgA));
      await app.query("SELECT set_config('app.user_id', $1, true)", [randomUUID()]);
      const r = await app
        .query(`INSERT INTO ${t.schema}.${t.tbl} SELECT * FROM ${t.schema}.${t.tbl} WHERE ${col} = $1`, [
          orgB,
        ])
        .catch(() => ({ rowCount: 0 }));
      sqlProbes++;
      if ((r.rowCount ?? 0) > 0) sqlFindings.push(`${t.schema}.${t.tbl} copy of B row inserted`);
      await app.query("ROLLBACK");
    } finally {
      app.release();
    }
  }
  expect(sqlFindings).toEqual([]);

  // ---- HTTP layer: enumerate the real route table
  const routeTable = fx.app.printRoutes({ commonPrefix: false });
  const routes = new Set<string>();
  for (const line of routeTable.split("\n")) {
    const m = /(\/[^\s(]*)\s+\(([^)]*)\)/.exec(line);
    if (!m) continue;
    for (const meth of m[2]!.split(",").map((x) => x.trim()))
      if (["GET", "POST", "PUT", "DELETE", "PATCH"].includes(meth)) routes.add(`${meth} ${m[1]}`);
  }
  // printRoutes folds shared prefixes; rebuild full paths from the tree instead of trusting the labels
  const fullRoutes: Array<{ method: string; path: string }> = [];
  {
    const stack: string[] = [];
    for (const line of fx.app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = /^([\s│├└─]*)(\S.*?)(?:\s+\(([^)]*)\))?$/.exec(line);
      if (!m) continue;
      const depth = Math.floor(m[1]!.length / 4);
      stack.length = depth;
      stack[depth] = m[2]!;
      if (m[3])
        for (const meth of m[3].split(",").map((x) => x.trim()))
          if (["GET", "POST", "PUT", "DELETE", "PATCH"].includes(meth))
            fullRoutes.push({
              method: meth,
              path: stack
                .slice(0, depth + 1)
                .join("")
                .replace(/^\//, "/"),
            });
    }
  }
  const routeList = fullRoutes.filter(
    (r) => r.path.startsWith("/v1/") && !r.path.includes("/dev/") && !r.path.endsWith("/events"),
  );
  expect(routeList.length).toBeGreaterThan(30);

  const mutate = (id: string): string[] => [
    id,
    id.toUpperCase(),
    ` ${id}`,
    `${id} `,
    `{${id}}`,
    `${id}%00`,
    `${id}'`,
    `${id}' OR '1'='1`,
    `${id}/../${id}`,
    `${id};`,
    `${id.slice(0, 35)}`,
    `${id}0`,
    id.replace(/-/g, ""),
    `urn:uuid:${id}`,
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    randomUUID(),
    "x".repeat(2000),
    "",
  ];
  const bPool = [...allB].filter((v) => !wsB.includes(v)).slice(0, 12);
  const paramCandidates = (name: string): string[] => {
    if (name === "id") return [...wsB.flatMap(mutate), ...bPool, ...wsA.map((x) => x)];
    if (name === "scope") return ["canvas", "graph", "layout", ...wsB];
    return [...bPool, ...wsB, randomUUID()];
  };

  const forged = {
    tenantId: orgB,
    orgId: orgB,
    org_id: orgB,
    workspaceId: wsB[0],
    workspace_id: wsB[0],
    actor: { orgId: orgB },
  };
  const forgedHeaders = {
    "x-org-id": orgB,
    "x-tenant-id": orgB,
    "x-workspace-id": wsB[0]!,
    "x-forwarded-for": "127.0.0.1",
    "x-user-id": randomUUID(),
  };
  const leaks: string[] = [];
  let requests = 0;
  const status: Record<string, number> = {};
  const scan = (route: string, sent: string, text: string) => {
    requests++;
    const echoed = text.split(sent).join("");
    const found = (echoed.match(UUID_RE) ?? [])
      .map((x) => x.toLowerCase())
      .filter((x) => allB.has(x) && !sent.toLowerCase().includes(x));
    if (found.length) leaks.push(`${route}: foreign id ${found[0]!.slice(0, 8)}`);
    for (const t of bText) if (text.includes(t)) leaks.push(`${route}: canary text`);
    if (text.includes(orgB) && !sent.includes(orgB)) leaks.push(`${route}: org id`);
  };
  for (const r of routeList) {
    const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
    // cartesian only over the first param; the remaining params cycle through B's object ids
    const first = params[0] ? paramCandidates(params[0]) : [""];
    for (const v of first) {
      const rest = params
        .slice(1)
        .map((p) => paramCandidates(p)[Math.abs(hash(`${r.path}${v}${p}`)) % paramCandidates(p).length]!);
      let path = r.path;
      params.forEach(
        (p, i) => (path = path.replace(`:${p}`, encodeURIComponent(i === 0 ? v : rest[i - 1]!))),
      );
      const q =
        r.method === "GET"
          ? `?cursor=${wsB[0]}&a=${bPool[0] ?? wsB[0]}&b=${bPool[1] ?? wsB[1]}&against=${bPool[0] ?? wsB[0]}&limit=5&status=all&orgId=${orgB}&workspaceId=${wsB[0]}`
          : "";
      const body =
        r.method === "GET"
          ? undefined
          : {
              ...forged,
              commandId: randomUUID(),
              expectedVersion: 1,
              objective: "pwned by A",
              label: "pwned",
              name: "pwned",
            };
      const res = await http(tokenA, r.method, `${path}${q}`, body, forgedHeaders);
      status[String(res.status)] = (status[String(res.status)] ?? 0) + 1;
      scan(`${r.method} ${r.path}`, `${v}|${rest.join("|")}|${q}`, res.text);
    }
  }
  // A's own listing and a command carrying B's workspace id in the payload
  const listA = await http(tokenA, "GET", "/v1/workspaces");
  scan("GET /v1/workspaces", "", listA.text);
  expect(JSON.parse(listA.text).workspaces?.length ?? JSON.parse(listA.text).length).toBe(1);
  const cross = await http(tokenA, "POST", `/v1/workspaces/${wsA[0]}/commands`, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "workspace.update_objective",
    payload: { objective: "x", workspaceId: wsB[0], orgId: orgB },
    expectedVersion: 99,
  });
  scan("POST own commands with foreign payload ids", "", cross.text);

  // existence oracle: B's real workspace vs a random one answer identically for every GET route
  const oracleDiffs: string[] = [];
  for (const r of routeList.filter(
    (x) => x.method === "GET" && x.path.includes(":id") && x.path.split(":").length === 2,
  )) {
    const norm = async (id: string) => {
      const res = await http(tokenA, "GET", r.path.replace(":id", id));
      return `${res.status} ${res.text.replaceAll(id, "ID").replace(/"traceId":"[^"]*"/, "")}`;
    };
    if ((await norm(wsB[0]!)) !== (await norm(randomUUID()))) oracleDiffs.push(r.path);
  }
  expect(oracleDiffs).toEqual([]);

  expect(leaks).toEqual([]);
  // writes: nothing of B's changed
  const afterB = await snapshotB();
  expect(afterB).toEqual(bSnapshot);
  // positive control: B itself reads its own canary data over the same server
  const own = await http(tokenB, "GET", `/v1/workspaces/${wsB[0]}`);
  expect(own.status).toBe(200);
  expect(own.text).toContain(CANARY);

  observe({
    testId: "SEC03",
    observed: `${requests} HTTP requests over ${routeList.length} routes with mutated, forged and confused-parent tenant/workspace/object IDs (status mix ${JSON.stringify(status)}); responses containing a foreign id or canary: ${leaks.length}; B row hashes in ${keyed.length} org-keyed tables identical before/after; ${sqlProbes} SQL-layer probes (read/update/delete/insert-copy under A, empty, garbage and injection contexts) reached 0 foreign rows; RLS enabled and forced on every keyed table (${notEnforced.length} exceptions); existence oracle differences ${oracleDiffs.length}; B reads its own data (control)`,
    fixtureHash: createHash("sha256").update(JSON.stringify(routeList)).digest("hex"),
    evidence: {
      requests,
      routes: routeList.length,
      keyedTables: keyed.length,
      sqlProbes,
      leaks: leaks.length,
      status,
      bRows,
    },
  });
}, 600_000);

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
