import { entities as entitiesV1, mappings as mappingsV1, relations as relationsV1 } from "./seed-v1.ts";
import type { Entity, Mapping, Registry } from "./types.ts";

/**
 * Registry v2 (researched 2026-11-13): v1 plus new evidence-backed mappings for the largest unclassified or
 * unverified receivers of the 90-day window 2026-08-14..2026-11-11. v1 (seed-v1.ts) is kept intact and stays loadable.
 *
 * Evidence rules: verified = an official project doc/site/repo or the official ecosystem docs name the account;
 * inferred = on-chain contract metadata (nft_metadata / ft_metadata / NEP-330 source link, read-only RPC views) or a
 * namespace rule, where no official page names the account. Inferred never claims who owns a contract: for contracts
 * that only identify themselves on-chain, the entity is "the contract" and its limitations say the owner is not
 * established. Names, similarity or third-party listings alone never produce a mapping.
 * effective_from = account creation date from the nearblocks account API (evidence for when the account exists), or the
 * observation-window start when the API did not return one; ownership is assumed unchanged since (evidence is as of
 * 2026-11-13).
 *
 * Supersession (v1 -> v2, evidence upgrades, not ownership changes): v1 rows for client-eth2.bridge.near and
 * contract.wormhole_crypto.near were `unverified` (naming only). v2 replaces them with verified rows backed by official
 * sources found in this pass. Everything else in v1 is carried over unchanged.
 */
export const REGISTRY_VERSION_V2 = "v2";
export const PUBLISHED_AT_V2 = "2026-11-13T12:00:00Z";
const WINDOW = "2025-11-10T00:00:00Z";
const RPC = "NEAR mainnet RPC view (free.rpc.fastnear.com, finality final, 2026-11-13). ";
const CREATED = "Account creation date from api.nearblocks.io/v1/account/<id>. ";

/** Account creation dates (UTC day) from the nearblocks account API; absent = API returned none (use window start). */
export const CREATED_AT: Record<string, string> = {
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "2022-11-22T00:00:00Z",
  "fast-auth.near": "2025-10-06T00:00:00Z",
  "jwt.fast-auth.near": "2025-10-06T00:00:00Z",
  "btc-connector.bridge.near": "2025-01-20T00:00:00Z",
  "nbtc.bridge.near": "2025-01-20T00:00:00Z",
  "nzec.bridge.near": "2025-08-21T00:00:00Z",
  "zcash-connector.bridge.near": "2025-08-20T00:00:00Z",
  "zcash-client.bridge.near": "2025-08-20T00:00:00Z",
  "btc-client.bridge.near": "2024-09-16T00:00:00Z",
  "mpc-prover.bridge.near": "2026-03-27T00:00:00Z",
  "meta-pool.near": "2021-08-21T00:00:00Z",
  "linear-protocol.near": "2022-03-10T00:00:00Z",
  "aggregatedex.near": "2026-01-08T00:00:00Z",
  "vaa-prover-0_4_13.bridge.near": "2026-08-30T00:00:00Z",
  "aggregate-oracle.near": "2026-07-15T00:00:00Z",
  "agg-oracle.stg.ref-dev-team.near": "2026-03-26T00:00:00Z",
  "pyth-oracle.near": "2023-11-27T00:00:00Z",
  "cooldogsclub.near": "2022-02-21T00:00:00Z",
  "embr.playember_reserve.near": "2022-08-19T00:00:00Z",
  "aa-harvest-moon.near": "2024-04-03T00:00:00Z",
};

const cat = (id: string, name: string): Entity => ({
  entityId: `cat.${id}`,
  entityType: "category",
  name,
  categoryId: null,
  parentEntityId: null,
  description: `Category: ${name}`,
});
const ent = (
  entityId: string,
  entityType: Entity["entityType"],
  name: string,
  categoryId: string,
  description: string,
): Entity => ({ entityId, entityType, name, categoryId, parentEntityId: null, description });

