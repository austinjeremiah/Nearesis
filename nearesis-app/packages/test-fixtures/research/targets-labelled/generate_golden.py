"""Generates rows.csv and golden.json for fx.research.targets-labelled (SYNTHETIC).

Written independently of nearesis_research: stdlib only (random, csv, math, json, datetime), plain loops, no pandas. The golden
values are hand-rule computations of each target definition so the engine's pandas implementation can be compared to them.

Definitions (ch.02 / ch.08): per calendar day D
  successful_actions        = sum of `actions`
  unique_signer_proxies     = number of distinct accounts with a row that day
  contract_diversity        = number of distinct contracts with a row that day
  application_tagged_actions= sum of `actions` over rows with a non-empty `app`
organic variant keeps rows tagged exactly `organic` (intents_verifier, bridge and unclassified are all excluded);
unadjusted variant keeps every row. A calendar day with no rows at all is missing (null); a present day whose kept
rows are empty is 0. The target series for horizon h at origin t is the value on day t+h (null if beyond the data).
Run: python3 generate_golden.py   (writes rows.csv and golden.json next to this file)
"""
import csv, json, math, random
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).parent
START, N_DAYS = date(2026, 5, 1), 120
ACCOUNTS = [("alice.near", "organic"), ("bob.near", "organic"), ("carol.near", "organic"), ("dave.near", "organic"), ("erin.near", "organic"), ("frank.near", "organic"),
            ("intents.near", "intents_verifier"), ("verifier2.near", "intents_verifier"), ("bridge.near", "bridge"), ("omft.near", "bridge"),
            ("mystery1.near", "unclassified"), ("mystery2.near", "unclassified")]
CONTRACTS = ["c0.near", "c1.near", "c2.near", "c3.near", "c4.near", "c5.near"]
APPS = ["", "", "appA", "appB"]
rnd = random.Random(2026111101)
rows = []
for i in range(N_DAYS):
    d = START + timedelta(days=i)
    if i == 70:
        continue  # a fully missing day
    for acct, tag in ACCOUNTS:
        if i == 50 and tag != "intents_verifier":
            continue  # a present day with zero organic rows
        if rnd.random() < 0.7:
            for c in rnd.sample(CONTRACTS, rnd.choice([1, 2])):
                rows.append((d.isoformat(), acct, c, tag, rnd.choice(APPS), rnd.randint(1, 20)))
with open(HERE / "rows.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "account", "contract", "tag", "app", "actions"])
    w.writerows(rows)

days = [(START + timedelta(days=i)).isoformat() for i in range(N_DAYS)]
FAMILIES = ["successful_actions", "unique_signer_proxies", "contract_diversity", "application_tagged_actions"]


def value(fam, day, organic):
    present = [r for r in rows if r[0] == day]
    if not present:
        return None
    kept = [r for r in present if (r[3] == "organic" or not organic)]
    if fam == "successful_actions":
        return sum(r[5] for r in kept)
    if fam == "unique_signer_proxies":
        return len({r[1] for r in kept})
    if fam == "contract_diversity":
        return len({r[2] for r in kept})
    return sum(r[5] for r in kept if r[4] != "")


golden = {"origins": days, "series": {}}
for fam in FAMILIES:
    for h in (1, 7, 14):
        for variant, organic in (("organic", True), ("unadjusted", False)):
            raw, lg = [], []
            for i in range(N_DAYS):
                j = i + h
                v = value(fam, days[j], organic) if j < N_DAYS else None
                raw.append(v)
                lg.append(None if v is None else math.log1p(v))
            golden["series"][f"{fam}|{h}|{variant}"] = {"raw": raw, "log1p": lg}
(HERE / "golden.json").write_text(json.dumps(golden, separators=(",", ":")) + "\n")
print(len(rows), "rows", len(golden["series"]), "series")
