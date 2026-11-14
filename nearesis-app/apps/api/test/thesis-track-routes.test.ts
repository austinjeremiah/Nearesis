import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let tok: string;
const dir = mkdtempSync(join(tmpdir(), "thesis-api-"));
const get = (url: string, t = tok) => f.app.inject({ method: "GET", url, headers: t ? bearer(t) : {} });

beforeAll(async () => {
  process.env.NEARESIS_THESIS_DIR = dir;
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "orgt", { owner: "owner" });
  tok = await login(f.app, a.users.owner!.subject);
});
afterAll(async () => {
  delete process.env.NEARESIS_THESIS_DIR;
  await f.close();
});

describe("thesis track routes", () => {
  it("requires a session", async () => {
    expect((await get("/v1/thesis", "")).statusCode).toBe(401);
    expect((await get("/v1/thesis/files/TABLES.md", "")).statusCode).toBe(401);
  });
  it("answers 503 THESIS_NOT_BUILT before the build exists", async () => {
    const r = await get("/v1/thesis");
    expect(r.statusCode).toBe(503);
    expect(JSON.stringify(r.json())).toContain("THESIS_NOT_BUILT");
  });
  it("serves thesis.json exactly and allowlisted files with content types", async () => {
    mkdirSync(join(dir, "build", "site"), { recursive: true });
    mkdirSync(join(dir, "raw"), { recursive: true });
    mkdirSync(join(dir, "sql", "executed"), { recursive: true });
    const body = '{\n  "schema": "nearesis.thesis.v1"\n}\n';
    writeFileSync(join(dir, "build", "thesis.json"), body);
    writeFileSync(join(dir, "build", "THESIS.md"), "# T\n");
    writeFileSync(join(dir, "build", "site", "index.html"), "<p>x</p>");
    writeFileSync(join(dir, "raw", "a.json"), "{}");
    writeFileSync(join(dir, "sql", "executed", "a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "TABLES.md"), "# Tables\n");
    writeFileSync(join(dir, "secret.txt"), "no");
    const j = await get("/v1/thesis");
    expect(j.statusCode).toBe(200);
    expect(j.body).toBe(body);
    expect(j.headers["content-type"]).toContain("application/json");
    const md = await get("/v1/thesis/files/build/THESIS.md");
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.headers["x-content-type-options"]).toBe("nosniff");
    const h = await get("/v1/thesis/files/build/site/index.html");
    expect(h.headers["content-type"]).toContain("text/html");
    expect(h.headers["content-security-policy"]).toContain("sandbox");
    expect((await get("/v1/thesis/files/sql/executed/a.sql")).headers["content-type"]).toContain(
      "text/plain",
    );
    expect((await get("/v1/thesis/files/raw/a.json")).statusCode).toBe(200);
    expect((await get("/v1/thesis/files/TABLES.md")).statusCode).toBe(200);
  });
  it("serves an archived version under archive/<id>/ and the fee raw files, nothing else under archive", async () => {
    const a = join(dir, "archive", "intents-vs-price-v1");
    mkdirSync(join(a, "build", "site"), { recursive: true });
    mkdirSync(join(a, "raw"), { recursive: true });
    mkdirSync(join(a, "sql", "bigquery"), { recursive: true });
    mkdirSync(join(dir, "raw", "fees"), { recursive: true });
    writeFileSync(join(a, "build", "THESIS.md"), "# old\n");
    writeFileSync(join(a, "build", "thesis.json"), "{}");
    writeFileSync(join(a, "build", "site", "index.html"), "<p>old</p>");
    writeFileSync(join(a, "raw", "x.json"), "{}");
    writeFileSync(join(a, "sql", "bigquery", "q.sql"), "SELECT 1;");
    writeFileSync(join(a, "TABLES.md"), "# old tables\n");
    writeFileSync(join(a, "private.txt"), "no");
    writeFileSync(join(dir, "raw", "fees", "manifest.json"), "{}");
    for (const p of [
      "archive/intents-vs-price-v1/build/THESIS.md",
      "archive/intents-vs-price-v1/build/thesis.json",
      "archive/intents-vs-price-v1/build/site/index.html",
      "archive/intents-vs-price-v1/raw/x.json",
      "archive/intents-vs-price-v1/sql/bigquery/q.sql",
      "archive/intents-vs-price-v1/TABLES.md",
      "raw/fees/manifest.json",
    ])
      expect((await get(`/v1/thesis/files/${p}`)).statusCode, p).toBe(200);
    for (const p of [
      "archive/intents-vs-price-v1/private.txt",
      "archive/../secret.txt",
      "archive/x/../../secret.txt",
    ])
      expect((await get(`/v1/thesis/files/${p}`)).statusCode, p).toBe(404);
  });
  it("rejects traversal and files outside the allowlist", async () => {
    for (const p of [
      "secret.txt",
      "../secret.txt",
      "build/../secret.txt",
      "..%2fsecret.txt",
      "raw/..%2f..%2fsecret.txt",
      "build/other.md",
      "raw/missing.json",
      "%2e%2e/etc/passwd",
    ]) {
      expect((await get(`/v1/thesis/files/${p}`)).statusCode).toBe(404);
    }
  });
});
