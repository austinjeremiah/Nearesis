import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { expect, it } from "vitest";
import { decimalToUnits, formatDec, parseDec, addDec, sumStr, unitsToDecimal } from "../../src/decimal.ts";
import { replay } from "../../src/replay.ts";

const ID = "fx.semantic.decimal-edge";
interface Expected {
  maxUint128: string;
  swaps: Array<{
    swapKey: string;
    amountIn: string;
    amountInDecimal: string;
    amountOut: string;
    amountOutDecimal: string;
  }>;
  sums: Record<string, unknown>;
}

// D11: Decimal smallest-unit amount -> exact arithmetic, no float rounding corruption
it("matches Python decimal(prec=80) results exactly and never routes amounts through float64", async () => {
  const exp = readFixtureJson<Expected>(ID, "expected.json");
  const out = await replay(ID);
  const byKey = new Map(out.tables.intents_swaps.map((s) => [s.swapKey, s]));
  expect(byKey.size).toBe(5);
  const decimals: Record<string, number> = { "nep141:wrap.near": 24, "nep141:eth.omft.near": 18 };
  for (const e of exp.swaps) {
    const row = byKey.get(e.swapKey)!;
    expect(row.amountIn).toBe(e.amountIn); // normalized smallest unit string untouched
    expect(row.amountOut).toBe(e.amountOut);
    expect(parseDec(unitsToDecimal(row.amountIn!, decimals[row.originAsset]!)).int).toBe(BigInt(e.amountIn));
    expect(unitsToDecimal(row.amountOut!, decimals[row.destinationAsset]!)).toBe(e.amountOutDecimal);
    expect(unitsToDecimal(row.amountIn!, decimals[row.originAsset]!)).toBe(e.amountInDecimal);
  }
  // 2^128-1 and 1 yocto
  expect(exp.maxUint128).toBe((2n ** 128n - 1n).toString());
  expect(unitsToDecimal(exp.maxUint128, 24)).toBe("340282366920938.463463374607431768211455");
  expect(unitsToDecimal("1", 24)).toBe("0.000000000000000000000001");
  expect(decimalToUnits("0.000000000000000000000001", 24)).toBe("1");
  expect(() => decimalToUnits("0.0000000000000000000000001", 24)).toThrow();
  // exact sums == Python
  const ethIn = exp.swaps
    .filter((s) => byKey.get(s.swapKey)!.originAsset === "nep141:eth.omft.near")
    .map((s) => s.amountInDecimal);
  expect(sumStr(ethIn)).toBe(exp.sums.exactSumEthIn);
  const unitSum = exp.swaps
    .filter((s) => byKey.get(s.swapKey)!.originAsset === "nep141:eth.omft.near")
    .reduce((a, s) => a + BigInt(s.amountIn), 0n);
  expect(unitSum.toString()).toBe(
    (exp.sums.amountInUnitsByOriginAsset as Record<string, string>)["nep141:eth.omft.near"],
  );
  expect(formatDec(addDec(parseDec("0.1"), parseDec("0.2")))).toBe("0.3");
  // the float path demonstrably corrupts the same sums (this is what the helper avoids)
  const floatSum = ethIn.reduce((a, s) => a + Number(s), 0);
  expect(String(floatSum)).not.toBe("0.6");
  expect(exp.sums.float64DiffersFromExact).toBe(true);
  expect(exp.sums.float64LosesUnits).toBe(true);
  const outs = exp.swaps
    .filter((s) => byKey.get(s.swapKey)!.originAsset === "nep141:eth.omft.near")
    .map((s) => s.amountOut);
  expect(outs.reduce((a, s) => a + BigInt(s), 0n).toString()).toBe(exp.sums.ethToEthAmountOutUnitsExact);
  expect(String(outs.reduce((a, s) => a + Number(s), 0))).not.toBe(exp.sums.ethToEthAmountOutUnitsExact);
  observe({
    testId: "D11",
    observed: `5 edge swaps (2^128-1, 1 yocto, 18/24 decimals) normalized with amounts byte-identical to source; decimal conversions and sums equal Python decimal prec=80 expected.json; float64 sum ${String(floatSum)} differs from exact ${String(exp.sums.exactSumEthIn)}`,
    fixtureHash: fixtureHash(ID),
    evidence: {
      maxUint128: exp.maxUint128,
      exactSumEthIn: exp.sums.exactSumEthIn,
      float64SumEthIn: String(floatSum),
      pythonFloat64SumEthIn: exp.sums.float64SumEthIn,
    },
  });
});
