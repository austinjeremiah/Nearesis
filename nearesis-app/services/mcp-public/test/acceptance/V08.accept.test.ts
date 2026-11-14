import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PUBLIC_TOOLS, RESTRICTED_TOOLS, startPublicMcpHttp } from "../../src/index.ts";
import type { Principal } from "../../src/index.ts";
import { connect, jsonOf, makeRoot, textOf, treeHash } from "../helpers.ts";

const FOREIGN: Principal = { id: "org:other/user:mallory", kind: "foreign" };
const MEMBER: Principal = { id: "org:acme/user:alice", kind: "member" };

/** V08 (ch.16): MCP foreign principal; public tools read only, restricted tools denied. */
it("V08: a foreign principal reads public tools only; restricted tools are denied; nothing is writable", async () => {
  const { root, capsuleId } = makeRoot();
  const before = treeHash(root);
  const calls: Array<{ tool: string; kind: string; outcome: string }> = [];
  const f = await connect(root, FOREIGN, (e) =>
    calls.push({ tool: e.tool, kind: e.principal.kind, outcome: e.outcome }),
  );

  // 1. the tool set is exactly the declared one and every tool is read-only
  const listed = (await f.client.listTools()).tools;
  expect(listed.map((t) => t.name).sort()).toEqual([...PUBLIC_TOOLS, ...RESTRICTED_TOOLS].sort());
  for (const t of listed) {
    expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    expect(t.annotations?.destructiveHint, t.name).toBe(false);
    expect(t.name).not.toMatch(
      /write|create|update|delete|submit|sign|send|transfer|execute|commit|mutat|query/i,
    );
  }

  // 2. public tools answer the foreign principal
  const arg = { capsuleId };
  const summary = jsonOf(await f.client.callTool({ name: "get_capsule_summary", arguments: arg }));
  expect(summary.label).toBe("SYNTHETIC");
  expect(
    (summary.verification as { local: { status: string }; outlayer: { status: string } }).local.status,
  ).toBe("reproduced");
  expect((summary.verification as { outlayer: { status: string } }).outlayer.status).toBe("not_submitted");
  expect(
    (jsonOf(await f.client.callTool({ name: "list_capsules", arguments: {} })).capsules as unknown[]).length,
  ).toBe(1);
  expect(
    (jsonOf(await f.client.callTool({ name: "get_claims", arguments: arg })).claims as unknown[]).length,
  ).toBeGreaterThan(3);
  expect(
    jsonOf(await f.client.callTool({ name: "get_result", arguments: { ...arg, resultId: "n" } })).value,
  ).toBe("90");
  expect(
    (jsonOf(await f.client.callTool({ name: "get_limitations", arguments: arg })).limitations as string[])
      .length,
  ).toBeGreaterThan(3);
  expect(
    String(
      jsonOf(await f.client.callTool({ name: "get_export", arguments: { ...arg, name: "THESIS.md" } })).text,
    ),
  ).toContain("## Claims");
  const ver = jsonOf(await f.client.callTool({ name: "verify_capsule_local", arguments: arg }));
  expect(ver).toMatchObject({ scope: "local", status: "reproduced" });

  // 3. restricted tools are denied with a structured error and leak no data
  const denied: string[] = [];
  for (const name of RESTRICTED_TOOLS) {
    const r = await f.client.callTool({
      name,
      arguments: name === "get_raw_snapshot_rows" ? { ...arg, limit: 5 } : arg,
    });
    expect(r.isError, name).toBe(true);
    expect(jsonOf(r)).toMatchObject({ errorCode: "FORBIDDEN", reasonCode: "RESTRICTED_TOOL" });
    expect(textOf(r)).not.toMatch(/intents_volume|2026-08-13|sha256|experimentId/);
    denied.push(name);
  }

  // 4. inputs cannot escape the capsule root
  for (const bad of [{ capsuleId: "../../etc" }, { capsuleId: "a/b" }, { capsuleId: ".." }]) {
    const r = await f.client
      .callTool({ name: "get_capsule_summary", arguments: bad })
      .catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
    expect(r.isError).toBe(true);
  }
  const badExport = await f.client.callTool({
    name: "get_export",
    arguments: { ...arg, name: "manifest.json" },
  });
  expect(badExport.isError).toBe(true);
  await f.close();

  // 5. positive control: a member gets restricted data, so the denial above is the policy and not a broken tool
  const m = await connect(root, MEMBER);
  const rows = jsonOf(
    await m.client.callTool({ name: "get_raw_snapshot_rows", arguments: { ...arg, limit: 3 } }),
  );
  expect((rows.rows as string[]).length).toBe(3);
  expect(
    jsonOf(await m.client.callTool({ name: "get_research_run", arguments: arg })).experimentId,
  ).toBeTruthy();
  await m.close();

  // 6. over real HTTP: bearer token decides the principal; no token is anonymous (denied); bad Host is refused
  const tokens: Record<string, Principal> = { "tok-foreign": FOREIGN, "tok-member": MEMBER };
  const srv = await startPublicMcpHttp({
    capsuleRoot: root,
    resolvePrincipal: (req) =>
      tokens[(req.headers.authorization ?? "").replace(/^Bearer /i, "")] ?? {
        id: "anonymous",
        kind: "anonymous",
      },
  });
  const httpCall = async (token: string | null, name: string, args: Record<string, unknown>) => {
    const c = new Client({ name: "http-test", version: "1.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${srv.port}/mcp`),
        token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {},
      ),
    );
    try {
      return await c.callTool({ name, arguments: args });
    } finally {
      await c.close();
    }
  };
  const hForeign = await httpCall("tok-foreign", "get_raw_snapshot_rows", arg);
  const hAnon = await httpCall(null, "get_research_run", arg);
  const hPublic = await httpCall("tok-foreign", "get_claims", arg);
  const hMember = await httpCall("tok-member", "get_raw_snapshot_rows", { ...arg, limit: 1 });
  expect(hForeign.isError).toBe(true);
  expect(hAnon.isError).toBe(true);
  expect(hPublic.isError).toBeFalsy();
  expect(hMember.isError).toBeFalsy();
  const hostStatus = await new Promise<number>((res, rej) => {
    const r = request(
      {
        host: "127.0.0.1",
        port: srv.port,
        path: "/mcp",
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json" },
      },
      (x) => res(x.statusCode ?? 0),
    );
    r.on("error", rej);
    r.end("{}");
  });
  expect(hostStatus).toBe(403);
  await srv.close();

  // 7. nothing on disk changed
  expect(treeHash(root)).toBe(before);
  expect(calls.filter((c) => c.outcome === "denied").map((c) => c.tool)).toEqual(denied);

  observe({
    testId: "V08",
    observed: `Foreign principal (in-memory and over HTTP): ${PUBLIC_TOOLS.length} public tools answered; ${RESTRICTED_TOOLS.length}/${RESTRICTED_TOOLS.length} restricted tools denied with FORBIDDEN/RESTRICTED_TOOL and no data; anonymous HTTP denied; all ${listed.length} tools readOnlyHint=true with no write-like names; path-escape ids and unknown export names rejected; member control reads restricted data; bad Host header 403; capsule directory hash unchanged.`,
    fixtureHash: before,
    evidence: {
      publicTools: [...PUBLIC_TOOLS],
      restrictedTools: [...RESTRICTED_TOOLS],
      deniedForForeign: denied,
      treeHashUnchanged: true,
    },
  });
}, 120_000);
