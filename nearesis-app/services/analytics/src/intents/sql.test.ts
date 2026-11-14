import { describe, expect, it } from "vitest";
import { swapsCte } from "./sql.ts";

describe("swapsCte", () => {
  it("deduplicates per partition (intents_swaps is partitioned by month of created_day and no swap spans two partitions)", () => {
    for (const era of [false, true]) {
      const sql = swapsCte("nearesis_live", era);
      expect(sql).toContain("intents_swaps AS s FINAL");
      expect(sql).toContain("SETTINGS do_not_merge_across_partitions_select_final = 1");
    }
  });
});
