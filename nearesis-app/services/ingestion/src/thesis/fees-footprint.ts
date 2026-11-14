import { BRIDGE_RECEIVERS, INTENTS_VERIFIER_RECEIVERS } from "../backfill/account-sql.ts";

/**
 * Accounts that are always kept as individual rows (outcomes and transactions queries), whatever their daily rank: the Intents
 * verifier contracts and the bridge / omni-token contracts from the account-scan rule (ACCOUNT_RULE_VERSION 1). The footprint
 * sets themselves (narrow and wide) are derived from the discovery files in fees-series.ts, never fixed in the SQL.
 */
export const CORE_CANDIDATES: readonly string[] = [...INTENTS_VERIFIER_RECEIVERS];
export const KEEP_ACCOUNTS: readonly string[] = [...INTENTS_VERIFIER_RECEIVERS, ...BRIDGE_RECEIVERS];
