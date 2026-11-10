import { describe, expect, it } from "vitest";
import { createBackend, FixtureBackend, KernelBackend } from "../../src/lib/backend.ts";

const WS = "00000000-0000-4000-8000-000000002332";

describe("createBackend", () => {
  it("uses the fixture backend unless the kernel backend is requested", () => {
    expect(createBackend(new URLSearchParams(""), WS)).toBeInstanceOf(FixtureBackend);
  });
  it("selects gateway-backed panel data only when asked", () => {
    const k = createBackend(new URLSearchParams("backend=kernel"), WS) as KernelBackend;
    expect(k).toBeInstanceOf(KernelBackend);
    expect(k.dataMode).toBe("fixture");
    const s = createBackend(new URLSearchParams("backend=kernel&data=semantic"), WS) as KernelBackend;
    expect(s.dataMode).toBe("semantic");
  });
  it("refuses a malformed workspace id for the kernel backend", () => {
    expect(createBackend(new URLSearchParams("backend=kernel"), "../x")).toBeInstanceOf(FixtureBackend);
  });
});
