// Quant worker (Q21). Runs inside the supervisor's network-disabled, read-only, non-root container. It implements a fixed set
// of declarative job kinds and probes; it never evaluates caller-supplied code. Output goes to /staging only.
import { readFileSync, writeFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import { createHash as h } from "node:crypto";
import net from "node:net";

const [kind, paramsJson] = process.argv.slice(2);
const params = JSON.parse(paramsJson ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sha = (b) => "sha256:" + h("sha256").update(b).digest("hex");

function scanForMarker(root, marker, depth = 0, hits = []) {
  if (depth > 4 || hits.length) return hits;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return hits;
  }
  for (const n of names) {
    const p = root === "/" ? `/${n}` : `${root}/${n}`;
    if (["proc", "sys", "dev", "usr", "lib", "bin", "sbin", "var"].includes(n) && root === "/") continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) scanForMarker(p, marker, depth + 1, hits);
    else if (st.size < 200000) {
      try {
        if (readFileSync(p).includes(marker)) hits.push(p);
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return hits;
}

const jobs = {
  async egress() {
    const r = await new Promise((resolve) => {
      const s = net.connect({ host: params.host, port: params.port, timeout: 3000 });
      s.on("connect", () => {
        s.destroy();
        resolve({ connected: true });
      });
      s.on("error", (e) => resolve({ connected: false, error: e.code ?? String(e.message) }));
      s.on("timeout", () => {
        s.destroy();
        resolve({ connected: false, error: "timeout" });
      });
    });
    out({ probe: "egress", ...r });
  },
  async canary() {
    const marker = params.marker;
    const envHit = Object.entries(process.env).some(
      ([k, v]) => k.includes(marker) || String(v).includes(marker),
    );
    let proc = false;
    try {
      proc = readFileSync("/proc/self/environ").includes(marker);
    } catch {
      /* not readable */
    }
    const fsHits = scanForMarker("/", marker);
    out({
      probe: "canary",
      envHasCanary: envHit || proc,
      fsHasCanary: fsHits.length > 0,
      envKeys: Object.keys(process.env).length,
    });
  },
  async write_snapshot() {
    let written = false,
      error = null;
    try {
      writeFileSync("/snapshot/injected.txt", "x");
      written = true;
    } catch (e) {
      error = e.code;
    }
    let modified = false;
    try {
      writeFileSync("/snapshot/data.csv", "tampered");
      modified = true;
    } catch {
      /* read-only: expected */
    }
    out({ probe: "write_snapshot", written, modified, error });
  },
  async alloc() {
    const keep = [];
    for (let i = 0; i < params.mb / 16; i++) keep.push(Buffer.alloc(16 * 1024 * 1024).fill(1));
    out({ probe: "alloc", allocatedMb: keep.length * 16 }); // reaching this line means the cap did not hold
  },
  async loop() {
    for (;;) {
      /* spin past the time budget */
    }
  },
  async identity() {
    out({ probe: "identity", uid: process.getuid(), gid: process.getgid() });
  },
  async sum() {
    const total = params.values.reduce((a, b) => a + b, 0);
    const body = Buffer.from(JSON.stringify({ total, n: params.values.length }));
    writeFileSync("/staging/result.json", body);
    writeFileSync("/staging/chart.json", Buffer.from(JSON.stringify({ x: params.values })));
    writeFileSync(
      "/staging/hashes.json",
      JSON.stringify({ "result.json": sha(body), "chart.json": sha(readFileSync("/staging/chart.json")) }),
    );
    out({ probe: "sum", total });
  },
  async truncate() {
    const body = Buffer.from(JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => i) }));
    writeFileSync("/staging/result.json", body);
    writeFileSync("/staging/hashes.json", JSON.stringify({ "result.json": sha(body) }));
    truncateSync("/staging/result.json", 17); // the output no longer matches the hash the worker declared
    out({ probe: "truncate" });
  },
};

if (!jobs[kind]) {
  out({ error: "unknown_kind", kind });
  process.exit(2);
}
await jobs[kind]();
