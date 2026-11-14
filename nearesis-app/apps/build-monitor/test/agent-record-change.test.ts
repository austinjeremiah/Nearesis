import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMonitor, type MonitorHandle } from "../server/server.ts";
import type { State } from "../server/snapshot.ts";
import { agentRecord, tempPaths, writeJson } from "./fixtures.ts";

/** Minimal SSE client over fetch; yields parsed `state` events. */
async function openSse(url: string) {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const waiters: { pred: (s: State) => boolean; resolve: (s: State) => void }[] = [];
  const seen: State[] = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.startsWith("event: state")) continue;
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const s = JSON.parse(line.slice(6)) as State;
          seen.push(s);
          for (const w of [...waiters])
            if (w.pred(s)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(s);
            }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    seen,
    waitFor: (pred: (s: State) => boolean, ms = 5000) =>
      new Promise<State>((resolve, reject) => {
        const hit = seen.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(
          () => reject(new Error(`no matching SSE state within ${ms} ms (saw ${seen.length})`)),
          ms,
        );
        waiters.push({
          pred,
          resolve: (s) => {
            clearTimeout(t);
            resolve(s);
          },
        });
      }),
    close: () => ctl.abort(),
  };
}

describe("agent record change reaches dashboard (API + SSE)", () => {
  const paths = tempPaths();
  const file = join(paths.coordDir, "agents/A9.json");
  let m: MonitorHandle;
  beforeAll(async () => {
    writeJson(file, agentRecord());
    m = await startMonitor({ paths, port: 0, withGit: false, debounceMs: 100 });
  });
  afterAll(async () => {
    await m.close();
  });

  const api = async (): Promise<State> => (await fetch(`${m.url}/api/state`)).json() as Promise<State>;
  const a9 = (s: State) => s.agents.find((a) => a.agentId === "A9");

  it("RUNNING -> BLOCKED -> STALE are each reflected within 5 s", async () => {
    const sse = await openSse(`${m.url}/api/stream`);
    try {
      const first = await sse.waitFor((s) => a9(s)?.effectiveStatus === "RUNNING");
      expect(a9(first)?.record?.status).toBe("RUNNING");

      writeJson(file, agentRecord({ status: "BLOCKED", blockerIds: ["BLK-TEST"] }));
      const blocked = await sse.waitFor((s) => a9(s)?.effectiveStatus === "BLOCKED");
      expect(a9(blocked)?.record?.blockerIds).toEqual(["BLK-TEST"]);
      expect(a9(await api())?.effectiveStatus).toBe("BLOCKED");

      writeJson(
        file,
        agentRecord({ status: "RUNNING", heartbeatAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
      );
      const stale = await sse.waitFor((s) => a9(s)?.effectiveStatus === "STALE");
      expect(a9(stale)?.record?.status).toBe("RUNNING");
      expect(a9(stale)?.heartbeatAgeMs).toBeGreaterThan(10 * 60_000);
      expect(a9(await api())?.effectiveStatus).toBe("STALE");
    } finally {
      sse.close();
    }
  });

  it("binds to 127.0.0.1, serves guarded files, survives a corrupt record", async () => {
    expect(m.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((await fetch(`${m.url}/api/file?path=${encodeURIComponent("../x.md")}`)).status).toBe(400);
    writeJson(join(paths.bibleDir, "n.md"), "x");
    expect((await fetch(`${m.url}/api/file?path=n.md`)).status).toBe(200);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(paths.coordDir, "agents/A7.json"), "{corrupt");
    const sse = await openSse(`${m.url}/api/stream`);
    try {
      const s = await sse.waitFor((x) =>
        x.agents.some((a) => a.agentId === "A7" && a.effectiveStatus === "INVALID"),
      );
      expect(s.invalid.length).toBeGreaterThan(0);
      expect((await fetch(`${m.url}/api/state`)).status).toBe(200);
    } finally {
      sse.close();
    }
  });
});
