import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, quotesEnabled } from "../../src/scheduler/config.ts";
import { Scheduler } from "../../src/scheduler/scheduler.ts";
import { emptySchedulerState } from "../../src/scheduler/state.ts";
import type { SchedulerStateStore } from "../../src/scheduler/state.ts";
import { CredentialSource } from "../../src/http/credentials.ts";

const dir = mkdtempSync(join(tmpdir(), "nearesis-ctl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctl = join(dir, "control.json");

describe("quote sampler loop switch", () => {
  it("defaults to disabled", () => {
    expect(quotesEnabled({}, ctl)).toBe(false);
    expect(quotesEnabled({ NEARESIS_QUOTE_ENABLED: "" }, ctl)).toBe(false);
    expect(quotesEnabled({ NEARESIS_QUOTE_ENABLED: "0" }, ctl)).toBe(false);
  });
  it("is enabled by the environment or by the control file, and the file wins", () => {
    expect(quotesEnabled({ NEARESIS_QUOTE_ENABLED: "1" }, ctl)).toBe(true);
    writeFileSync(ctl, JSON.stringify({ quotesEnabled: true }));
    expect(quotesEnabled({}, ctl)).toBe(true);
    writeFileSync(ctl, JSON.stringify({ quotesEnabled: false }));
    expect(quotesEnabled({ NEARESIS_QUOTE_ENABLED: "1" }, ctl)).toBe(false);
    writeFileSync(ctl, "not json");
    expect(quotesEnabled({}, ctl)).toBe(false);
  });
  it("the scheduler never lists quotes as due while the switch is off", () => {
    let on = false;
    const state = emptySchedulerState();
    const sched = new Scheduler({
      ch: {} as never,
      db: {} as never,
      archive: {} as never,
      cfg: loadConfig({}),
      sched: { state, save: () => undefined } as unknown as SchedulerStateStore,
      creds: CredentialSource.fromEnv({}),
      only: ["quotes"],
      quotesEnabled: () => on,
      clock: { now: () => Date.parse("2026-11-11T10:00:00Z"), sleep: async () => undefined },
    });
    expect(sched.due()).toEqual([]);
    on = true;
    expect(sched.due()).toEqual(["quotes"]);
  });
});
