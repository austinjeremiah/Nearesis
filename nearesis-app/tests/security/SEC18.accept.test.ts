/**
 * SEC18: SSRF breadth. PASS: 0 connections reach any canary server; every URL is refused before connect with a
 * reason code; redirects and the second DNS resolution are re-validated; 10 legitimate allowlisted URLs succeed.
 * Features under test: the plugin egress proxy (guardedFetch), the third-party MCP endpoint registration, and the public
 * MCP gateway's request screen. Canary TCP servers listen on loopback (IPv4 and IPv6); a metadata address cannot be
 * bound locally, so it is proven by the absence of any dial or resolver call for IP literals.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { EgressDenied, McpEndpointPolicy, guardedFetch, vetUrl } from "../../packages/kernel/src/index.ts";
import { screenRequest } from "../../services/mcp-public/src/gateway.ts";
import { createTestDb, loginSession, seedOrg, testKernel } from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";

let c4: net.Server;
let c6: net.Server | null = null;
let hits = 0;
let p4 = 0;
let p6 = 0;
let good: http.Server;
let goodPort = 0;
let redirector: http.Server;
let redirectorPort = 0;
let redirectTarget = "";
let db: TestDb;
beforeAll(async () => {
  const count = (s: net.Socket) => {
    hits++;
    s.destroy();
  };
  c4 = net.createServer(count);
  await new Promise<void>((r) => c4.listen(0, "127.0.0.1", r));
  p4 = (c4.address() as AddressInfo).port;
  c6 = net.createServer(count);
  try {
    await new Promise<void>((res, rej) => {
      c6!.once("error", rej);
      c6!.listen(0, "::1", res);
    });
    p6 = (c6.address() as AddressInfo).port;
  } catch {
    c6 = null;
  }
  good = http.createServer((_q, res) => res.end("ok"));
  await new Promise<void>((r) => good.listen(0, "127.0.0.1", r));
  goodPort = (good.address() as AddressInfo).port;
  redirector = http.createServer((_q, res) => {
    res.statusCode = 302;
    res.setHeader("location", redirectTarget);
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  redirectorPort = (redirector.address() as AddressInfo).port;
  db = await createTestDb();
});
afterAll(async () => {
  for (const s of [c4, c6, good, redirector]) s?.close();
  await db?.drop();
});

const PUB = "feeds.example.org";
const PUB_IP = "93.184.216.34";

it("SEC18: 60+ SSRF encodings, redirects and rebinding tricks across three features are refused before connect", async () => {
  const flips = new Map<string, number>();
  const resolveMap: Record<string, string[]> = {
    [PUB]: [PUB_IP],
    "rebind.example.org": ["127.0.0.1"],
    "mixed.example.org": [PUB_IP, "169.254.169.254"],
    "v6.example.org": ["::1"],
    "mapped.example.org": ["::ffff:7f00:1"],
    "cname-internal.example.org": ["10.1.2.3"],
  };
  const dials: string[] = [];
  const lookups: string[] = [];
  const deps = {
    resolve: async (h: string) => {
      lookups.push(h);
      if (h === "flip.example.org") {
        const n = (flips.get(h) ?? 0) + 1;
        flips.set(h, n);
        return n === 1 ? [PUB_IP] : ["127.0.0.1"]; // flips to loopback on the second resolution
      }
      const r = resolveMap[h];
      if (!r) throw new Error("NXDOMAIN");
      return r;
    },
    onDial: (ip: string) => dials.push(ip),
    dialOverride: (ip: string, p: number) =>
      ip === PUB_IP ? { ip: "127.0.0.1", port: goodPort } : { ip, port: p },
  };
  const hosts = [
    PUB,
    ...Object.keys(resolveMap),
    "flip.example.org",
    "metadata.google.internal",
    "localhost",
    "127.0.0.1",
    "169.254.169.254",
    "[::1]",
    "0.0.0.0",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "[fd00:ec2::254]",
    "[::ffff:169.254.169.254]",
  ];
  const policy = { allowHosts: hosts, allowInsecureHttp: true, timeoutMs: 2000 };

  const urls: string[] = [
    // IPv4 encodings of the metadata address and loopback
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/",
    "http://0xA9FEA9FE/",
    "http://0251.0376.0251.0376/",
    "http://169.254.43518/",
    "http://0xA9.0xFE.0xA9.0xFE/",
    "http://169.254.169.254.:80/",
    `http://127.0.0.1:${p4}/`,
    `http://127.1:${p4}/`,
    `http://2130706433:${p4}/`,
    `http://0x7f000001:${p4}/`,
    `http://0177.0.0.1:${p4}/`,
    `http://017700000001:${p4}/`,
    `http://0.0.0.0:${p4}/`,
    `http://localhost:${p4}/`,
    `http://LOCALHOST.:${p4}/`,
    `http://foo.localhost:${p4}/`,
    `http://metadata.google.internal/computeMetadata/v1/`,
    "http://100.100.100.200/latest/meta-data/",
    "http://169.254.170.2/v2/credentials",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://100.64.0.1/",
    // IPv6 forms
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[fe80::1]/",
    `http://[::ffff:127.0.0.1]:${p4}/`,
    `http://[0:0:0:0:0:ffff:7f00:1]:${p4}/`,
    "http://[::]/",
    ...(p6 ? [`http://[::1]:${p6}/`, `http://[0:0:0:0:0:0:0:1]:${p6}/`] : ["http://[::1]:9/"]),
    // userinfo confusion and fragments
    `http://${PUB}@127.0.0.1:${p4}/`,
    `http://${PUB}:80@127.0.0.1:${p4}/`,
    `http://127.0.0.1:${p4}#@${PUB}/`,
    `http://127.0.0.1:${p4}\\@${PUB}/`,
    `http://user:pass@${PUB}/`,
    `http://${PUB}%2f@127.0.0.1:${p4}/`,
    // schemes
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "ftp://127.0.0.1/",
    "data:text/plain,hi",
    "javascript:alert(1)",
    "ws://127.0.0.1/",
    "dict://127.0.0.1:11211/stat",
    // DNS-named internals and rebinding
    `http://rebind.example.org:${p4}/`,
    `http://mixed.example.org/`,
    `http://v6.example.org:${p6 || 9}/`,
    `http://mapped.example.org:${p4}/`,
    `http://cname-internal.example.org/`,
    `http://flip.example.org:${p4}/`,
    // port tricks and malformed
    "http://127.0.0.1:0/",
    "http://127.0.0.1:65536/",
    "http://:80/",
    "http:///",
    "http://[/",
    "",
    "//127.0.0.1/",
    "http://exa mple.org/",
  ];
  expect(urls.length).toBeGreaterThanOrEqual(58);
  const redirectTargets = [
    "http://169.254.169.254/latest/meta-data/",
    `http://127.0.0.1:${p4}/`,
    `http://localhost:${p4}/`,
    "http://[::ffff:a9fe:a9fe]/",
    "http://2852039166/",
  ];

  const decisions: Array<{ feature: string; url: string; code: string }> = [];
  const dialsBefore = dials.length;
  // feature 1: the egress proxy, with an allowlist that names every host (the validator itself must be the barrier)
  for (const u of urls) {
    const code = await vetUrl(u, policy, deps).then(
      () => "ALLOWED",
      (e) => (e instanceof EgressDenied ? e.reasonCode : `ERROR:${String(e).slice(0, 60)}`),
    );
    decisions.push({ feature: "egress", url: u, code });
  }
  // redirects re-validated hop by hop (fetch path)
  for (const t of redirectTargets) {
    redirectTarget = t;
    const code = await guardedFetch(`http://${PUB}/start`, {}, policy, {
      ...deps,
      dialOverride: (ip, p) => (ip === PUB_IP ? { ip: "127.0.0.1", port: redirectorPort } : { ip, port: p }),
    }).then(
      () => "ALLOWED",
      (e) => (e instanceof EgressDenied ? e.reasonCode : `ERROR:${String(e).slice(0, 60)}`),
    );
    decisions.push({ feature: "egress-redirect", url: t, code });
  }
  // the second resolution: the guard pins the first (vetted) answer, so the flip to loopback is never dialled
  flips.clear();
  const flipUrl = "http://flip.example.org/";
  const flipRes = await guardedFetch(flipUrl, {}, policy, deps).then(
    (r) => `served-${r.status}`,
    (e) => (e instanceof EgressDenied ? e.reasonCode : "ERROR"),
  );
  // feature 2: MCP endpoint registration (a review is recorded for each URL that parses, so only vetting can refuse it)
  const k = testKernel(db);
  const org = await seedOrg(db.admin, "sec18", { alice: "owner" });
  const alice = await loginSession(k, org.users.alice!.subject);
  const mcp = new McpEndpointPolicy(k.db, deps);
  // (the flip host is excluded: registration only resolves once and never connects; the connect path is tested above)
  for (const u of urls.filter((x) => /^https?:/.test(x) && !x.includes("flip.example.org"))) {
    try {
      new URL(u);
    } catch {
      continue;
    }
    const https = u.replace(/^http:/, "https:");
    await mcp.recordReview(alice, { endpoint: https, approvedScopes: ["read"], reference: "SEC18" });
    const code = await mcp.register(alice, { endpoint: https, requestedScopes: ["read"] }).then(
      () => "ALLOWED",
      (e) => (e as { reasonCode?: string }).reasonCode ?? "ERROR",
    );
    decisions.push({ feature: "mcp-register", url: https, code });
  }
  // feature 3: the public MCP gateway never accepts a URL, host or endpoint from the client
  const screenCodes: string[] = [];
  for (const u of urls.slice(0, 20)) {
    for (const field of ["url", "baseUrl", "host", "endpoint", "uri", "origin"]) {
      const r = screenRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task_status", arguments: { runId: "r1", [field]: u } },
      });
      screenCodes.push(r.ok ? "ALLOWED" : "REFUSED");
    }
  }

  // control: 10 legitimate allowlisted URLs succeed (no blanket block hides the test)
  const legit: string[] = [];
  for (let i = 0; i < 10; i++) {
    const res = await guardedFetch(`http://${PUB}/ok/${i}`, {}, policy, deps).then(
      (r) => r.status,
      () => 0,
    );
    legit.push(String(res));
  }
  // negative control: a validator that checks only the first resolution, then connects through a resolver that flips
  const naiveHit = await (async () => {
    const answers = [[PUB_IP], ["127.0.0.1"]];
    let call = 0;
    const first = answers[call++]!;
    expect(first.every((ip) => !ip.startsWith("127."))).toBe(true); // "validated": public
    await new Promise<void>((resolve) => {
      const req = http.get(
        {
          host: "flip.example.org",
          port: p4,
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            const address = answers[Math.min(call++, 1)]![0]!;
            if (o.all) cb(null, [{ address, family: 4 }]);
            else cb(null, address, 4);
          }) as never,
          timeout: 1500,
        },
        () => resolve(),
      );
      req.on("error", () => resolve());
      req.on("timeout", () => req.destroy());
    });
    for (let i = 0; i < 40 && hits === 0; i++) await new Promise((r) => setTimeout(r, 25));
    return hits;
  })();

  const allowed = decisions.filter((d) => d.code === "ALLOWED" || d.code.startsWith("ERROR"));
  const nonReason = decisions.filter(
    (d) => !d.code.startsWith("EGRESS_") && !d.code.startsWith("MCP_") && d.code !== "ALLOWED",
  );
  expect(allowed).toEqual([]);
  expect(nonReason).toEqual([]);
  expect(screenCodes.every((c) => c === "REFUSED")).toBe(true);
  expect(dials.slice(dialsBefore).every((ip) => ip === PUB_IP)).toBe(true); // only the public control host was ever dialled
  expect(flipRes).toBe("served-200"); // pinned first answer: served by the public stand-in, never the loopback canary
  expect(legit.every((s) => s === "200")).toBe(true);
  // (a) the guarded phases touched no canary; only the deliberately naive control did
  expect(naiveHit).toBeGreaterThan(0);
  expect(naiveHit).toBe(hits);
  const byFeature: Record<string, number> = {};
  for (const d of decisions) byFeature[d.feature] = (byFeature[d.feature] ?? 0) + 1;
  observe({
    testId: "SEC18",
    observed: `${urls.length} URLs (decimal/octal/hex/dotted-hex IPv4, IPv4-mapped/NAT64/6to4/ULA IPv6, userinfo and fragment confusion, non-HTTP schemes, DNS names resolving to loopback/private/mixed, port and syntax tricks) plus ${redirectTargets.length} redirect targets through the egress proxy and the MCP endpoint registration (${decisions.length} decisions: ${JSON.stringify(byFeature)}): all refused before connect with a reason code; public MCP gateway screen refused ${screenCodes.length}/${screenCodes.length} URL-bearing requests; the host that flips to loopback on its second resolution was served from the pinned first answer (${flipRes}) and never dialled at loopback; dials made: only the public control address; guarded-phase canary connections 0; 10/10 legitimate allowlisted fetches ok; control validator checking only the first resolution connected to the canary (${naiveHit})`,
    fixtureHash: createHash("sha256").update(JSON.stringify(urls)).digest("hex"),
    evidence: {
      urls: urls.length,
      decisions: decisions.length,
      byFeature,
      flipRes,
      legit: legit.length,
      naiveHit,
      lookups: lookups.length,
    },
  });
}, 300_000);
