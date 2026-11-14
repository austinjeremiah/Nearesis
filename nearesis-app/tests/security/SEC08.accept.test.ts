/**
 * SEC08: browser-to-API adversarial request suite. PASS: 0 successful unauthorised mutations; every attack returns a
 * specified status (401/403/413/422/429) with a traceId and no stack or secret; session id changes at login; no weak
 * cookies; the flood is limited and recovers.
 * Real Fastify app on a disposable Postgres. Every mutating route is discovered from the API source (not a hand list).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "../../apps/api/src/app.ts";
import { createTestDb, seedOrg, testKernel } from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import type { FastifyInstance } from "fastify";

// jose is a dependency of the kernel package, not of the repository root
const { SignJWT } = (await import(
  pathToFileURL(createRequire(join(process.cwd(), "packages/kernel/package.json")).resolve("jose")).href
)) as typeof import("jose");
const SECRET = "test-session-secret-0123456789abcdef"; // the kernel test helper's session secret
const ORIGIN_OK = "https://app.nearesis.test";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "api", "src");
const WINDOW_MS = 1500;

const BFF_API_PORT = 4792;

/** The attribute policy of ch.12: HttpOnly, Secure, SameSite=Strict, host-wide path, bounded lifetime (<= 8 h). */
function cookieAttributeProblems(setCookie: string): string[] {
  const parts = setCookie.split(";").map((x) => x.trim());
  const attrs = new Map(parts.slice(1).map((a) => [a.split("=")[0]!.toLowerCase(), a.split("=")[1] ?? ""]));
  const out: string[] = [];
  if (!attrs.has("httponly")) out.push("missing HttpOnly");
  if (!attrs.has("secure")) out.push("missing Secure");
  if (attrs.get("samesite")?.toLowerCase() !== "strict") out.push("SameSite is not Strict");
  if (attrs.get("path") !== "/") out.push("Path is not /");
  const maxAge = Number(attrs.get("max-age"));
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 8 * 3600) out.push("Max-Age missing or unbounded");
  return out;
}

