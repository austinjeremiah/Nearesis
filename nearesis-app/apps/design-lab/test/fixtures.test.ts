import { describe, expect, it } from "vitest";
import {
  bigScatter,
  bigSeries,
  candlestickSpec,
  chainBarSpec,
  fillLatencySpec,
  heatmapSpec,
  rng,
  volumeSpec,
} from "../src/fixtures/data";
import { ACTION_HASH, APPROVAL_PENDING, EVENTS, seed } from "../src/fixtures/run";

describe("lab fixtures", () => {
  it("are deterministic", () => {
    expect(rng(5)()).toBe(rng(5)());
    expect(JSON.stringify(volumeSpec())).toBe(JSON.stringify(volumeSpec()));
    expect(bigSeries(1000).rows).toEqual(bigSeries(1000).rows);
    expect(bigScatter(100)).toEqual(bigScatter(100));
  });
  it("big series carry five injected spikes", () => {
    const { rows, spikes } = bigSeries(100000);
    expect(spikes).toHaveLength(5);
    for (const i of spikes) expect(rows[i]![1]).toBeGreaterThan(400);
  });
  it("every chart kind has columns matching its row width and a declared x field", () => {
    for (const s of [volumeSpec(), chainBarSpec(), fillLatencySpec(), heatmapSpec(), candlestickSpec()]) {
      expect(s.rows.every((r) => r.length === s.columns.length)).toBe(true);
      expect(s.columns.some((c) => c.name === s.x.field)).toBe(true);
    }
  });
  it("the volume fixture has a gap with null values (never zero)", () => {
    const s = volumeSpec();
    expect(s.gaps).toHaveLength(1);
    expect(s.rows.some((r) => r[1] === null)).toBe(true);
    expect(s.rows.every((r) => r[1] !== 0)).toBe(true);
  });
  it("run seeds: approval pending has the hash, complete is partial with an abstention", () => {
    expect(seed("approval").runs[Object.keys(seed("approval").runs)[0]!]!.approvals[0]!.actionHash).toBe(
      ACTION_HASH,
    );
    expect(APPROVAL_PENDING.status).toBe("pending");
    expect(EVENTS.some((e) => e.kind === "abstention")).toBe(true);
    const done = Object.values(seed("complete").runs)[0]!;
    expect(done.run.state).toBe("PARTIAL");
    expect(done.run.terminal).toBe(true);
  });
});
