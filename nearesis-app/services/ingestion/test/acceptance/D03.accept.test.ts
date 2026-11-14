import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { explorerImportChecksum } from "../../src/adapters/explorer.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let clean: TestEnv;
let crashA: TestEnv;
let crashB: TestEnv;
beforeAll(async () => {
  [clean, crashA, crashB] = await Promise.all([setupEnv(), setupEnv(), setupEnv()]);
}, 60_000);
afterAll(async () => {
  await Promise.all([clean.close(), crashA.close(), crashB.close()]);
}, 60_000);

// D03: Crash after page save -> resume matches clean import checksum
it("resumes from the committed cursor after a crash and matches the clean-import checksum", async () => {
  const pages = loadPages("fx.explorer.pages-3");
  await clean.collector(new ExplorerFixtureServer(clean.clock, pages).fetchImpl).run();
  const cleanCk = await explorerImportChecksum(clean.tdb.db);
  expect(cleanCk.count).toBe(13);

  // (1) crash right after page 2 was saved
  const sA = new ExplorerFixtureServer(crashA.clock, pages);
  const dying = crashA.collector(sA.fetchImpl, {
    faults: {
      afterPageCommit: (n) => {
        if (n === 2) throw new Error("simulated process crash after page 2");
      },
    },
  });
  await expect(dying.run()).rejects.toThrow(/simulated process crash/);
  const mid = await dying.checkpoint();
  expect(mid.pagesCommitted).toBe(2);
  const resumedA = await crashA.collector(sA.fetchImpl).run(); // fresh process / collector instance
  expect(resumedA.status).toBe("complete");
  const ckA = await explorerImportChecksum(crashA.tdb.db);

  // (2) crash in the middle of saving page 2 (swaps written, cursor not): the page transaction rolls back
  const sB = new ExplorerFixtureServer(crashB.clock, pages);
  const dying2 = crashB.collector(sB.fetchImpl, {
    faults: {
      midPage: (n) => {
        if (n === 2) throw new Error("simulated crash mid page 2");
      },
    },
  });
  await expect(dying2.run()).rejects.toThrow(/mid page 2/);
  const partial = await explorerImportChecksum(crashB.tdb.db);
  expect(partial.count).toBe(5); // page 2 left nothing behind
  expect((await dying2.checkpoint()).pagesCommitted).toBe(1);
  const resumedB = await crashB.collector(sB.fetchImpl).run();
  expect(resumedB.status).toBe("complete");
  const ckB = await explorerImportChecksum(crashB.tdb.db);

  expect(ckA.checksum).toBe(cleanCk.checksum);
  expect(ckB.checksum).toBe(cleanCk.checksum);
  expect(ckA.count).toBe(13);
  expect(ckB.count).toBe(13);
  // resumed run starts at the committed cursor, not from the start
  expect(sA.requests.at(2)?.query.lastDepositAddress).toBe(
    (pages[1]!.at(-1) as { depositAddress: string }).depositAddress,
  );
  observe({
    testId: "D03",
    observed: `crash after page 2 and crash mid-page-2 both resumed from the committed cursor; checksums ${ckA.checksum.slice(0, 12)}/${ckB.checksum.slice(0, 12)} equal clean ${cleanCk.checksum.slice(0, 12)}; ${ckA.count} swaps, no duplicates`,
    fixtureHash: fixtureHash("fx.explorer.pages-3"),
    evidence: {
      cleanChecksum: cleanCk.checksum,
      crashAfterPageChecksum: ckA.checksum,
      crashMidPageChecksum: ckB.checksum,
      rowsAfterMidPageCrash: partial.count,
      finalRows: ckA.count,
    },
  });
}, 120_000);
