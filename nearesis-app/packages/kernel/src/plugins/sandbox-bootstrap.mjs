// Runs INSIDE the plugin sandbox container (no network, read-only root, non-root, capped pids/memory/CPU/tmpfs).
// Protocol: newline-delimited JSON. Host -> job: {op:"invoke",capability,input,ctx}, {op:"egress.result",id,ok,...}.
// Job -> host: {op:"egress",id,url,init}, {op:"result",value}, {op:"error",code,message}.
// The plugin artifact is a self-contained ES module mounted read-only at /plugin/entry.mjs.
import readline from "node:readline";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map();
let nextId = 1;
const egress = (url, init) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ op: "egress", id, url, init: init ?? {} });
  });

const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.op === "egress.result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.ok) p.resolve({ ...m.res, body: Buffer.from(m.res.bodyB64, "base64") });
    else p.reject(Object.assign(new Error(m.message), { code: m.code }));
    return;
  }
  if (m.op !== "invoke" || started) return;
  started = true;
  try {
    const mod = (await import("/plugin/entry.mjs")).default;
    const handler = mod?.handlers?.[m.capability];
    if (typeof handler !== "function")
      throw Object.assign(new Error("no handler"), { code: "HANDLER_MISSING" });
    const value = await handler(m.input, { ...m.ctx, signal: new AbortController().signal, egress });
    send({ op: "result", value: value ?? null });
  } catch (e) {
    send({
      op: "error",
      code: e && e.code ? String(e.code) : "PLUGIN_ERROR",
      message: String(e && e.message ? e.message : e).slice(0, 500),
    });
  }
  rl.close();
  process.exit(0);
});
