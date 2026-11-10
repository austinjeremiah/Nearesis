import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { RawObservation } from "@nearesis/contracts";
import { fixtureHash, readFixtureJson, readFixtureText } from "@nearesis/test-fixtures";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { OneClickQuoteSampler } from "../../src/adapters/oneclick.ts";
import { ALLOW_ONECLICK, HttpClient } from "../../src/http/client.ts";
import { CredentialSource } from "../../src/http/credentials.ts";
import { ExplorerFixtureServer, OneClickFixtureServer } from "../../src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// D14: Immutable content-addressed raw archive with complete source timestamps, secret-free
it("archives immutably by SHA-256, validates every envelope, and leaks no canary secret", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const canaryExplorer = `canary-jwt-${randomBytes(8).toString("hex")}`;
  const canaryOneClick = `canary-${randomBytes(8).toString("hex")}`;
  const creds = CredentialSource.fromMap({
    INTENTS_EXPLORER_JWT: canaryExplorer,
    INTENTS_1CLICK_JWT: canaryOneClick,
  });
  try {
    // Explorer pages through the real collector (HTTP layer attaches the canary Authorization header)
    const exServer = new ExplorerFixtureServer(env.clock, loadPages("fx.explorer.pages-3"));
    const exCollector = env.collector(exServer.fetchImpl, { credentials: creds });
    await exCollector.run();
    expect(exServer.requests.every((r) => r.hasAuthorization)).toBe(true); // the header really was sent
    // 1Click tokens + dry quote with the canary credential
    const ocServer = new OneClickFixtureServer(
      env.clock,
      readFixtureJson("fx.oneclick.tokens", "tokens.json"),
      () => ({
        status: 200,
        body: readFixtureText("fx.oneclick.quote-dry", "quote-ok.json"),
      }),
    );
    ocServer.intercept((r) => {
      expect(r.hasAuthorization).toBe(true);
      return undefined;
    });
    const sampler = new OneClickQuoteSampler({
      http: new HttpClient({
        allow: [ALLOW_ONECLICK],
        fetchImpl: ocServer.fetchImpl,
        credentials: creds,
        clock: env.clock,
      }),
      archive: env.archive,
      clock: env.clock,
      sourceEnvironment: "fixture_synthetic",
      credentialName: "INTENTS_1CLICK_JWT",
    });
    await sampler.fetchTokens();
    await sampler.attempt({
      routeId: "r",
      originAsset: "nep141:eth.omft.near",
      destinationAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      amountBaseUnits: "1000000000000000000",
      privacyMode: "public",
      scheduledBucketUTC: "2026-11-10T11:00:00.000Z",
      attemptNo: 1,
      recipient: "x.synthetic",
      refundTo: "y.synthetic",
      destDecimals: 6,
    });
    expect(creds.readCount).toBeGreaterThan(0);

    const objs = walk(join(env.tmp, "raw")).filter((p) => !p.endsWith(".tmp"));
    expect(objs.length).toBeGreaterThanOrEqual(5);
    // (a) key == sha256(bytes), 100%
    let matches = 0;
    for (const p of objs) if (p.split("/").at(-1) === sha(readFileSync(p))) matches++;
    expect(matches).toBe(objs.length);

    // (b) re-archive identical payload: no new object, same hash
    const any = await env.tdb.db.query<{ payload_object_hash: string }>(
      "SELECT payload_object_hash FROM ingestion.raw_observations LIMIT 1",
    );
    const h = any.rows[0]!.payload_object_hash;
    const bytes = await env.store.get(h);
    const again = await env.store.put(bytes);
    expect(again).toEqual({ hash: h, created: false });
    expect(walk(join(env.tmp, "raw")).filter((p) => !p.endsWith(".tmp")).length).toBe(objs.length);

    // (c) overwrite attempt with different bytes under the same key is rejected, original unchanged
    await expect(env.store.putAt(h, new TextEncoder().encode("tampered"))).rejects.toMatchObject({
      code: "ARCHIVE_IMMUTABLE",
    });
    expect(sha(await env.store.get(h))).toBe(h);

    // (d) every envelope validates (zod contract AND Bible JSON schema); timestamps present
    // vendored copy is the input; when the Bible is present locally, it must not have drifted
    const vendoredPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "contracts",
      "schemas",
      "raw_observation.schema.json",
    );
    const biblePath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "NEARESIS_Build_Bible",
      "schemas",
      "raw_observation.schema.json",
    );
    const vendoredText = readFileSync(vendoredPath, "utf8");
    if (existsSync(biblePath)) expect(vendoredText).toBe(readFileSync(biblePath, "utf8"));
    const schema = JSON.parse(vendoredText);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const rows = await env.tdb.db.query<{ envelope: unknown; request: unknown }>(
      "SELECT envelope, request FROM ingestion.raw_observations",
    );
    let valid = 0;
    for (const r of rows.rows) {
      const e = RawObservation.parse(r.envelope);
      const ok = validate(r.envelope);
      if (!ok) throw new Error(JSON.stringify(validate.errors));
      expect(e.fetchedAtUTC && e.receivedAtUTC).toBeTruthy();
      expect(e.providerEventAtUTC !== null || !!e.providerEventAtNullReason).toBe(true);
      expect(e.privacyVisibility).toBeTruthy();
      expect(e.completeness).toBeTruthy();
      valid++;
    }
    expect(valid).toBe(rows.rowCount);

    // (e) canary scan: archived bytes, metadata rows, trace events, logs, request log
    const trace = await env.tdb.db.query("SELECT detail FROM ingestion.trace_events");
    const haystacks: string[] = [
      ...objs.map((p) => readFileSync(p, "utf8")),
      JSON.stringify(rows.rows),
      JSON.stringify(trace.rows),
      logs.join("\n"),
      JSON.stringify(exCollector.backoffLog),
    ];
    let hits = 0;
    for (const hay of haystacks) {
      for (const c of [canaryExplorer, canaryOneClick]) if (hay.includes(c)) hits++;
      if (/authorization\s*[:=]/i.test(hay) || /bearer\s+[a-z0-9]/i.test(hay)) hits++;
    }
    expect(hits).toBe(0);
    observe({
      testId: "D14",
      observed: `${objs.length} objects: ${matches}/${objs.length} keys equal sha256(bytes); identical re-archive created 0 objects; overwrite rejected (ARCHIVE_IMMUTABLE) and original unchanged; ${valid}/${rows.rowCount} envelopes valid (zod + Bible JSON schema); canary/Authorization matches: ${hits}`,
      fixtureHash: fixtureHash("fx.explorer.pages-3"),
      evidence: {
        objects: objs.length,
        hashMatches: matches,
        reArchiveCreated: false,
        overwriteError: "ARCHIVE_IMMUTABLE",
        envelopesValid: valid,
        envelopesTotal: rows.rowCount,
        canaryHits: hits,
        credentialReads: creds.readCount,
      },
    });
  } finally {
    console.log = origLog;
  }
}, 120_000);
