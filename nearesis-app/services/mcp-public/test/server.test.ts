import { expect, it } from "vitest";
import { RESTRICTED_TOOLS } from "../src/index.ts";
import { connect, jsonOf, makeRoot } from "./helpers.ts";

it("anonymous is treated like a foreign principal: restricted tools are denied, unknown capsules are NOT_FOUND", async () => {
  const { root, capsuleId } = makeRoot();
  const c = await connect(root, { id: "anonymous", kind: "anonymous" });
  for (const name of RESTRICTED_TOOLS) {
    const r = await c.client.callTool({ name, arguments: { capsuleId } });
    expect(jsonOf(r)).toMatchObject({ errorCode: "FORBIDDEN" });
  }
  const r = await c.client.callTool({ name: "get_claims", arguments: { capsuleId: "nope" } });
  expect(jsonOf(r)).toMatchObject({ errorCode: "NOT_FOUND" });
  await c.close();
});

it("a tampered capsule is reported as mismatch through the public summary", async () => {
  const { root, capsuleId } = makeRoot();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(root, capsuleId, "snapshot", "raw", "daily_series.csv"), "date,a\n");
  const c = await connect(root, { id: "x", kind: "foreign" });
  const s = jsonOf(await c.client.callTool({ name: "get_capsule_summary", arguments: { capsuleId } }));
  expect((s.verification as { local: { status: string } }).local.status).toBe("mismatch");
  await c.close();
});
