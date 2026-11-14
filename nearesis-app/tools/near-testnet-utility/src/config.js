// Every value the utility acts on is fixed here and checked against the chain
// before a transaction is allowed. Nothing is read from the URL or the page.

export const NETWORK_ID = "testnet";
// rpc.testnet.near.org rate-limits (429) without CORS headers, which browsers
// report as "Failed to fetch". FastNEAR testnet RPC serves proper CORS.
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";

export const ACCOUNT_ID = "majorlynx5104.testnet";
export const TOKEN_ID = "usdc.fakes.testnet";

// Contract code observed and inspected on 2026-11-10 (exports include
// storage_deposit, mint, ft_balance_of). Any change blocks both writes until
// the new code is re-reviewed.
export const EXPECTED_CODE_HASH = "E1E1CJYxT5FjzVSF55QoEWzv6dbqTe2yB6Hpmjks7JJ7";
export const REQUIRED_EXPORTS = ["storage_deposit", "storage_balance_of", "storage_balance_bounds", "mint", "ft_balance_of", "ft_metadata"];

export const EXPECTED_DECIMALS = 6;
export const EXPECTED_SYMBOL = "USDC.e";

export const GAS_30_TGAS = "30000000000000";
// The owner approved exactly 0.00125 NEAR. If the contract asks for anything
// else, registration is refused rather than adjusted.
export const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000";
export const MINT_AMOUNT = "10000000"; // 10 USDC.e at 6 decimals

export const REGISTER_ARGS = { account_id: ACCOUNT_ID, registration_only: true };
export const MINT_ARGS = { account_id: ACCOUNT_ID, amount: MINT_AMOUNT };
