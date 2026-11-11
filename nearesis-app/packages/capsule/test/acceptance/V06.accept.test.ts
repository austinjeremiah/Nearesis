import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PublicationBlockedError, buildCapsule, checkPublication } from "../../src/index.ts";
import { SNAPSHOT, tmp } from "../helpers.ts";

/** V06 (ch.16): missing citation; the publication check blocks an unsupported number. */
it("V06: an uncited or unsupported number blocks publication", () => {
  // control: the generated capsule publishes
  const ok = tmp("v06-ok-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: ok });
  expect(existsSync(join(ok, "exports", "THESIS.md"))).toBe(true);

  const cases: Array<[string, string, string]> = [
    ["MISSING_CITATION", "Intents volume rose 45% last week.", "uncited number"],
    ["UNKNOWN_RESULT", "Volume rose 45% last week [R:does-not-exist].", "citation to a nonexistent result"],
    ["VALUE_NOT_IN_RESULT", `The series has 91 days [R:n].`, "number differs from the cited result"],
  ];
  const seen: string[] = [];
  for (const [kind, note, why] of cases) {
    const dir = tmp("v06-bad-");
    let blocked: PublicationBlockedError | null = null;
    try {
      buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir, extraThesisNotes: [note] });
    } catch (e) {
      if (e instanceof PublicationBlockedError) blocked = e;
      else throw e;
    }
    expect(blocked, why).not.toBeNull();
    expect(blocked!.file).toBe("THESIS.md");
    expect(blocked!.violations.map((v) => v.kind)).toContain(kind);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "exports"))).toBe(false);
    seen.push(kind);
  }
  // numbers inside a generated capsule are all cited: the checker finds none to complain about
  const chk = checkPublication(
    "Over 90 days [R:n].",
    m.results.map((r) => ({ id: r.id, value: r.value })),
  );
  expect(chk.ok).toBe(true);
  observe({
    testId: "V06",
    observed: `Generated capsule published (control). Three bad notes each blocked the build with no manifest or exports written: ${seen.join(", ")}.`,
    fixtureHash: m.snapshot.dataHash,
    evidence: { blockedKinds: seen, controlCapsuleHash: m.capsuleHash },
  });
});
