/**
 * Binding of the fee inputs (thesis/raw/fees/manifest.json, produced separately) to the series the forecast needs. The fee
 * manifest has the same dataset entry shape as thesis/raw/manifest.json. A series is bound to the first column whose name
 * (case-insensitive) is in its list, in any dataset of the fee manifest. Edit the lists here if the fee files use other names;
 * a series with no binding is reported as missing, never guessed.
 */
export interface FeeBinding {
  id: string;
  label: string;
  unit: string;
  transform: "log1p" | "logit" | "log";
  columns: string[];
}
export const FEE_BINDINGS: FeeBinding[] = [
  {
    id: "take_rate_gas",
    label: "Take rate by gas: NEAR burnt by the Intents contracts per dollar settled (basis points)",
    unit: "basis points of settled USD",
    transform: "log",
    columns: ["take_rate_gas_bps", "take_rate_gas", "take_rate_bps"],
  },
  {
    id: "intents_burn_near",
    label: "NEAR burnt per day by the Intents contracts (narrow contract set)",
    unit: "NEAR",
    transform: "log1p",
    columns: [
      "intents_burnt_near_narrow",
      "intents_burnt_near",
      "burnt_near_intents_narrow",
      "burnt_near_intents",
    ],
  },
  {
    id: "total_burn_near",
    label: "NEAR burnt per day in total",
    unit: "NEAR",
    transform: "log1p",
    columns: ["total_burnt_near", "burnt_near_total", "near_burnt_total", "total_near_burnt"],
  },
  {
    id: "intents_burn_share",
    label: "Intents' share of all NEAR burnt",
    unit: "share of NEAR burnt",
    transform: "logit",
    columns: ["intents_share_of_burn", "intents_burn_share", "intents_share_of_near_burnt"],
  },
  {
    id: "spread_bps_stable",
    label: "User-paid spread, stablecoin to stablecoin (basis points)",
    unit: "basis points of swapped USD",
    transform: "log",
    columns: [
      "spread_bps_stable_to_stable",
      "stable_to_stable_spread_bps",
      "user_spread_bps_s2s",
      "spread_bps_s2s",
    ],
  },
];
/** Datasets of the fee manifest read as a ranked table (top fee payers): id matches this pattern. */
export const TOP_PAYERS_ID = /payer/i;