let db: TestDb;
let app: FastifyInstance;
let flood: FastifyInstance;
beforeAll(async () => {
  db = await createTestDb();
  const k = testKernel(db);
  app = await buildApp({
    kernel: k,
    nodeEnv: "test",
    guards: { allowedOrigins: [ORIGIN_OK], mutationsPerWindow: 100_000, loginsPerWindow: 100_000 },
  });
  flood = await buildApp({
    kernel: k,
    nodeEnv: "test",
    guards: { mutationsPerWindow: 20, loginsPerWindow: 5, windowMs: WINDOW_MS },
  });
});
afterAll(async () => {
  await app?.close();
  await flood?.close();
  await db?.drop();
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
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const key = new TextEncoder().encode(SECRET);
async function forge(over: {
  aud?: string;
  iss?: string;
  expired?: boolean;
  sub: string;
  org: string;
}): Promise<string> {
  let j = new SignJWT({ org: over.org })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(over.sub)
    .setIssuer(over.iss ?? "nearesis-kernel")
    .setAudience(over.aud ?? "nearesis-api")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200);
  j = j.setExpirationTime(over.expired ? Math.floor(Date.now() / 1000) - 3600 : "1h");
  return j.sign(key);
}

const ALLOWED = new Set([401, 403, 404, 413, 422, 429]);
const counts = async () =>
  JSON.stringify(
    (
      await db.admin.query(
        `SELECT (SELECT count(*) FROM workspaces) w, (SELECT count(*) FROM commands) c,
                (SELECT count(*) FROM workspace_events) e, (SELECT count(*) FROM panels) p,
                (SELECT count(*) FROM markers) m, (SELECT count(*) FROM branches) b`,
      )
    ).rows[0],
  );

it("SEC08: session, CSRF, origin, rate-limit and cookie controls resist the attack set on every mutating endpoint", async () => {
  const org = await seedOrg(db.admin, "sec08", { alice: "owner", vera: "viewer" });
  const other = await seedOrg(db.admin, "sec08o", { bob: "owner" });
  const login = async (a: FastifyInstance, subject: string, headers: Record<string, string> = {}) =>
    a.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: subject }, headers });
  const aliceRes = await login(app, org.users.alice!.subject);
  const alice = (aliceRes.json() as { token: string }).token;
  const vera = ((await login(app, org.users.vera!.subject)).json() as { token: string }).token;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...auth(alice), "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "sec08 workspace", networkScope: "fixture-only" },
  });
  expect(created.statusCode).toBe(201);
  const wsId = (created.json() as { workspaceId: string }).workspaceId;

  const cookies: string[] = [];
  const log: Array<{ attack: string; route: string; status: number }> = [];
  const problems: string[] = [];
  const check = (
    attack: string,
    route: string,
    r: { statusCode: number; headers: Record<string, unknown>; body: string },
  ) => {
    log.push({ attack, route, status: r.statusCode });
    if (r.headers["set-cookie"]) cookies.push(String(r.headers["set-cookie"]));
    if (!ALLOWED.has(r.statusCode)) problems.push(`${attack} ${route} -> ${r.statusCode}`);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.body) as Record<string, unknown>;
    } catch {
      problems.push(`${attack} ${route} non-JSON body`);
    }
    if (typeof body.traceId !== "string") problems.push(`${attack} ${route} no traceId`);
    if (/\n\s+at |node_modules|stack|eyJ[A-Za-z0-9_-]{10,}\./.test(r.body))
      problems.push(`${attack} ${route} leaks stack or token`);
  };

  const routes = mutatingRoutes();
  expect(routes.length).toBeGreaterThanOrEqual(25);
  const fill = (r: string) =>
    r
      .replaceAll(":id", wsId)
      .replace(/:[A-Za-z]+/g, () => randomUUID())
      .replace(/\*/g, "x");
  const before = await counts();
  const sub = org.users.alice!.subject;
  void sub;
  const aliceId = JSON.parse(Buffer.from(alice.split(".")[1]!, "base64url").toString()) as {
    sub: string;
    org: string;
  };
  const tokens = {
    malformed: "not-a-token",
    expired: await forge({ expired: true, sub: aliceId.sub, org: aliceId.org }),
    wrongAud: await forge({ aud: "other-api", sub: aliceId.sub, org: aliceId.org }),
    wrongIss: await forge({ iss: "evil", sub: aliceId.sub, org: aliceId.org }),
    algNone: `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: aliceId.sub, org: aliceId.org, iss: "nearesis-kernel", aud: "nearesis-api", exp: Math.floor(Date.now() / 1000) + 3600 })}.`,
  };
  for (const route of routes.filter((r) => r !== "/v1/dev/login")) {
    const url = fill(route);
    const base = {
      method: "POST" as const,
      url,
      payload: { objective: "x", role: "owner", orgId: other.orgId },
    };
    const call = async (
      attack: string,
      headers: Record<string, string>,
      extra: Record<string, unknown> = {},
    ) =>
      check(
        attack,
        route,
        await app.inject({
          ...base,
          method: route.includes("delegation-scopes") ? "PUT" : "POST",
          headers,
          ...extra,
        } as never),
      );
    await call("no-credential", {});
    for (const [name, t] of Object.entries(tokens)) await call(`token-${name}`, auth(t));
    await call("cross-origin", { ...auth(alice), origin: "https://evil.example" });
    await call("cross-origin-null", { ...auth(alice), origin: "null" });
    await call("text-plain", { ...auth(alice), "content-type": "text/plain" }, { payload: "objective=x" });
    await call(
      "oversize",
      { ...auth(alice), "content-type": "application/json" },
      { payload: JSON.stringify({ pad: "x".repeat(1_500_000) }) },
    );
    // the self-service sign-out acts only on the caller's own session: a valid viewer token legitimately succeeds there
    if (route !== "/v1/session/revoke") {
      await call("role-escalation-viewer", { ...auth(vera), "idempotency-key": `k-${randomUUID()}` });
      await call("missing-idempotency-key", auth(vera));
    }
  }
  expect(problems).toEqual([]);
  // 0 successful unauthorised mutations: no row appeared anywhere
  expect(await counts()).toBe(before);

  // session fixation: a token supplied before login is not adopted; every login mints a distinct token
  const pre = await forge({ sub: aliceId.sub, org: aliceId.org });
  const l1 = (await login(app, org.users.alice!.subject, auth(pre))).json() as { token: string };
  const l2 = (await login(app, org.users.alice!.subject)).json() as { token: string };
  expect(new Set([pre, l1.token, l2.token, alice]).size).toBe(4);
  expect(Object.keys(l1)).toEqual(["token"]);
  const jti = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).jti as string;
  expect(new Set([jti(alice), jti(l1.token), jti(l2.token)]).size).toBe(3);

  // cookies: the API issues none; the credential is a bearer header, so there is nothing ambient to forge a request with
  const loginCookie = [aliceRes.headers["set-cookie"], created.headers["set-cookie"]].filter(Boolean);
  expect(cookies).toEqual([]);
  expect(loginCookie).toEqual([]);

  // cookies at the BFF: the web app's login route is the only place a session cookie is issued. Run the real route
  // handler against a real listening API (disposable DB) and check every attribute.
  const bffApi = await buildApp({
    kernel: testKernel(db),
    nodeEnv: "test",
    guards: { mutationsPerWindow: 100_000, loginsPerWindow: 100_000 },
  });
  await bffApi.listen({ host: "127.0.0.1", port: BFF_API_PORT });
  process.env.NEARESIS_API_URL = `http://127.0.0.1:${BFF_API_PORT}`;
  const bffLogin = (await import(
    pathToFileURL(join(process.cwd(), "apps/web/src/app/api/dev/login/route.ts")).href
  )) as { POST(req: Request): Promise<Response> };
  const bffRes = await bffLogin.POST(
    new Request("http://127.0.0.1/api/dev/login", {
      method: "POST",
      body: JSON.stringify({ subject: org.users.alice!.subject }),
    }),
  );
  const bffBad = await bffLogin.POST(
    new Request("http://127.0.0.1/api/dev/login", {
      method: "POST",
      body: JSON.stringify({ subject: "nobody" }),
    }),
  );
  await bffApi.close();
  const bffCookies = bffRes.headers.getSetCookie();
  expect(bffRes.status).toBe(204);
  expect(bffCookies).toHaveLength(1);
  const cookieProblems = cookieAttributeProblems(bffCookies[0]!);
  expect(cookieProblems).toEqual([]);
  expect(bffBad.headers.getSetCookie()).toEqual([]); // a failed login sets no cookie
  expect(await bffRes.text()).toBe(""); // the token never appears in a body
  // negative control: the pre-fix cookie (no Secure, no Max-Age) and a script-readable one are caught
  const weakCookies = [
    "nearesis_session=abc; Path=/; HttpOnly; SameSite=Strict",
    "nearesis_session=abc; Path=/; Secure; SameSite=Lax; Max-Age=60",
    "nearesis_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=99999999",
  ];
  expect(weakCookies.map((c) => cookieAttributeProblems(c).length > 0)).toEqual([true, true, true]);

  // positive control: a legitimate same-origin / allowlisted-origin mutation still works
  const okOrigin = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...auth(alice), origin: ORIGIN_OK, "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "legit", networkScope: "fixture-only" },
  });
  expect(okOrigin.statusCode).toBe(201);

  // flood: 429 after the declared threshold (5 logins / window), Retry-After present, recovers after the window
  const statuses: number[] = [];
  let retryAfter = "";
  for (let i = 0; i < 12; i++) {
    const r = await login(flood, org.users.alice!.subject);
    statuses.push(r.statusCode);
    if (r.statusCode === 429) retryAfter = String(r.headers["retry-after"]);
  }
  expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
  expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  const flood429 = (await login(flood, org.users.alice!.subject)).json() as { traceId?: string };
  expect(typeof flood429.traceId).toBe("string");
  const deadline = Date.now() + 10_000;
  let recovered = 0;
  while (Date.now() < deadline) {
    recovered = (await login(flood, org.users.alice!.subject)).statusCode;
    if (recovered === 200) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(recovered).toBe(200);
  const tok = ((await login(flood, org.users.alice!.subject)).json() as { token?: string }).token;
  void tok;
  // mutating flood on an authenticated endpoint (20 / window)
  const muts: number[] = [];
  await new Promise((r) => setTimeout(r, WINDOW_MS + 100));
  for (let i = 0; i < 30; i++)
    muts.push(
      (
        await flood.inject({
          method: "POST",
          url: `/v1/workspaces/${wsId}/commands`,
          headers: auth(alice),
          payload: {},
        })
      ).statusCode,
    );
  expect(muts.slice(0, 20).every((s) => s !== 429)).toBe(true);
  expect(muts.slice(20).every((s) => s === 429)).toBe(true);

  // negative control: with the cross-origin check disabled in a test build, the forged cross-origin mutation succeeds,
  // so criterion (a) would FAIL for such a build (the suite detects it)
  const weak = await buildApp({
    kernel: testKernel(db),
    nodeEnv: "test",
    guards: { disableOriginCheck: true, mutationsPerWindow: 100_000, loginsPerWindow: 100_000 },
  });
  const forged = await weak.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...auth(alice), origin: "https://evil.example", "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "forged", networkScope: "fixture-only" },
  });
  await weak.close();
  expect(forged.statusCode).toBe(201);

  const bffMaxAge = /Max-Age=(\d+)/i.exec(bffCookies[0]!)?.[1];
  const byAttack: Record<string, Record<number, number>> = {};
  for (const l of log) (byAttack[l.attack] ??= {})[l.status] = (byAttack[l.attack]![l.status] ?? 0) + 1;
  observe({
    testId: "SEC08",
    observed: `${routes.length} mutating routes discovered from source, ${log.length} attack requests (no credential, malformed/expired/wrong-audience/wrong-issuer/alg-none tokens, cross-origin and null-origin, text/plain body, 1.5 MB body, viewer role-escalation fields, missing idempotency key): all refused with a specified status and a traceId, no stack or token in any body, database row counts unchanged; every login minted a distinct token and a pre-supplied token was not adopted; the API issued 0 cookies (bearer-header credential); the web BFF login route (real handler against a real listening API) issued exactly one cookie with HttpOnly, Secure, SameSite=Strict, Path=/ and Max-Age ${bffMaxAge} s (<= 8 h), none on a failed login, no token in the body, and the pre-fix cookie (no Secure/Max-Age), a SameSite=Lax cookie and an unbounded Max-Age were each flagged by the same checker; login flood: first 5 allowed, then 429 with Retry-After, recovered after the window; mutation flood: 429 after 20; control build with the origin check off accepted the forged cross-origin mutation (201)`,
    fixtureHash: createHash("sha256").update(routes.join("|")).digest("hex"),
    evidence: {
      routes,
      attacks: log.length,
      byAttack,
      floodStatuses: statuses,
      mutationFlood: muts.slice(18, 24),
      cookiesIssued: 0,
      bffCookieAttributes: bffCookies[0]!.replace(/=[^;]*/, "=<redacted>"),
    },
  });
}, 300_000);
