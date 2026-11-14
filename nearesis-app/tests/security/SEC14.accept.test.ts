/**
 * SEC14: verification state cannot be forged. PASS: every attempt by an owner, an editor, an agent or a plugin service
 * identity to set a verified state (service API, database function, direct SQL, every mutating HTTP route with verified
 * claims in the body) is denied and audited; a replayed valid evidence record bound to another response fails the binding
 * check; a hand-edited or hand-inserted row is detected at publication and the gate refuses; publication without a
 * verifier result carries the visible `unverified` label and no path yields a verified badge.
 * Real kernel and Postgres (disposable), real Fastify API, real capsule verification.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Principal } from "../../packages/contracts/src/index.ts";
import { buildApp } from "../../apps/api/src/app.ts";
import { buildCapsule, loadCapsuleView, verifyCapsule } from "../../packages/capsule/src/index.ts";
import { VerifiedStateService, REQUIRED_CHECKS } from "../../packages/kernel/src/index.ts";
import type { RecordInput, VerifierResult } from "../../packages/kernel/src/index.ts";
import { newWs, world } from "../../packages/kernel/test/history/helpers.ts";
import type { World } from "../../packages/kernel/test/history/helpers.ts";

const ROOT = process.cwd();
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "api", "src");
let w: World;
const tmp: string[] = [];
beforeAll(async () => {
  w = await world("sec14");
}, 120_000);
afterAll(async () => {
  await w?.db.drop();
  tmp.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const goodResult = (bound: string): VerifierResult => ({
  status: "verified",
  checks: REQUIRED_CHECKS.map((name) => ({ name, passed: true })),
  boundResponseSha256: bound,
});

function mutatingRoutes(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const m of text.matchAll(/\.(?:post|put|patch|delete)\s*(?:<[^(]*?>)?\(\s*["`]([^"`]+)["`]/g))
      out.add(m[1]!);
  }
  return [...out].sort();
}

const VERIFIED_CLAIMS = {
  verified: true,
  status: "verified",
  verifiedLevel: "verified",
  attestation: { status: "verified", evidenceSource: "live", jobId: "j-1", reason: null },
  verification: { local: { status: "reproduced" }, outlayer: { status: "verified" } },
  confidenceTier: "verified",
  data: { verified: true, attestation: { status: "verified" } },
};

it("SEC14: only a verifier can set a verified state; forged, replayed and hand-edited states never publish as verified", async () => {
  const key = randomBytes(24).toString("hex");
  const svc = new VerifiedStateService(w.db.app, key);
  const ws = (await newWs(w)).workspaceId;
  const verifierId = randomUUID();
  await w.db.admin.query("INSERT INTO verifier_identities(actor_id, name) VALUES ($1,'sec14-verifier')", [
    verifierId,
  ]);
  const orgId = w.orgA.orgId;
  const principals: Record<string, Principal> = {
    owner: w.owner.principal,
    editor: w.analyst.principal,
    agent: { kind: "agent", actorId: randomUUID(), orgId, parentRunId: randomUUID() },
    pluginService: { kind: "service", actorId: randomUUID(), orgId },
  };
  const verifier: Principal = { kind: "service", actorId: verifierId, orgId };
  const resp1 = sha("response-1");
  const input = (ref: string, bound = resp1, result?: VerifierResult): RecordInput => ({
    workspaceId: ws,
    subjectKind: "inference_response",
    subjectRef: ref,
    responseSha256: resp1,
    result: result ?? goodResult(bound),
  });
  const count = async (sql = "SELECT count(*)::int n FROM verification_states") =>
    Number((await w.db.admin.query(sql)).rows[0].n);

  // ---- (a) every non-verifier attempt, through every path available to each principal
  const denials: Array<{ principal: string; path: string; outcome: string }> = [];
  const auditBefore = await count(
    "SELECT count(*)::int n FROM audit_events WHERE action = 'verified_state.denied'",
  );
  let serviceAttempts = 0;
  for (const [name, p] of Object.entries(principals)) {
    // 1. the service API with a fully valid verified result
    serviceAttempts++;
    const e1 = await svc.record(p, input(`subject-${name}`)).then(
      () => "ACCEPTED",
      (e) => `${(e as { code: string }).code}/${(e as { reasonCode: string }).reasonCode}`,
    );
    denials.push({ principal: name, path: "service.record", outcome: e1 });
    expect(e1).toBe("FORBIDDEN/NOT_A_VERIFIER");
    // 2. the database function, bypassing the service layer
    const ctx = { orgId, userId: p.actorId, actorKind: p.kind };
    const e2 = await w.k.db
      .tx(ctx, (tx) =>
        tx.query("SELECT verified_state_record($1,$2,$3,'capsule',$4,'verified',NULL,$5,$6,now())", [
          randomUUID(),
          orgId,
          ws,
          `direct-${name}`,
          resp1,
          "a".repeat(64),
        ]),
      )
      .then(
        () => "ACCEPTED",
        (e) => (e as { code?: string }).code ?? "error",
      );
    denials.push({ principal: name, path: "db.function", outcome: e2 });
    expect(e2).toBe("42501");
    // 3. direct SQL on the table
    for (const [verb, sql] of [
      [
        "insert",
        `INSERT INTO verification_states(id, org_id, workspace_id, subject_kind, subject_ref, state, response_sha256, verifier_id, row_hmac) VALUES (gen_random_uuid(), '${orgId}', '${ws}', 'capsule', 'x', 'verified', '${resp1}', '${verifierId}', '${"b".repeat(64)}')`,
      ],
      ["update", "UPDATE verification_states SET state = 'verified'"],
      ["delete", "DELETE FROM verification_states"],
    ] as const) {
      const e3 = await w.k.db
        .tx(ctx, (tx) => tx.query(sql))
        .then(
          () => "ACCEPTED",
          (e) => (e as { code?: string }).code ?? "error",
        );
      denials.push({ principal: name, path: `sql.${verb}`, outcome: e3 });
      expect(e3).toBe("42501");
    }
  }
  expect(await count()).toBe(0);
  const auditAfter = await count(
    "SELECT count(*)::int n FROM audit_events WHERE action = 'verified_state.denied'",
  );
  expect(auditAfter - auditBefore).toBe(serviceAttempts); // every refused service attempt is audited

  // ---- HTTP: every mutating route, owner and editor, bodies that claim verified state
  const app = await buildApp({
    kernel: w.k,
    nodeEnv: "test",
    guards: { mutationsPerWindow: 100_000, loginsPerWindow: 100_000 },
  });
  const login = async (subject: string) =>
    (
      (
        await app.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: subject } })
      ).json() as { token: string }
    ).token;
  const tokens = {
    owner: await login(w.orgA.users.alice!.subject),
    editor: await login(w.orgA.users.ann!.subject),
  };
  const routes = mutatingRoutes();
  expect(routes.some((r) => /verif/i.test(r))).toBe(false); // no route exists whose job is to write verification state
  const http: Array<{ who: string; route: string; status: number }> = [];
  for (const [who, token] of Object.entries(tokens))
    for (const route of routes) {
      if (route.includes("/session/revoke") || route === "/v1/dev/login") continue;
      const url = route
        .replace(/:workspaceId|:id|:wsId|:workspace/g, ws)
        .replace(/:[A-Za-z]+/g, randomUUID())
        .replace(/\*/g, "x");
      const r = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": `k-${randomUUID()}`,
          origin: "http://localhost",
        },
        payload: { ...VERIFIED_CLAIMS, expectedVersion: 1, objective: "x", networkScope: "fixture-only" },
      });
      http.push({ who, route, status: r.statusCode });
    }
  await app.close();
  expect(await count()).toBe(0); // no HTTP attempt created any verification state
  expect(
    await count(
      "SELECT count(*)::int n FROM audit_events WHERE action LIKE 'verified_state.%' AND outcome = 'ok'",
    ),
  ).toBe(0);

  // ---- the verifier's own results (positive control) and the states they may produce
  const ok = await svc.record(verifier, input("good"));
  expect(ok.state).toBe("verified");
  const dev = await svc.record(
    verifier,
    input("dev", resp1, { ...goodResult(resp1), status: "unattested_dev" }),
  );
  const unsupported = await svc.record(
    verifier,
    input("unsup", resp1, { ...goodResult(resp1), status: "unsupported" }),
  );
  const partial = await svc.record(
    verifier,
    input("partial", resp1, { ...goodResult(resp1), checks: goodResult(resp1).checks.slice(0, 3) }),
  );
  const failedCheck = await svc.record(
    verifier,
    input("failedcheck", resp1, {
      status: "verified",
      checks: REQUIRED_CHECKS.map((name, i) => ({ name, passed: i !== 0 })),
      boundResponseSha256: resp1,
    }),
  );
  expect([dev.state, unsupported.state, partial.state, failedCheck.state]).toEqual([
    "unverified",
    "unverified",
    "failed",
    "failed",
  ]);

  // ---- (b) replayed valid evidence bound to another response
  const replay = await svc.record(verifier, { ...input("replayed"), responseSha256: sha("response-2") }).then(
    () => "ACCEPTED",
    (e) => (e as { reasonCode: string }).reasonCode,
  );
  expect(replay).toBe("RESPONSE_BINDING_MISMATCH");
  expect(await count("SELECT count(*)::int n FROM verification_states WHERE subject_ref = 'replayed'")).toBe(
    0,
  );

  // ---- (c)(d) the publication gate
  const gate = (ref: string) => svc.gate(w.owner, ws, "inference_response", ref);
  const gates = {
    good: await gate("good"),
    dev: await gate("dev"),
    unsup: await gate("unsup"),
    partial: await gate("partial"),
    failedcheck: await gate("failedcheck"),
    noRow: await gate("never-verified"),
  };
  expect(gates.good.badge.label).toBe("verified");
  expect(gates.good.verifierId).toBe(verifierId);
  for (const k of ["dev", "unsup", "noRow"] as const) {
    expect(gates[k].publishable).toBe(true);
    expect(gates[k].badge.label).toBe("unverified");
    expect(gates[k].badge.text).toBe("Unverified");
  }
  expect([gates.partial.badge.label, gates.failedcheck.badge.label]).toEqual(["failed", "failed"]);

  // hand-edited row: unverified/failed rows edited to verified, a forged verified row inserted outside the verifier path
  await w.db.admin.query("UPDATE verification_states SET state = 'verified' WHERE subject_ref = 'dev'");
  await w.db.admin.query(
    "UPDATE verification_states SET state = 'verified', reason = NULL WHERE subject_ref = 'partial'",
  );
  await w.db.admin.query(
    `INSERT INTO verification_states(id, org_id, workspace_id, subject_kind, subject_ref, state, response_sha256, verifier_id, row_hmac)
     VALUES (gen_random_uuid(), $1, $2, 'inference_response', 'forged-insert', 'verified', $3, $4, $5)`,
    [orgId, ws, resp1, verifierId, "c".repeat(64)],
  );
  const refused: Record<string, string> = {};
  for (const ref of ["dev", "partial", "forged-insert"])
    refused[ref] = await gate(ref).then(
      (g) => `PUBLISHED:${g.badge.label}`,
      (e) => (e as { reasonCode: string }).reasonCode,
    );
  expect(refused).toEqual({
    dev: "integrity_error",
    partial: "integrity_error",
    "forged-insert": "integrity_error",
  });
  expect((await gate("good")).badge.label).toBe("verified"); // untouched rows are not collateral damage
  expect(
    await count(
      "SELECT count(*)::int n FROM integrity_quarantine WHERE artefact_class = 'evidence_item' AND ref LIKE 'verification:%'",
    ),
  ).toBe(3);
  // a service without the key cannot mint or accept anything (fail closed)
  const keyless = new VerifiedStateService(w.db.app, undefined);
  expect(
    await keyless.record(verifier, input("nokey")).then(
      () => "ACCEPTED",
      (e) => (e as { reasonCode: string }).reasonCode,
    ),
  ).toBe("VERIFIED_STATE_UNAVAILABLE");

  // ---- the capsule's own stored attestation field cannot be hand-edited to "verified"
  const capDir = mkdtempSync(join(tmpdir(), "sec14-cap-"));
  tmp.push(capDir);
  const dir = join(capDir, "c");
  buildCapsule({ snapshotDir: join(ROOT, "packages/capsule/fixtures/snapshot-synthetic"), outDir: dir });
  const clean = await verifyCapsule(dir, { research: "skip", wasm: "skip" });
  const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    attestation: { status: string; reason: string | null };
  };
  expect(mf.attestation.status).toBe("unverified");
  mf.attestation = { ...mf.attestation, status: "verified", reason: null };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(mf));
  const edited = await verifyCapsule(dir, { research: "skip", wasm: "skip" });
  const editedView = await loadCapsuleView(dir, { research: "skip", wasm: "skip" });
  expect(clean.reportStatus).toBe("VERIFIED_LOCAL");
  expect(edited.reportStatus).toBe("UNVERIFIED");
  expect(edited.failures.map((f) => f.kind)).toContain("CAPSULE_HASH_MISMATCH");
  expect(editedView?.verification.outlayer.status).not.toBe("verified");

  // ---- negative control: a handler that wrote `verified` from a request body would be refused by the database
  const naive = await w.k.db
    .tx({ orgId, userId: w.owner.userId, actorKind: "human" }, (tx) =>
      tx.query(
        "INSERT INTO verification_states(id, org_id, workspace_id, subject_kind, subject_ref, state, response_sha256, verifier_id, row_hmac) VALUES ($1,$2,$3,'capsule','body',$4,$5,$6,$7)",
        [randomUUID(), orgId, ws, "verified", resp1, verifierId, "d".repeat(64)],
      ),
    )
    .then(
      () => "ACCEPTED",
      (e) => (e as { code?: string }).code,
    );
  expect(naive).toBe("42501");

  const verifiedBadges = Object.entries({ ...gates })
    .filter(([, g]) => g.badge.label === "verified")
    .map(([k]) => k);
  expect(verifiedBadges).toEqual(["good"]);
  const byStatus: Record<number, number> = {};
  for (const h of http) byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
  observe({
    testId: "SEC14",
    observed: `4 non-verifier principals (owner, editor, agent, plugin service identity) x 5 paths (service.record with a fully valid verified result, the verified_state_record database function, and direct INSERT/UPDATE/DELETE on verification_states): 20 of 20 denied (FORBIDDEN/NOT_A_VERIFIER or Postgres 42501), ${serviceAttempts} service attempts audited as verified_state.denied; ${http.length} HTTP attempts (${routes.length} mutating routes discovered from source, none verification-related, as owner and editor, bodies claiming verified / attestation.status=verified / verifiedLevel) created 0 verification states (statuses ${JSON.stringify(byStatus)}); verifier results: complete checks -> verified, unattested_dev and unsupported -> unverified, missing or failed check -> failed; replayed evidence bound to a different response refused RESPONSE_BINDING_MISMATCH with 0 rows; hand-edited rows (unverified->verified, failed->verified) and a hand-inserted verified row all refused at the gate with integrity_error (3 quarantined), the untouched verified row still published; publication without a verifier result is publishable only as "Unverified"; exactly 1 of ${Object.keys(gates).length} gate outcomes carries a verified badge (the verifier-written one); capsule manifest hand-edited to attestation.status=verified: verifyCapsule UNVERIFIED with CAPSULE_HASH_MISMATCH and the viewer's outlayer status is not verified; control: a handler writing verified from a request body is refused by the database (42501)`,
    fixtureHash: sha("sec14-v1"),
    evidence: {
      denials,
      httpStatuses: byStatus,
      routes: routes.length,
      refused,
      gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.badge.label])),
      replay,
      editedCapsule: edited.failures.map((f) => f.kind),
    },
  });
}, 600_000);
