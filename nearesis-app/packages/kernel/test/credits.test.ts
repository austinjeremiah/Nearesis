import { afterAll, beforeAll, expect, it } from "vitest";
import { CreditsService, InsufficientCredits } from "../src/index.ts";
import { createTestDb, seedOrg } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let svc: CreditsService;
let ctx: { orgId: string; userId: string };
let other: { orgId: string; userId: string };
const NEAR = 10n ** 24n;
const ref = (id: string) => ({ refKind: "proof", refId: id });

beforeAll(async () => {
  db = await createTestDb();
  svc = new CreditsService(db.app);
  const a = await seedOrg(db.admin, "credits", { alice: "owner", bob: "owner" });
  ctx = { orgId: a.orgId, userId: a.users.alice!.userId };
  other = { orgId: a.orgId, userId: a.users.bob!.userId };
});
afterAll(async () => {
  await db?.drop();
});

it("reads zeros without an account row, then creates it lazily on the first topup", async () => {
  expect(await svc.account(ctx)).toEqual({ balanceYocto: 0n, heldYocto: 0n, availableYocto: 0n });
  expect(
    (await db.admin.query("SELECT 1 FROM credit_accounts WHERE user_id = $1", [ctx.userId])).rowCount,
  ).toBe(0);
  await svc.topup(ctx, 2n * NEAR, {
    txHash: "tx-1",
    signerAccountId: "a.testnet",
    receiverAccountId: "d.testnet",
  });
  expect((await svc.account(ctx)).balanceYocto).toBe(2n * NEAR);
});

it("a transaction hash is credited once, ever, even across users", async () => {
  const t = { txHash: "tx-1", signerAccountId: "a.testnet", receiverAccountId: "d.testnet" };
  await expect(svc.topup(ctx, NEAR, t)).rejects.toMatchObject({ reasonCode: "TOPUP_ALREADY_CREDITED" });
  await expect(svc.topup(other, NEAR, t)).rejects.toMatchObject({ reasonCode: "TOPUP_ALREADY_CREDITED" });
  expect((await svc.account(ctx)).balanceYocto).toBe(2n * NEAR);
});

it("hold, charge below the hold and release the rest are exact (bigint, 24-digit amounts)", async () => {
  const hold = 1_500_100_000_000_000_000_001n;
  await svc.hold(ctx, hold, ref("p1"));
  expect(await svc.account(ctx)).toMatchObject({ heldYocto: hold, availableYocto: 2n * NEAR - hold });
  const actual = 1_051_000_300_000_000_000_007n + 3n;
  const r = await svc.charge(ctx, hold, actual, ref("p1"));
  expect(r).toEqual({ chargedYocto: actual, releasedYocto: hold - actual, shortfallYocto: 0n });
  expect(await svc.account(ctx)).toEqual({
    balanceYocto: 2n * NEAR - actual,
    heldYocto: 0n,
    availableYocto: 2n * NEAR - actual,
  });
  const kinds = (await svc.entries(ctx)).map((e) => e.kind);
  expect(kinds.slice(0, 3)).toEqual(["release", "charge", "hold"]);
});

it("a full release returns the hold; a charge above hold and available is capped, never negative", async () => {
  const before = await svc.account(ctx);
  await svc.hold(ctx, NEAR / 2n, ref("p2"));
  await svc.release(ctx, NEAR / 2n, ref("p2"));
  expect(await svc.account(ctx)).toEqual(before);
  await svc.hold(ctx, 10n, ref("p3"));
  const r = await svc.charge(ctx, 10n, before.balanceYocto + 999n, ref("p3"));
  expect(r.chargedYocto).toBe(before.balanceYocto);
  expect(r.shortfallYocto).toBe(999n);
  expect(await svc.account(ctx)).toEqual({ balanceYocto: 0n, heldYocto: 0n, availableYocto: 0n });
});

it("two holds racing for the same credits cannot overdraw", async () => {
  await svc.topup(other, 5n * NEAR, {
    txHash: "tx-race",
    signerAccountId: "b.testnet",
    receiverAccountId: "d.testnet",
  });
  // 8 concurrent holds of 1 NEAR against 5 NEAR: exactly 5 succeed
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => svc.hold(other, NEAR, ref(`r${i}`))),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(failed).toHaveLength(3);
  for (const f of failed) expect(f.reason).toBeInstanceOf(InsufficientCredits);
  expect(await svc.account(other)).toEqual({
    balanceYocto: 5n * NEAR,
    heldYocto: 5n * NEAR,
    availableYocto: 0n,
  });
});

it("the database refuses a negative or over-held account even for direct writes", async () => {
  await expect(
    db.admin.query("UPDATE credit_accounts SET held_yocto = balance_yocto + 1 WHERE user_id = $1", [
      other.userId,
    ]),
  ).rejects.toThrow();
  await expect(
    db.admin.query("UPDATE credit_accounts SET balance_yocto = -1 WHERE user_id = $1", [other.userId]),
  ).rejects.toThrow();
});

it("credits are private to their owner (row level security)", async () => {
  expect((await svc.entries(ctx)).every((e) => e.refId !== "r0")).toBe(true);
  const rows = await db.app.tx(ctx, (tx) => tx.query("SELECT user_id FROM credit_accounts"));
  expect(rows.rows.map((r: { user_id: string }) => r.user_id)).toEqual([ctx.userId]);
});
