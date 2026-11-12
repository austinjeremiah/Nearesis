/**
 * Account and cohort analytics read model (final_master_prompt s6). Source: nearesis_live.account_daily_* tables loaded by
 * services/ingestion/src/accounts from ONE BigQuery scan of `transactions` (signer, receiver, block_date).
 *
 * Accounts are NOT people. A signer account may be an individual wallet, a bot, a relayer or a contract acting for many users.
 * "New" means first organic transaction SEEN SINCE the window start (windowStart), not lifetime first-seen; the first window day
 * counts every active account as new by construction and is excluded from growth statistics.
 */
export const ACCOUNT_CAVEATS = [
  "Accounts are not people: one person can hold many accounts and one account (bot, relayer, game contract) can serve many people.",
  "Organic excludes NEAR Intents verifier receivers and bridge/omni receivers (documented rule, not a bot classifier).",
  "New = first organic transaction seen since the window start, not lifetime first-seen.",
] as const;

export interface AccountDay {
  date: string;
  signersAll: number;
  txAll: number;
  txIntents: number;
  txBridge: number;
  signersWithIntents: number;
  signersOrganic: number;
  txOrganic: number;
  newSigners: number;
  returningSigners: number;
  newTx: number;
  returningTx: number;
  top10Tx: number;
  top1PctSigners: number;
  top1PctTx: number;
  top5PctSigners: number;
  top5PctTx: number;
  headSigners: number;
  headTx: number;
  tailSigners: number;
  tailTx: number;
  headThreshold: number;
}
export interface RetentionCell {
  cohortWeek: string; // Monday
  activeWeek: string; // Monday
  signers: number;
}
export interface HeadAccountRow {
  account: string;
  headDays: number;
  txOrganic: number;
  maxDayTx: number;
  firstHeadDay: string;
  lastHeadDay: string;
}
export interface HeadAccountDay {
  date: string;
  txOrganic: number;
}
export interface AccountProfile {
  account: string;
  firstSeenInWindow: string;
  lastSeenInWindow: string;
  activeDays: number;
  txOrganic: number;
  headDays: number;
}
export interface EntitySignerDay {
  date: string;
  signersAll: number;
  txAll: number;
  signersOrganic: number;
  txOrganic: number;
}

export interface AccountDataSource {
  /** Window start of the loaded scan (null when nothing is loaded) and the days it covers (complete coverage rows). */
  window(): Promise<{
    windowStart: string;
    from: string;
    to: string;
    days: string[];
    headThreshold: number;
  } | null>;
  days(from: string, to: string): Promise<AccountDay[]>;
  retention(): Promise<RetentionCell[]>;
  headAccounts(from: string, to: string, limit: number): Promise<HeadAccountRow[]>;
  headDays(account: string, from: string, to: string): Promise<HeadAccountDay[]>;
  profile(account: string): Promise<AccountProfile | null>;
  entityDays(entityBucket: string, from: string, to: string): Promise<EntitySignerDay[]>;
}
