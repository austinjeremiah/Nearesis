import json, sys
from decimal import Decimal, getcontext
getcontext().prec = 80
data = json.load(open(sys.argv[1]))
dec = {t["assetId"]: t["decimals"] for t in json.load(open(sys.argv[2]))}
out = {"precision": 80, "swaps": [], "sums": {}}
sum_in_units = {}
sum_in_formatted = {}
for tx in data:
    d_in, d_out = dec[tx["originAsset"]], dec[tx["destinationAsset"]]
    fin = Decimal(int(tx["amountIn"])).scaleb(-d_in)
    fout = Decimal(int(tx["amountOut"])).scaleb(-d_out)
    out["swaps"].append({"swapKey": tx["depositAddress"] + "|" + (tx["depositMemo"] or ""), "amountIn": tx["amountIn"], "amountInDecimal": format(fin, "f"), "amountOut": tx["amountOut"], "amountOutDecimal": format(fout, "f")})
    sum_in_units[tx["originAsset"]] = sum_in_units.get(tx["originAsset"], 0) + int(tx["amountIn"])
    sum_in_formatted[tx["originAsset"]] = sum_in_formatted.get(tx["originAsset"], Decimal(0)) + fin
out["sums"]["amountInUnitsByOriginAsset"] = {k: str(v) for k, v in sorted(sum_in_units.items())}
out["sums"]["amountInDecimalByOriginAsset"] = {k: format(v, "f") for k, v in sorted(sum_in_formatted.items())}
f = 0.0
for t in data:
    if t["originAsset"] == "nep141:eth.omft.near":
        f += float(Decimal(int(t["amountIn"])).scaleb(-dec[t["originAsset"]]))
out["sums"]["float64SumEthIn"] = repr(f)
out["sums"]["exactSumEthIn"] = format(sum_in_formatted["nep141:eth.omft.near"], "f")
out["sums"]["float64DiffersFromExact"] = Decimal(repr(f)) != sum_in_formatted["nep141:eth.omft.near"]
fo = 0.0
exact_out = 0
for t in data:
    if t["destinationAsset"] == "nep141:eth.omft.near" and t["originAsset"] == "nep141:eth.omft.near":
        fo += float(int(t["amountOut"]))
        exact_out += int(t["amountOut"])
out["sums"]["ethToEthAmountOutUnitsExact"] = str(exact_out)
out["sums"]["ethToEthAmountOutUnitsFloat64"] = str(int(fo))
out["sums"]["float64LosesUnits"] = int(fo) != exact_out
out["maxUint128"] = str(2**128 - 1)
json.dump(out, sys.stdout, indent=2, sort_keys=True)
print()