export const newEntities: Entity[] = [
  cat("auth", "Authentication and account abstraction"),
  cat("liquid_staking", "Liquid staking"),
  cat("oracle", "Oracles"),
  cat("nft_game_contracts", "NFT and game contracts (self-identified on-chain)"),
  ent(
    "circle-usdc",
    "token_contract",
    "Circle native USDC on NEAR",
    "cat.token",
    "Native USDC NEP-141 (implicit account).",
  ),
  ent(
    "fast-auth",
    "protocol",
    "NEAR Auth (FastAuth)",
    "cat.auth",
    "FastAuth contracts built and operated by Peersyst, documented by NEAR.",
  ),
  ent(
    "meta-pool",
    "protocol",
    "Meta Pool (stNEAR)",
    "cat.liquid_staking",
    "Meta Pool liquid staking contract and stNEAR token.",
  ),
  ent(
    "linear",
    "protocol",
    "LiNEAR Protocol",
    "cat.liquid_staking",
    "LiNEAR liquid staking contract and LINEAR token.",
  ),
  ent(
    "pyth-near",
    "protocol",
    "Pyth price oracle on NEAR (contract)",
    "cat.oracle",
    "Pyth receiver contract; NEAR support has since been dropped from Pyth Core docs.",
  ),
  ent(
    "nft.cooldogsclub",
    "token_contract",
    "Cool Dogs Club NFT contract",
    "cat.nft_game_contracts",
    "NEP-171 contract that names itself Cool Dogs Club (CDC). Project owner not established.",
  ),
  ent(
    "ft.unites",
    "token_contract",
    "Unites (UNTS) token contract",
    "cat.nft_game_contracts",
    "NEP-141 contract that names itself Unites (UNTS) under playember_reserve.near. Owner not established.",
  ),
  ent(
    "harvest-moon",
    "application",
    "Harvest Moon (MOON token contract)",
    "cat.nft_game_contracts",
    "NEP-141 Moonlight Token (MOON); Meteor Wallet's Harvest Moon guide describes MOON as the game currency. Contract id not listed in the guide.",
  ),
  ent(
    "nft.mrbrown",
    "token_contract",
    "MR. BROWN NFT contract",
    "cat.nft_game_contracts",
    "NEP-171 contract that names itself MR. BROWN (MRBRN). Owner not established.",
  ),
  ent(
    "nft.tigeracademy",
    "token_contract",
    "Near Tiger Academy NFT contract",
    "cat.nft_game_contracts",
    "NEP-171 contract that names itself Near Tiger Academy (NTA). Owner not established.",
  ),
];

interface M {
  e: string;
  a: string;
  role: Mapping["role"];
  v: Mapping["verification"];
  c: Mapping["confidence"];
  k: Mapping["evidenceKind"];
  url: string;
  note: string;
  lim: string;
  suffix?: boolean;
  p?: number;
  how?: string;
}
const row = (x: M): Mapping => {
  const from = CREATED_AT[x.a];
  return {
    entityId: x.e,
    network: "near",
    matchType: x.suffix ? "suffix" : "exact",
    account: x.a,
    role: x.role,
    effectiveFrom: from ?? WINDOW,
    effectiveTo: null,
    methodology:
      x.how ??
      (x.suffix
        ? "account-hierarchy rule: only a parent account can create its sub-accounts, so every sub-account of the evidenced parent is attributed to the same entity"
        : "exact receiver account id taken from the cited source and cross-checked as a receiver in nearesis_live.contract_interactions"),
    verification: x.v,
    confidence: x.c,
    evidenceKind: x.k,
    evidenceUrl: x.url,
    evidenceNote: x.note,
    limitations: `${x.lim} ${from ? "effective_from is the account creation date (nearblocks); ownership assumed unchanged since." : "effective_from is the start of the observation window: the account creation date was not returned."}`,
    precedence: x.p ?? (x.suffix ? 100 : 10),
  };
};

const SDK = "https://github.com/Near-One/bridge-sdk-rs/blob/main/bridge-cli/src/defaults.rs";
const bridgeSdk = (a: string, what: string, role: Mapping["role"] = "infrastructure"): Mapping =>
  row({
    e: "omni-bridge",
    a,
    role,
    v: "verified",
    c: "high",
    k: "official_repo",
    url: SDK,
    note: `Near-One/bridge-sdk-rs bridge-cli/src/defaults.rs (mainnet constants) names ${a} as ${what}. ${CREATED}`,
    lim: "Counts calls received by this one account only.",
    p: 5,
  });

