import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { KernelError } from "../../src/index.ts";
import { createTestDb, fx, makeManifest, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

it("K06: unsupported ABI is blocked with an upgrade reason", async () => {
  const k = testKernel(db);
  const v2 = makeManifest({
    pluginId: "fx-plugin-apiv2",
    version: "1.0.0",
    entrypoint: "apiv2.ts",
    apiVersion: 2,
  });
  let err: KernelError | undefined;
  try {
    await k.plugins.install(null, v2);
  } catch (e) {
    err = e as KernelError;
  }
  expect(err).toBeInstanceOf(KernelError);
  expect(err!.reasonCode).toBe("ABI_UNSUPPORTED");
  expect(err!.message).toMatch(/apiVersion 2/);
  expect(err!.message).toMatch(/[Uu]pgrade/);
  expect(fx().imports["fx-plugin-apiv2@1.0.0"] ?? 0).toBe(0);
  const rows = (await db.admin.query("SELECT count(*)::int n FROM plugin_installations")).rows[0].n;
  expect(rows).toBe(0);
  const audit = (
    await db.admin.query("SELECT reason_code FROM audit_events WHERE action='plugin.install_rejected'")
  ).rows;
  expect(audit.map((r) => r.reason_code)).toEqual(["ABI_UNSUPPORTED"]);

  // Schema conflict: manifest violating the contract (no rollbackStrategy) is rejected at install.
  let err2: KernelError | undefined;
  try {
    await k.plugins.install(
      null,
      makeManifest({ pluginId: "fx-plugin-ro", version: "1.0.0", entrypoint: "ro.ts", dropRollback: true }),
    );
  } catch (e) {
    err2 = e as KernelError;
  }
  expect(err2!.reasonCode).toBe("MANIFEST_INVALID");
  expect(err2!.message).toMatch(/rollbackStrategy/);

  // Control: apiVersion 1 installs.
  const ok = await k.plugins.install(
    null,
    makeManifest({ pluginId: "fx-plugin-ro", version: "1.0.0", entrypoint: "ro.ts" }),
  );
  expect(ok.apiVersion).toBe(1);

  observe({
    testId: "K06",
    observed: `apiVersion=2 manifest blocked: reasonCode=${err!.reasonCode}, message="${err!.message}"; entrypoint never imported; no installation row; audit reason ABI_UNSUPPORTED; manifest without rollbackStrategy rejected (${err2!.reasonCode}); apiVersion=1 control installed`,
    evidence: {
      reasonCode: err!.reasonCode,
      message: err!.message,
      negativeRollbackStrategy: err2!.reasonCode,
      supportedApiVersions: [1],
    },
  });
});
