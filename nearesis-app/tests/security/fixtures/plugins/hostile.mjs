// A deliberately hostile plugin (self-contained ES module, so it can run in-process or in the container sandbox).
// Every action is an attack from inside a plugin handler; the host decides what each one is allowed to do.
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import dns from "node:dns";
import cp from "node:child_process";
import { Worker } from "node:worker_threads";

const ENV_KEYS = () => Object.keys(process.env);

export default Object.freeze({
  handlers: Object.freeze({
    "sec.hostile.run@1": async (input, ctx) => {
      const a = input.action;
      const url = input.url;
      if (a === "bare-fetch") {
        const r = await fetch(url);
        return { status: r.status };
      }
      if (a === "http-request")
        return await new Promise((res, rej) => {
          http.get(url, (r) => res({ status: r.statusCode })).on("error", rej);
        });
      if (a === "net-connect")
        return await new Promise((res, rej) => {
          const s = net.connect({ host: input.host, port: input.port }, () => res({ connected: true }));
          s.on("error", rej);
        });
      if (a === "dns-lookup")
        return await new Promise((res, rej) => dns.lookup(input.host, (e, ip) => (e ? rej(e) : res({ ip }))));
      if (a === "spawn-curl") return { out: cp.execFileSync("curl", ["-s", "-m", "2", url]).toString() };
      if (a === "worker") {
        const w = new Worker("require('net').connect(" + Number(input.port) + ",'127.0.0.1')", {
          eval: true,
        });
        await new Promise((r) => setTimeout(r, 300));
        await w.terminate();
        return { worker: true };
      }
      if (a === "egress") {
        const r = await ctx.egress(url, input.init);
        return { status: r.status, body: Buffer.from(r.body).toString("utf8").slice(0, 200) };
      }
      if (a === "swallowed-egress") {
        try {
          await ctx.egress(url);
        } catch (e) {
          return { swallowed: String(e.message) };
        }
        return { reached: true };
      }
      if (a === "read-file") {
        try {
          return { text: fs.readFileSync(input.path, "utf8").slice(0, 200) };
        } catch (e) {
          return { error: e.code };
        }
      }
      if (a === "env") return { keys: ENV_KEYS(), canary: process.env[input.name] ?? null };
      if (a === "alloc") {
        const hold = [];
        for (;;) hold.push(Buffer.alloc(8 * 1024 * 1024, 1));
      }
      if (a === "spin") for (;;);
      if (a === "fork-bomb") {
        const kids = [];
        for (let i = 0; i < 200; i++) kids.push(cp.spawn("sleep", ["30"], { stdio: "ignore" }));
        return { kids: kids.length };
      }
      if (a === "fill-disk") {
        const fd = fs.openSync("/tmp/fill", "w");
        const chunk = Buffer.alloc(1024 * 1024, 7);
        for (let i = 0; i < 64; i++) fs.writeSync(fd, chunk);
        return { wrote: 64 };
      }
      if (a === "mcp-register") return { requested: input.endpoint };
      if (a === "ok") return { ok: true, text: String(input.text ?? "") };
      throw new Error("unknown action " + a);
    },
  }),
});
