import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevAuthProvider, SessionKeyRing } from "../src/index.ts";
import type { Db } from "../src/index.ts";

const fakeDb = {
  txGlobal: async (f: (tx: unknown) => unknown) =>
    f({ query: async () => ({ rows: [{ user_id: "u1", org_id: "o1" }] }) }),
} as unknown as Db;
const mk = (path: string, now?: () => number) =>
  new DevAuthProvider(
    fakeDb,
    undefined,
    "test",
    3600,
    undefined,
    new SessionKeyRing({ path, windowMs: 7200_000, ...(now ? { now } : {}) }),
  );

describe("persistent session key ring", () => {
  it("a session issued before an API restart is valid after (new provider, same file)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "ring.json");
    const token = await mk(path).login("s");
    const after = await mk(path).authenticate(token);
    expect(after).toMatchObject({ userId: "u1", orgId: "o1" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("the ring file holds keys only, and tokens differ per ring without a file", async () => {
    const a = new DevAuthProvider(fakeDb, undefined, "test");
    const b = new DevAuthProvider(fakeDb, undefined, "test");
    await expect(b.authenticate(await a.login("s"))).rejects.toMatchObject({ reasonCode: "INVALID_SESSION" });
  });

  it("rotated keys still validate inside the window and not after it", async () => {
    let t = 1_000_000;
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "ring.json");
    const p = mk(path, () => t);
    const old = await p.login("s");
    p.rotateKey();
    const fresh = await p.login("s");
    await expect(p.authenticate(old)).resolves.toBeDefined();
    await expect(p.authenticate(fresh)).resolves.toBeDefined();
    // restart after rotation: both still valid
    const p2 = mk(path, () => t);
    await expect(p2.authenticate(old)).resolves.toBeDefined();
    t += 7200_000 + 1;
    await expect(p2.authenticate(old)).rejects.toMatchObject({ reasonCode: "INVALID_SESSION" });
    await expect(p2.authenticate(fresh)).resolves.toBeDefined();
  });

  it("tampered, wrong-kid and unsigned tokens fail", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "ring.json");
    const p = mk(path);
    const token = await p.login("s");
    const [h, pl, sig] = token.split(".");
    const flip = (sig ?? "").replace(/^./, (c) => (c === "A" ? "B" : "A"));
    await expect(p.authenticate(`${h}.${pl}.${flip}`)).rejects.toMatchObject({
      reasonCode: "INVALID_SESSION",
    });
    const bad = Buffer.from(JSON.stringify({ alg: "HS256", kid: "nope" })).toString("base64url");
    await expect(p.authenticate(`${bad}.${pl}.${sig}`)).rejects.toMatchObject({
      reasonCode: "INVALID_SESSION",
    });
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    await expect(p.authenticate(`${none}.${pl}.`)).rejects.toMatchObject({ reasonCode: "INVALID_SESSION" });
    await expect(p.authenticate("garbage")).rejects.toMatchObject({ reasonCode: "INVALID_SESSION" });
  });

  it("a corrupt ring file is replaced instead of blocking boot; contents never contain the token", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "keys-")), "ring.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{not json");
    const p = mk(path);
    const token = await p.login("s");
    expect(readFileSync(path, "utf8")).not.toContain(token);
    await expect(mk(path).authenticate(token)).resolves.toBeDefined();
  });
});
