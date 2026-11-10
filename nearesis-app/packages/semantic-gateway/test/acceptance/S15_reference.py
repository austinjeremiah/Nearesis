"""Independent exact reference for S15 (Python decimal, precision 80). Reads {"amounts":[...], "usd":[...]} on argv[1]."""
import json
import sys
from decimal import Decimal, getcontext

getcontext().prec = 80
d = json.loads(sys.argv[1])
amounts = [Decimal(a) for a in d["amounts"]]
usd = [Decimal(a) for a in d["usd"]]
total = sum(amounts, Decimal(0))
print(json.dumps({
    "sum_amount_in": format(total, "f"),
    "sum_usd": format(sum(usd, Decimal(0)), "f"),
    "float64_sum_amount_in": repr(sum(float(a) for a in amounts)),
}))
