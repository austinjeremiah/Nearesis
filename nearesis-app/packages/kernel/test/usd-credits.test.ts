import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CreditsExhausted,
  UsdCreditsService,
  microToUsd,
  toErrorResponse,
  usdNumberToMicro,
  usdStringToMicro,
  yoctoToMicroUsd,
} from "../src/index.ts";
import { createTestDb, seedOrg } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let svc: UsdCreditsService;
let a: { orgId: string; userId: string };
let b: { orgId: string; userId: string };
let c: { orgId: string; userId: string };
const THREE = 3_000_000n;
const ref = (id: string, category: "model" | "outlayer" | "anchor" = "outlayer") => ({
  refKind: "proof",
  refId: id,
  category,
});

beforeAll(async () => {
  db = await createTestDb();
  svc = new UsdCreditsService(db.app, { allowanceMicro: THREE });
  const o = await seedOrg(db.admin, "usd-credits", { alice: "owner", bob: "owner", carol: "owner" });
  a = { orgId: o.orgId, userId: o.users.alice!.userId };
  b = { orgId: o.orgId, userId: o.users.bob!.userId };
  c = { orgId: o.orgId, userId: o.users.carol!.userId };
});
afterAll(async () => {
  await db?.drop();
});

it("converts micro-USD and NEAR amounts exactly, rounding charges up", () => {
  expect(usdStringToMicro("3")).toBe(3_000_000n);
  expect(usdStringToMicro("0.0000001")).toBe(1n);
  expect(usdNumberToMicro(0.0123456)).toBe(12_346n);
  expect(microToUsd(2_970_000n)).toBe("2.970000");
  // 0.0027 NEAR at USD 3.5 = USD 0.00945
  expect(yoctoToMicroUsd(2_700_000_000_000_000_000_000n, "3.5")).toBe(9_450n);
  expect(yoctoToMicroUsd(1n, "3.5")).toBe(1n);
  expect(yoctoToMicroUsd(0n, "3.5")).toBe(0n);
});

it("grants the allowance on first use (also on a plain read), exactly once", async () => {
  expect(
    (await db.admin.query("SELECT 1 FROM usd_credit_accounts WHERE user_id = $1", [a.userId])).rowCount,
  ).toBe(0);
  expect(await svc.account(a)).toEqual({
    grantedMicro: THREE,
    spentMicro: 0n,
    heldMicro: 0n,
    availableMicro: THREE,
  });
  await svc.account(a);
  const e = await svc.entries(a);
  expect(e).toHaveLength(1);
  expect(e[0]).toMatchObject({ kind: "grant", category: "grant", amountMicro: THREE });
});

it("hold, charge below the hold and release the rest are exact", async () => {
  await svc.hold(a, 100_000n, ref("p1"));
  expect(await svc.account(a)).toMatchObject({ heldMicro: 100_000n, availableMicro: THREE - 100_000n });
  const r = await svc.settle(a, 100_000n, 37_001n, ref("p1"));
  expect(r).toEqual({ chargedMicro: 37_001n, releasedMicro: 62_999n, shortfallMicro: 0n, duplicate: false });
  expect(await svc.account(a)).toEqual({
    grantedMicro: THREE,
    spentMicro: 37_001n,
    heldMicro: 0n,
    availableMicro: THREE - 37_001n,
  });
  expect((await svc.entries(a)).map((x) => x.kind).slice(0, 3)).toEqual(["release", "charge", "hold"]);
  const s = await svc.summary(a);
  expect(s.byCategoryMicro).toEqual({ model: 0n, outlayer: 37_001n, anchor: 0n });
});

it("a charge is idempotent per (ref kind, ref id, category) and a different category is a separate charge", async () => {
  const r1 = await svc.charge(a, 5_000n, { refKind: "run", refId: "run-1", category: "model" });
  const r2 = await svc.charge(a, 5_000n, { refKind: "run", refId: "run-1", category: "model" });
  expect(r1.duplicate).toBe(false);
  expect(r2.duplicate).toBe(true);
  await svc.charge(a, 1_000n, { refKind: "run", refId: "run-1", category: "anchor" });
  expect((await svc.account(a)).spentMicro).toBe(37_001n + 5_000n + 1_000n);
});