export const newMappings: Mapping[] = [
  row({
    e: "circle-usdc",
    a: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    role: "token",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
    note: `Circle's USDC contract address page lists this id as the NEAR mainnet USDC address. ${RPC}ft_metadata name USDC, symbol USDC. ${CREATED}`,
    lim: "Token contract only; says nothing about which application moved the token.",
  }),
  row({
    e: "fast-auth",
    a: "fast-auth.near",
    role: "contract",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://auth.near.org/",
    note: `auth.near.org FAQ: shared infrastructure on mainnet (fast-auth.near, jwt.fast-auth.near, v1.signer); 'built and operated by Peersyst'. docs.near.org/web3-apps/tutorials/near-auth names fast-auth.near as the FastAuth contract. ${RPC}contract_source_metadata link github.com/Peersyst/fast-auth. ${CREATED}`,
    lim: "Counts calls to the FastAuth contract; v1.signer stays in Chain Signatures (no double attribution).",
    p: 5,
  }),
  row({
    e: "fast-auth",
    a: "jwt.fast-auth.near",
    role: "contract",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://auth.near.org/",
    note: `auth.near.org names jwt.fast-auth.near as the JWT Guard Router. ${CREATED}`,
    lim: "Exact account only.",
    p: 5,
  }),
  row({
    e: "fast-auth",
    a: ".jwt.fast-auth.near",
    suffix: true,
    role: "instance",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://github.com/Peersyst/fast-auth",
    note: `${RPC}sweat.jwt.fast-auth.near contract_source_metadata link = github.com/Peersyst/fast-auth (same repo as fast-auth.near). The auth.near.org page names jwt.fast-auth.near; it does not list its sub-accounts.`,
    lim: "Sub-accounts of the JWT guard router (per-integrator guards); a guard may serve a third-party app, the guard itself is FastAuth infrastructure.",
  }),
  bridgeSdk("btc-connector.bridge.near", "BTC_CONNECTOR_MAINNET (Omni Bridge Bitcoin connector)", "bridge"),
  bridgeSdk("nbtc.bridge.near", "BTC_MAINNET (the nBTC token on NEAR)", "token"),
  bridgeSdk("nzec.bridge.near", "ZCASH_MAINNET (the nZEC token on NEAR)", "token"),
  bridgeSdk("zcash-connector.bridge.near", "ZCASH_CONNECTOR_MAINNET", "bridge"),
  bridgeSdk("zcash-client.bridge.near", "ZCASH_LIGHT_CLIENT_ID_MAINNET"),
  bridgeSdk(
    "btc-client.bridge.near",
    "BTC_LIGHT_CLIENT_ID_MAINNET (also Near-One/btc-light-client-contract .catalog-info.yaml)",
  ),
  bridgeSdk("mpc-prover.bridge.near", "NEAR_MPC_OMNI_PROVER_ID_MAINNET"),
  row({
    e: "omni-bridge",
    a: "vaa-prover-0_4_13.bridge.near",
    role: "infrastructure",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://github.com/Near-One/omni-bridge",
    note: `${RPC}contract_source_metadata link = github.com/Near-One/omni-bridge (rev acb8c797...), version 0.4.13. The Omni Bridge README lists vaa-prover versions 0_4_1 and 0_4_3, not 0_4_13. ${CREATED}`,
    lim: "Self-declared NEP-330 source link; the version is not listed in the README.",
    p: 5,
  }),
  row({
    e: "omni-bridge",
    a: ".factory.bridge.near",
    suffix: true,
    role: "token",
    v: "inferred",
    c: "medium",
    k: "official_repo",
    url: "https://github.com/Near-One/rainbow-token-connector/blob/main/bridge-token-factory/.catalog-info.yaml",
    note: "Bridge Token Factory on NEAR (deployedAt contract:near/mainnet/factory.bridge.near) manages bridged ERC-20 tokens as NEP-141 tokens; factory.bridge.near is listed in the Omni Bridge README. Sub-account example aaaaaa20...factory.bridge.near ft_metadata = Aurora (AURORA).",
    lim: "Bridged token contracts: the calls are token transfers, attributed to the bridge that minted them, not to the token's issuer.",
    p: 5,
  }),
  row({
    e: "rainbow-bridge",
    a: "client-eth2.bridge.near",
    role: "bridge",
    v: "verified",
    c: "high",
    k: "official_repo",
    url: "https://github.com/Near-One/rainbow-bridge/blob/master/contracts/near/eth-client/.catalog-info.yaml",
    note: "rainbow-bridge eth-client .catalog-info.yaml: 'Ethereum Light Client on NEAR', deployedAt contract:near/mainnet/client-eth2.bridge.near. Near-One/bridge-sdk-rs defaults.rs ETH_LIGHT_CLIENT_ID_MAINNET = client-eth2.bridge.near.",
    lim: "Supersedes the v1 unverified row. Light client calls are relayer submissions, not user activity.",
    p: 5,
  }),
  row({
    e: "wormhole",
    a: "contract.wormhole_crypto.near",
    role: "bridge",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://wormhole.com/docs/reference/contract-addresses/",
    note: "Wormhole contract addresses reference: NEAR Core Contract (mainnet) = contract.wormhole_crypto.near. The official pyth-crosschain target_chains/near README also passes it as the wormhole contract.",
    lim: "Supersedes the v1 unverified row. Core contract only; message-posting calls come largely from guardians' relayers and integrators.",
    p: 5,
  }),
  row({
    e: "wormhole",
    a: "contract.portalbridge.near",
    role: "bridge",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://wormhole.com/docs/reference/contract-addresses/",
    note: "Wormhole contract addresses reference (wrapped token transfer table): NEAR mainnet token bridge = contract.portalbridge.near.",
    lim: "Token bridge contract only.",
    p: 5,
  }),
  row({
    e: "meta-pool",
    a: "meta-pool.near",
    role: "contract",
    v: "verified",
    c: "high",
    k: "official_docs",
    url: "https://docs.near.org/integrations/fungible-tokens",
    note: `NEAR docs name meta-pool.near as the stNEAR (Staked NEAR) token contract. ${RPC}get_contract_info: name Metapool, source github.com/Meta-Pool/liquid-staking-contract, webAppUrl https://metapool.app. ${CREATED}`,
    lim: "The contract only; Meta Pool's other contracts are not claimed.",
  }),
  row({
    e: "linear",
    a: "linear-protocol.near",
    role: "contract",
    v: "verified",
    c: "high",
    k: "official_repo",
    url: "https://github.com/linear-protocol/LiNEAR",
    note: `Official LiNEAR README: 'LiNEAR contract and $LiNEAR token: linear-protocol.near' (mainnet). ${RPC}contract_source_metadata link github.com/linear-protocol/LiNEAR. ${CREATED}`,
    lim: "The contract only; pool sub-accounts are not claimed.",
  }),
  row({
    e: "rhea",
    a: "aggregatedex.near",
    role: "contract",
    v: "verified",
    c: "medium",
    k: "official_repo",
    url: "https://github.com/rhea-finance/rhea-sdk-docs/blob/main/SmartRouterV2(Aggregated%20DEX).md",
    note: `Rhea SDK docs (github.com/rhea-finance/rhea-sdk-docs, SmartRouterV2): 'Aggregated DEX Contract: aggregatedex.near'. ${RPC}get_owner returned deltatrade.near. ${CREATED}`,
    lim: "Confidence medium: the github org rhea-finance is not GitHub-verified and the on-chain owner is deltatrade.near (an operator/integrator relationship was not established). Attribution follows the Rhea documentation.",
  }),
  row({
    e: "rhea",
    a: "aggregate-oracle.near",
    role: "contract",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://github.com/rhea-finance/agg-oracle",
    note: `${RPC}contract_source_metadata link = github.com/rhea-finance/agg-oracle (nep330, version 0.4.1); the same code hash is deployed at agg-oracle.stg.ref-dev-team.near. The repository itself is not publicly retrievable (HTTP 404), so only the self-declared link is evidence. ${CREATED}`,
    lim: "Self-declared NEP-330 link to the Rhea org; no official page names the account.",
  }),
  row({
    e: "rhea",
    a: "agg-oracle.stg.ref-dev-team.near",
    role: "contract",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://github.com/rhea-finance/agg-oracle",
    note: `${RPC}same code hash (9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg) and the same NEP-330 link as aggregate-oracle.near; staging account under ref-dev-team.near. ${CREATED}`,
    lim: "Staging deployment; self-declared source link only.",
  }),
  row({
    e: "pyth-near",
    a: "pyth-oracle.near",
    role: "contract",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://github.com/pyth-network/pyth-crosschain/tree/main/target_chains/near",
    note: `${RPC}contract_source_metadata link = github.com/pyth-network/pyth-crosschain (target_chains/near/receiver, rev c3b0f717...). Pyth's docs now say NEAR is no longer supported by Pyth Core, so no official page lists the account. ${CREATED}`,
    lim: "Self-declared NEP-330 link to the official Pyth repo; the account owner is not confirmed by Pyth.",
  }),
  row({
    e: "nft.cooldogsclub",
    a: "cooldogsclub.near",
    role: "token",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://nearblocks.io/address/cooldogsclub.near",
    note: `${RPC}nft_metadata: spec nft-1.0.0, name 'Cool Dogs Club', symbol CDC. No official project site, marketplace listing or directory entry was found (web searches returned only unrelated Ethereum collections). ${CREATED}`,
    lim: "Identifies the contract as an NFT collection, not its owner or what drives the receipts (probably minting or in-game calls). Owner not established.",
    how: "exact account id; entity is the contract itself, identified by its own on-chain nft_metadata",
  }),
  row({
    e: "ft.unites",
    a: "embr.playember_reserve.near",
    role: "token",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://nearblocks.io/address/embr.playember_reserve.near",
    note: `${RPC}ft_metadata: name 'Unites', symbol UNTS. The parent namespace playember_reserve.near and PlayEmber's NEAR presence (CoinDesk/The Block coverage) suggest a link, but no official PlayEmber page naming this account was retrievable (playember.com returned 403). ${CREATED}`,
    lim: "Identifies the contract as a fungible token; the PlayEmber link is NOT claimed. Owner not established.",
    how: "exact account id; entity is the contract itself, identified by its own on-chain ft_metadata",
  }),
  row({
    e: "harvest-moon",
    a: "aa-harvest-moon.near",
    role: "token",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://meteorwallet.gitbook.io/harvest-moon-guide/harvest-moon/faq",
    note: `${RPC}ft_metadata: name 'Moonlight Token', symbol MOON. Meteor Wallet's official Harvest Moon guide describes MOON as the in-game currency but does not list the contract id. ${CREATED}`,
    lim: "Contract id not named by an official page: the link to Harvest Moon rests on the matching token name and symbol. Medium, not verified.",
    how: "exact account id; token identity from ft_metadata, game identity corroborated by the official guide's description of MOON",
  }),
  row({
    e: "nft.mrbrown",
    a: "mrbrownproject.near",
    role: "token",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://nearblocks.io/address/mrbrownproject.near",
    note: `${RPC}nft_metadata: name 'MR. BROWN', symbol MRBRN. No official project page found. Creation date not returned by the API.`,
    lim: "Identifies the contract as an NFT collection only. Owner not established.",
    how: "exact account id; entity is the contract itself, identified by its own on-chain nft_metadata",
  }),
  row({
    e: "nft.tigeracademy",
    a: "tigeracademy.near",
    role: "token",
    v: "inferred",
    c: "medium",
    k: "onchain",
    url: "https://nearblocks.io/address/tigeracademy.near",
    note: `${RPC}nft_metadata: name 'Near Tiger Academy', symbol NTA. No official project page found. Creation date not returned by the API.`,
    lim: "Identifies the contract as an NFT collection only. Owner not established.",
    how: "exact account id; entity is the contract itself, identified by its own on-chain nft_metadata",
  }),
];

