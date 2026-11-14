import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import Fastify from "fastify";
import { guardPath, readGuarded } from "./guard.ts";
import { recentCommits, type CommitInfo } from "./git.ts";
import type { MonitorPaths } from "./paths.ts";
import { buildSnapshot, type State } from "./snapshot.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_DIST = resolve(here, "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export interface MonitorOptions {
  paths: MonitorPaths;
  port: number;
  host?: string;
  webDist?: string;
  debounceMs?: number;
  /** Periodic rebuild so STALE transitions show without file changes. */
  refreshMs?: number;
  withGit?: boolean;
}

export interface MonitorHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  snapshot: () => State;
}

export async function startMonitor(opts: MonitorOptions): Promise<MonitorHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("build-monitor binds to 127.0.0.1 only");
  const { paths } = opts;
  const debounceMs = opts.debounceMs ?? 200;
  const refreshMs = opts.refreshMs ?? 15_000;
  const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
  const withGit = opts.withGit ?? true;

  let commits: CommitInfo[] = [];
  let state: State = buildSnapshot(paths, new Date(), commits);
  const clients = new Set<import("node:http").ServerResponse>();

  const send = (res: import("node:http").ServerResponse, s: State): void => {
    res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
  };
  const rebuild = async (refreshGit: boolean): Promise<void> => {
    try {
      if (withGit && refreshGit) commits = await recentCommits(paths.repoRoot, 15);
      state = buildSnapshot(paths, new Date(), commits);
      for (const c of clients) send(c, state);
    } catch (e) {
      // never crash on bad input; keep the previous snapshot
      console.error("snapshot rebuild failed:", (e as Error).message);
    }
  };
  if (withGit) commits = await recentCommits(paths.repoRoot, 15);
  state = buildSnapshot(paths, new Date(), commits);

  const app = Fastify({ logger: false });

  app.get("/api/state", async (_req, reply) => {
    state = buildSnapshot(paths, new Date(), commits);
    reply.header("cache-control", "no-store");
    return state;
  });

  app.get("/api/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    send(res, buildSnapshot(paths, new Date(), commits));
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  app.get("/api/file", async (req, reply) => {
    const p = (req.query as { path?: unknown }).path;
    if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
    const g = guardPath(paths.bibleDir, p);
    if (!g.ok) return reply.code(g.status).send({ error: g.error });
    reply.header("content-type", "text/plain; charset=utf-8");
    reply.header("x-content-type-options", "nosniff");
    return readGuarded(g.real);
  });

  // static UI
  app.get("/*", async (req, reply) => {
    const url = (req.raw.url ?? "/").split("?")[0] ?? "/";
    let rel = decodeURIComponent(url);
    if (rel === "/" || rel === "") rel = "/index.html";
    const full = normalize(join(webDist, rel));
    if (!full.startsWith(webDist + sep) || !existsSync(full) || !statSync(full).isFile()) {
      if (!existsSync(join(webDist, "index.html"))) {
        return reply
          .code(503)
          .type("text/plain")
          .send("UI not built. Run: pnpm --filter @nearesis/build-monitor build");
      }
      return reply.code(404).type("text/plain").send("not found");
    }
    reply.header("x-content-type-options", "nosniff");
    return reply.type(MIME[extname(full)] ?? "application/octet-stream").send(readFileSync(full));
  });

  // watcher
  let timer: NodeJS.Timeout | null = null;
  let gitDirty = false;
  const schedule = (git = false): void => {
    gitDirty ||= git;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const g = gitDirty;
      gitDirty = false;
      void rebuild(g);
    }, debounceMs);
  };
  const watcher: FSWatcher = watch([paths.coordDir, paths.reportsDir, paths.testIndex], {
    ignoreInitial: true,
    ignored: (p: string) => /\.(lock|tmp-[^/]*)$/.test(p) || p.includes(`${sep}.git${sep}`),
    awaitWriteFinish: false,
  });
  watcher.on("all", () => schedule(false));
  watcher.on("error", (e) => console.error("watcher error:", (e as Error).message));
  const refresh = setInterval(() => void rebuild(true), refreshMs);
  await new Promise<void>((r) => watcher.once("ready", () => r()));

  await app.listen({ port: opts.port, host });
  const port = (app.server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    snapshot: () => state,
    close: async () => {
      clearInterval(refresh);
      if (timer) clearTimeout(timer);
      for (const c of clients) c.end();
      clients.clear();
      await watcher.close();
      await app.close();
    },
  };
}