it("a charge never drives available below zero: the excess is the shortfall", async () => {
  const before = await svc.account(a);
  const r = await svc.charge(a, before.availableMicro + 999n, {
    refKind: "run",
    refId: "run-big",
    category: "model",
  });
  expect(r.chargedMicro).toBe(before.availableMicro);
  expect(r.shortfallMicro).toBe(999n);
  expect(await svc.account(a)).toMatchObject({ availableMicro: 0n, spentMicro: THREE });
  const e = (await svc.entries(a))[0]!;
  expect(e.detail).toMatchObject({ shortfallMicro: "999" });
});

it("the gate refuses at zero and below a required amount, with the 402 body details", async () => {
  await expect(svc.require(a)).rejects.toBeInstanceOf(CreditsExhausted);
  await svc.account(b);
  await expect(svc.require(b)).resolves.toMatchObject({ availableMicro: THREE });
  await expect(svc.require(b, THREE + 1n)).rejects.toMatchObject({ reasonCode: "CREDITS_EXHAUSTED" });
  const err = await svc.require(a).catch((x) => x);
  const { status, body } = toErrorResponse(err, "t1");
  expect(status).toBe(402);
  expect(body).toMatchObject({
    errorCode: "BUDGET_EXCEEDED",
    reasonCode: "CREDITS_EXHAUSTED",
    message: "You have used your credits. Write to connect@kaushikh.xyz to request more access.",
  });
  expect(body.details).toEqual({
    allowanceUsd: "3.000000",
    spentUsd: "3.000000",
    availableUsd: "0.000000",
    requiredUsd: null,
    contactEmail: "connect@kaushikh.xyz",
  });
});

it("two holds racing for the same credits cannot overdraw", async () => {
  // 8 concurrent holds of USD 1 against USD 3: exactly 3 succeed
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => svc.hold(c, 1_000_000n, ref(`race-${i}`))),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  for (const f of results.filter((r) => r.status === "rejected") as PromiseRejectedResult[])
    expect(f.reason).toBeInstanceOf(CreditsExhausted);
  expect(await svc.account(c)).toEqual({
    grantedMicro: THREE,
    spentMicro: 0n,
    heldMicro: THREE,
    availableMicro: 0n,
  });
});

it("concurrent first use grants once and concurrent identical charges apply once", async () => {
  const o = await seedOrg(db.admin, "usd-credits-2", { dave: "owner" });
  const d = { orgId: o.orgId, userId: o.users.dave!.userId };
  const rs = await Promise.all(
    Array.from({ length: 6 }, () =>
      svc.charge(d, 10_000n, { refKind: "run", refId: "same", category: "model" }),
    ),
  );
  expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(await svc.account(d)).toMatchObject({ grantedMicro: THREE, spentMicro: 10_000n });
  expect((await svc.entries(d)).filter((e) => e.kind === "grant")).toHaveLength(1);
});

it("the database refuses an overdrawn account even for direct writes, and credits are private (RLS)", async () => {
  await expect(
    db.admin.query("UPDATE usd_credit_accounts SET held_micro = granted_micro + 1 WHERE user_id = $1", [
      b.userId,
    ]),
  ).rejects.toThrow();
  await expect(
    db.admin.query("UPDATE usd_credit_accounts SET spent_micro = -1 WHERE user_id = $1", [b.userId]),
  ).rejects.toThrow();
  const rows = await db.app.tx(b, (tx) => tx.query("SELECT user_id FROM usd_credit_accounts"));
  expect(rows.rows.map((r: { user_id: string }) => r.user_id)).toEqual([b.userId]);
});

it("reconcileRuns reports nothing when the runtime schema does not exist", async () => {
  expect(await svc.reconcileRuns()).toEqual({ charged: 0 });
  expect(await svc.reconcileRuns(a.userId)).toEqual({ charged: 0 });
});