const SUPERSEDED = new Set(["client-eth2.bridge.near", "contract.wormhole_crypto.near"]);

export const registryV2: Registry = {
  registryVersion: REGISTRY_VERSION_V2,
  publishedAt: PUBLISHED_AT_V2,
  entities: [...entitiesV1, ...newEntities],
  mappings: [...mappingsV1.filter((m) => !SUPERSEDED.has(m.account)), ...newMappings],
  relations: relationsV1,
};

/** Receivers examined and left unclassified, with what was checked (reported in the handoff, asserted in tests). */
export const UNCLASSIFIED_NOTES: Record<string, string> = {
  "x.paras.near":
    "No contract metadata or source link on-chain; docs.near.org NFT page does not name it; no official Paras page retrieved.",
  "meteor.poolv1.near": "Staking pool under poolv1.near; no official source retrieved naming it.",
  "nearlytrade.near":
    "On-chain NEP-330 link github.com/sam3dsol/Nearlytrade (personal account) and owner nearlytrade.sputnik-dao.near; no official project site retrieved.",
  "acc.ref-labs.near":
    "Satoshi BTC bridge account contract owned by ref-labs DAO; relation to Rhea products not established.",
  "contract.main.burrow.near":
    "No official source retrieved; Burrow/Rhea relation only on third-party pages.",
  "coin.abound.near": "NEP-330 link points to a bitbucket repo of 'joinabound'; no official page retrieved.",
};
