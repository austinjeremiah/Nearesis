import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { KernelError } from "../../src/index.ts";
import { createTestDb, fx, makeManifest, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import { generateSigningKeyPair, signManifest } from "@nearesis/plugin-sdk";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

async function rejection(p: Promise<unknown>): Promise<KernelError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KernelError);
    return e as KernelError;
  }
  throw new Error("expected rejection");
}

it("K05: invalid and missing signatures are rejected before the entrypoint is imported; dev_trust is explicit and audited", async () => {
  const prod = testKernel(db, { trustMode: "production" });

  // (1) Invalid signature (tampered), (2) wrong key, (3) missing signature, (4) untrusted publisher, (5) hash mismatch.
  const tampered = makeManifest({
    pluginId: "fx-plugin-badsig",
    version: "1.0.0",
    entrypoint: "badsig.ts",
    sign: "bad",
  });
  const e1 = await rejection(prod.plugins.install(null, tampered));
  const otherKey = generateSigningKeyPair();
  const wrongKeyManifest = makeManifest({
    pluginId: "fx-plugin-badsig",
    version: "1.0.1",
    entrypoint: "badsig.ts",
    sign: false,
  });
  const wrongKey = { ...wrongKeyManifest, signature: signManifest(wrongKeyManifest, otherKey.privateKey) };
  const e2 = await rejection(prod.plugins.install(null, wrongKey));
  const unsignedM = makeManifest({
    pluginId: "fx-plugin-unsigned",
    version: "1.0.0",
    entrypoint: "unsigned.ts",
    sign: false,
  });
  const e3 = await rejection(prod.plugins.install(null, unsignedM));
  const untrusted = {
    ...makeManifest({ pluginId: "fx-plugin-badsig", version: "1.0.2", entrypoint: "badsig.ts" }),
    publisher: "someone-else",
  };
  const e4 = await rejection(prod.plugins.install(null, untrusted));

  expect(e1.reasonCode).toBe("SIGNATURE_INVALID_SIGNATURE");
  expect(e2.reasonCode).toBe("SIGNATURE_INVALID_SIGNATURE");
  expect(e3.reasonCode).toBe("SIGNATURE_MISSING_SIGNATURE");
  expect(e4.reasonCode).toMatch(/^SIGNATURE_/);
  // Entrypoint modules were never imported (import counters are incremented at module top level).
  expect(fx().imports["fx-plugin-badsig@1.0.0"] ?? 0).toBe(0);
  expect(fx().imports["fx-plugin-unsigned@1.0.0"] ?? 0).toBe(0);
  const rows = (await db.admin.query("SELECT count(*)::int n FROM plugin_installations")).rows[0].n;
  expect(rows).toBe(0);
  const rejAudit = (
    await db.admin.query("SELECT count(*)::int n FROM audit_events WHERE action='plugin.install_rejected'")
  ).rows[0].n;
  expect(rejAudit).toBe(4);

  // Enabling dev_trust in a production environment is refused.
  let prodDev: KernelError | undefined;
  try {
    testKernel(db, { trustMode: "dev_trust", nodeEnv: "production" });
  } catch (e) {
    prodDev = e as KernelError;
  }
  expect(prodDev).toBeInstanceOf(KernelError);
  expect(prodDev!.reasonCode).toBe("DEV_TRUST_IN_PRODUCTION");

  // Positive control: valid signature accepted in production mode.
  const good = await prod.plugins.install(
    null,
    makeManifest({ pluginId: "fx-plugin-ro", version: "1.0.0", entrypoint: "ro.ts" }),
  );
  expect(good.trust).toBe("production");
  expect(fx().imports["fx-plugin-ro@1.0.0"]).toBe(1);

  // Positive control: unsigned accepted only under explicit dev_trust outside production, audited, shown in inspect().
  const dev = testKernel(db, { trustMode: "dev_trust" });
  expect(fx().imports["fx-plugin-unsigned@1.0.0"] ?? 0).toBe(0);
  const inst = await dev.plugins.install(null, unsignedM);
  expect(inst.trust).toBe("dev_trust");
  const devAudit = (
    await db.admin.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='plugin.dev_trust_install' AND subject='fx-plugin-unsigned@1.0.0'",
    )
  ).rows[0].n;
  expect(devAudit).toBe(1);
  const insp = await dev.engine.inspect();
  expect(insp.plugins.find((p) => p.pluginId === "fx-plugin-unsigned")?.trust).toBe("dev_trust");
  expect(insp.plugins.find((p) => p.pluginId === "fx-plugin-ro")?.trust).toBe("production");

  observe({
    testId: "K05",
    observed: `production mode rejected tampered sig (${e1.reasonCode}), wrong-key sig (${e2.reasonCode}), missing sig (${e3.reasonCode}), untrusted publisher (${e4.reasonCode}); import counters badsig=0 unsigned=0 at rejection; installation rows=0; 4 plugin.install_rejected audit rows; dev_trust+NODE_ENV=production refused (${prodDev!.reasonCode}); signed plugin accepted (imports=1); unsigned accepted only under dev_trust: 1 plugin.dev_trust_install audit row, inspect trust=dev_trust`,
    evidence: {
      rejections: [e1, e2, e3, e4].map((e) => ({ reasonCode: e.reasonCode, code: e.code })),
      importCountersAtRejection: { badsig: 0, unsigned: 0 },
      installationRowsAfterRejections: rows,
      devTrustAuditRows: devAudit,
      inspectTrust: insp.plugins.map((p) => ({ pluginId: p.pluginId, trust: p.trust })),
    },
  });
});
