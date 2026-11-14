import { describe, expect, it } from "vitest";
import { usageAtCeiling } from "../src/sandbox.ts";
import { limitReason } from "../src/plugins/sandbox-exec.ts";

describe("sandbox limit attribution", () => {
  it("recognises a container pinned at its memory ceiling from a docker stats sample", () => {
    expect(usageAtCeiling("63.15MiB / 64MiB")).toBe(true);
    expect(usageAtCeiling("57.6MiB / 64MiB")).toBe(true);
    expect(usageAtCeiling("1.02GiB / 1GiB")).toBe(true);
  });
  it("does not treat an idle or spinning container as memory-limited", () => {
    expect(usageAtCeiling("15.4MiB / 64MiB")).toBe(false);
    expect(usageAtCeiling("32.94MiB / 64MiB")).toBe(false);
  });
  it("fails closed to false on unreadable samples", () => {
    for (const s of ["", "EOF", "-- / --", "12XB / 64MiB", "5MiB / 0MiB"])
      expect(usageAtCeiling(s)).toBe(false);
  });
  it("maps a timeout to the memory limit only when the sample was at the ceiling", () => {
    expect(limitReason(137, true, undefined, "", true)).toBe("PLUGIN_MEMORY_LIMIT");
    expect(limitReason(137, true, undefined, "", false)).toBe("PLUGIN_CPU_LIMIT");
    expect(limitReason(137, true)).toBe("PLUGIN_CPU_LIMIT");
    expect(limitReason(137, false)).toBe("PLUGIN_MEMORY_LIMIT");
    expect(limitReason(1, false, "ENOSPC")).toBe("PLUGIN_DISK_LIMIT");
  });
});
