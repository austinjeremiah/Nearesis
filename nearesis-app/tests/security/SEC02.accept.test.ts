/**
 * SEC02: SSRF into the metadata address. PASS: blocked before any outbound connection.
 * Local only. Canary servers on 127.0.0.1 / ::1 count every accepted TCP connection; a metadata-style address cannot
 * be bound on this host, so loopback canaries stand in for "internal" targets and the metadata addresses themselves
 * are proven blocked by the absence of any dial (hook) and any DNS lookup for IP literals.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { EgressDenied, guardedFetch, nonPublicReason } from "../../packages/kernel/src/egress.ts";

let canary4: net.Server;
let canary6: net.Server | null = null;
let hits = 0;
let port4 = 0;
let port6 = 0;
let redirector: http.Server;
let redirectorPort = 0;
let redirectTarget = "";
beforeAll(async () => {
  const count = (s: net.Socket) => {
    hits++;
    s.destroy();
  };
  canary4 = net.createServer(count);
  await new Promise<void>((r) => canary4.listen(0, "127.0.0.1", r));
  port4 = (canary4.address() as AddressInfo).port;
  canary6 = net.createServer(count);
  try {
    await new Promise<void>((res, rej) => {
      canary6!.once("error", rej);
      canary6!.listen(0, "::1", res);
    });
    port6 = (canary6.address() as AddressInfo).port;
  } catch {
    canary6 = null; // no IPv6 loopback on this host
  }
  redirector = http.createServer((_q, res) => {
    res.statusCode = 302;
    res.setHeader("location", redirectTarget);
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  redirectorPort = (redirector.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of [canary4, canary6, redirector]) await new Promise((r) => s?.close(() => r(null)));
});

const PUBLIC_HOST = "feeds.example.org";
const PUBLIC_IP = "93.184.216.34";

it("SEC02: metadata and internal addresses are refused before any connection", async () => {
  let dials = 0;
  let lookups = 0;
  const dialed: string[] = [];
  const resolveMap: Record<string, string[]> = {
    [PUBLIC_HOST]: [PUBLIC_IP],
    "rebind.example.org": ["127.0.0.1"],
    "mixed.example.org": [PUBLIC_IP, "169.254.169.254"],
    "v6rebind.example.org": ["::1"],
    "mapped.example.org": ["::ffff:7f00:1"],
  };
  const deps = {
    resolve: async (h: string) => {
      lookups++;
      const r = resolveMap[h];
      if (!r) throw new Error("NXDOMAIN");
      return r;
    },
    onDial: (ip: string) => {
      dials++;
      dialed.push(ip);
    },
    // test-only: the single permitted public dial is served by the local redirector
    dialOverride: (ip: string, p: number) =>
      ip === PUBLIC_IP ? { ip: "127.0.0.1", port: redirectorPort } : { ip, port: p },
  };
  const allowAll = [
    PUBLIC_HOST,
    "rebind.example.org",
    "mixed.example.org",
    "v6rebind.example.org",
    "mapped.example.org",
    "169.254.169.254",
    "metadata.google.internal",
    "127.0.0.1",
    `127.0.0.1:${port4}`,
    `localhost:${port4}`,
    "[::1]",
    "0.0.0.0",
  ];
  const policy = { allowHosts: allowAll, allowInsecureHttp: true, timeoutMs: 3000 };
  const noAllow = { allowHosts: [PUBLIC_HOST], allowInsecureHttp: true, timeoutMs: 3000 };
  const attempts: Array<{ url: string; policy: typeof policy }> = [];
  const add = (url: string, p = policy) => attempts.push({ url, policy: p });
  // metadata services (cloud providers) and encodings of 169.254.169.254, even when an operator lists the host
  for (const u of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://169.254.170.2/v2/credentials",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.100.100.200/latest/meta-data/",
    "http://2852039166/",
    "http://0xA9FEA9FE/",
    "http://0251.0376.0251.0376/",
    "http://169.254.43518/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
  ]) {
    add(u);
    add(u, noAllow);
  }
  // loopback canaries in every spelling, listed or not
  const loop: string[] = [
    `http://127.0.0.1:${port4}/`,
    `http://localhost:${port4}/`,
    `http://127.1:${port4}/`,
    `http://2130706433:${port4}/`,
    `http://0x7f000001:${port4}/`,
    `http://0.0.0.0:${port4}/`,
    `http://[::ffff:127.0.0.1]:${port4}/`,
    `http://allowed.example@127.0.0.1:${port4}/`,
    `http://127.0.0.1:${port4}#@${PUBLIC_HOST}/`,
  ];
  if (port6) loop.push(`http://[::1]:${port6}/`, `http://[0:0:0:0:0:0:0:1]:${port6}/`);
  for (const u of loop) {
    add(u);
    add(u, noAllow);
  }
  // DNS rebinding style answers for allowlisted names
  for (const h of ["rebind.example.org", "mixed.example.org", "v6rebind.example.org", "mapped.example.org"])
    add(`http://${h}:${port4}/`);
  // scheme and syntax tricks
  for (const u of [
    "file:///etc/passwd",
    "gopher://127.0.0.1:70/",
    "ftp://127.0.0.1/",
    "data:text/plain,x",
    "javascript:0",
    "http://",
    "not a url",
  ])
    add(u);

  const results: Array<{ url: string; code: string }> = [];
  for (const a of attempts) {
    const r = await guardedFetch(a.url, {}, a.policy, deps).then(
      () => ({ url: a.url, code: "ALLOWED" }),
      (e) => ({ url: a.url, code: e instanceof EgressDenied ? e.reasonCode : `ERROR:${String(e)}` }),
    );
    results.push(r);
  }
  const notDenied = results.filter((r) => !r.code.startsWith("EGRESS_"));
  expect(notDenied).toEqual([]);
  // blocked before outbound connection: no dial hook call, no socket accepted by any canary, no DNS for literals
  expect(dials).toBe(0);
  expect(hits).toBe(0);
  expect(lookups).toBeLessThanOrEqual(4 + attempts.filter((a) => /rebind|mixed|mapped/.test(a.url)).length);

  // the classifier agrees on the raw addresses
  for (const ip of [
    "169.254.169.254",
    "127.0.0.1",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:10.0.0.1",
    "0.0.0.0",
  ])
    expect(nonPublicReason(ip), ip).not.toBeNull();
  for (const ip of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"])
    expect(nonPublicReason(ip), ip).toBeNull();

  // redirects: the first hop is a permitted public host, the Location points at a metadata/internal address
  const redirectTargets = [
    `http://169.254.169.254/latest/meta-data/`,
    `http://127.0.0.1:${port4}/`,
    `http://localhost:${port4}/`,
    `http://[::ffff:a9fe:a9fe]/`,
  ];
  const redirectCodes: string[] = [];
  const dialsBefore = dials;
  for (const t of redirectTargets) {
    redirectTarget = t;
    const r = await guardedFetch(`http://${PUBLIC_HOST}/start`, {}, policy, deps).then(
      () => "ALLOWED",
      (e) => (e instanceof EgressDenied ? e.reasonCode : `ERROR:${String(e)}`),
    );
    redirectCodes.push(r);
  }
  expect(redirectCodes.every((c) => c.startsWith("EGRESS_"))).toBe(true);
  expect(hits).toBe(0);
  // exactly one dial per redirect probe (the public first hop); never one to the redirect target
  expect(dialed.slice(dialsBefore)).toEqual(redirectTargets.map(() => PUBLIC_IP));

  // positive control: the guard is not simply denying everything
  redirectTarget = `http://${PUBLIC_HOST}/final`;
  let controlStatus = 0;
  const ctl = http.createServer((_q, res) => {
    res.end("ok");
  });
  await new Promise<void>((r) => ctl.listen(0, "127.0.0.1", r));
  const ctlPort = (ctl.address() as AddressInfo).port;
  const ok = await guardedFetch(`http://${PUBLIC_HOST}/ok`, {}, policy, {
    ...deps,
    dialOverride: () => ({ ip: "127.0.0.1", port: ctlPort }),
  });
  controlStatus = ok.status;
  await new Promise((r) => ctl.close(r));
  expect(controlStatus).toBe(200);

  const byCode: Record<string, number> = {};
  for (const r of results) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
  observe({
    testId: "SEC02",
    observed: `${attempts.length} SSRF attempts (metadata IPs in decimal/hex/octal/IPv4-mapped/NAT64/6to4 forms, loopback spellings, DNS-rebinding answers, scheme tricks) plus ${redirectTargets.length} redirect-to-internal probes: all refused (${JSON.stringify(byCode)}); dial hook calls for blocked targets ${dials}; TCP connections accepted by 127.0.0.1/::1 canaries ${hits}; permitted public control fetch status ${controlStatus}`,
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(attempts.map((a) => a.url)))
      .digest("hex"),
    evidence: {
      attempts: attempts.length,
      redirectProbes: redirectTargets.length,
      byCode,
      dials,
      canaryConnections: hits,
      controlStatus,
      ipv6Canary: port6 !== 0,
    },
  });
}, 60_000);
