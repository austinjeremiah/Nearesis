// Independent read-only checks against NEAR testnet JSON-RPC. No wallet code
// here: this is what the page trusts, not what the wallet says.
import * as C from "./config.js";

async function rpc(method, params) {
  const res = await fetch(C.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "u", method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  if (j.result && j.result.error) throw new Error(`RPC ${method}: ${j.result.error}`);
  return j.result;
}

const b64 = (s) => btoa(s);
const fromBytes = (arr) => new TextDecoder().decode(new Uint8Array(arr));

export async function view(contract, method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function", finality: "final",
    account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)),
  });
  const text = fromBytes(r.result);
  return text ? JSON.parse(text) : null;
}

export async function chainId() {
  return (await rpc("status", [])).chain_id;
}

export async function contractCode(accountId) {
  const r = await rpc("query", { request_type: "view_code", finality: "final", account_id: accountId });
  const bin = atob(r.code_base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
  return { hash: r.hash, exports };
}

export async function accessKeys(accountId) {
  return (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId })).keys;
}

export async function accountExists(accountId) {
  const r = await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
  return { amount: r.amount };
}

/** Final status of a transaction, plus the exact action that was executed. */
export async function finalTx(hash, signer) {
  const r = await rpc("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
  const t = r.transaction;
  const fc = t.actions.length === 1 && t.actions[0].FunctionCall ? t.actions[0].FunctionCall : null;
  return {
    hash: t.hash,
    signer: t.signer_id,
    receiver: t.receiver_id,
    finality: r.final_execution_status,
    success: Object.prototype.hasOwnProperty.call(r.status, "SuccessValue"),
    failure: r.status.Failure ? JSON.stringify(r.status.Failure) : null,
    method: fc ? fc.method_name : null,
    args: fc ? JSON.parse(atob(fc.args)) : null,
    deposit: fc ? fc.deposit : null,
    gas: fc ? String(fc.gas) : null,
    actionCount: t.actions.length,
  };
}

/**
 * Every precondition the owner asked for, evaluated fresh. Returns a list of
 * {id, ok, detail}; the caller blocks writes if any required check fails.
 */
export async function preflight(connectedAccountId, walletNetworkId) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  const cid = await chainId();
  add("rpc_network", cid === C.NETWORK_ID, `RPC chain_id = ${cid}`);
  add("wallet_network", walletNetworkId === C.NETWORK_ID, `wallet selector network = ${walletNetworkId ?? "not connected"}`);
  add("wallet_account", connectedAccountId === C.ACCOUNT_ID, `connected = ${connectedAccountId ?? "none"}, expected ${C.ACCOUNT_ID}`);

  const code = await contractCode(C.TOKEN_ID);
  add("code_hash", code.hash === C.EXPECTED_CODE_HASH, `code hash ${code.hash}`);
  const missing = C.REQUIRED_EXPORTS.filter((m) => !code.exports.includes(m));
  add("mint_interface", missing.length === 0, missing.length ? `missing exports: ${missing.join(", ")}` : `exports present: ${C.REQUIRED_EXPORTS.join(", ")}`);

  const meta = await view(C.TOKEN_ID, "ft_metadata");
  add("token_metadata", meta.decimals === C.EXPECTED_DECIMALS && meta.symbol === C.EXPECTED_SYMBOL, `${meta.name} (${meta.symbol}), decimals ${meta.decimals}`);

  const bounds = await view(C.TOKEN_ID, "storage_balance_bounds");
  add("storage_bounds", bounds.min === C.STORAGE_DEPOSIT_YOCTO, `min ${bounds.min}, max ${bounds.max ?? "none"} (approved ${C.STORAGE_DEPOSIT_YOCTO})`);

  // Silent-signing guard: a function-call key for the token contract would let
  // the wallet SDK sign `mint` (0 deposit) without an approval prompt.
  const keys = await accessKeys(C.ACCOUNT_ID);
  const fcForToken = keys.filter((k) => k.access_key.permission.FunctionCall && k.access_key.permission.FunctionCall.receiver_id === C.TOKEN_ID);
  add("no_silent_key_onchain", fcForToken.length === 0, fcForToken.length ? `function-call key(s) for ${C.TOKEN_ID}: ${fcForToken.map((k) => k.public_key).join(", ")}` : `${keys.length} key(s), none limited to ${C.TOKEN_ID}`);

  return checks;
}

export async function tokenState() {
  const [storage, balance] = await Promise.all([
    view(C.TOKEN_ID, "storage_balance_of", { account_id: C.ACCOUNT_ID }),
    view(C.TOKEN_ID, "ft_balance_of", { account_id: C.ACCOUNT_ID }),
  ]);
  return { registered: storage !== null, storage, balance: String(balance) };
}
