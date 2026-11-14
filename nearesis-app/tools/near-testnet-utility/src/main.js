import "./polyfills.js";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as C from "./config.js";
import { preflight, tokenState, finalTx, accessKeys } from "./chain.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { $("log").textContent += `[${new Date().toISOString()}] ${msg}\n`; $("log").scrollTop = 1e9; };

// ---- de-duplication ledger -------------------------------------------------
// The chain is the primary guard (registered? balance?). This ledger adds a
// second one: once a transaction for an action has been handed to the wallet,
// the button stays locked until the chain shows the outcome.
const LEDGER_KEY = "nearesis.ntu.ledger.v1";
function ledgerGet() { try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || "{}"); } catch { return {}; } }
function ledgerSet(action, entry) { try { const l = ledgerGet(); l[action] = { ...entry, at: new Date().toISOString() }; localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch { /* storage unavailable: chain guard still applies */ } }

// ---- state -----------------------------------------------------------------
let selector, wallet, accountId = null;
let checksOk = false, state = null, busy = false;

// Meteor's SDK (trySendOrCreateTransaction) signs locally ONLY when the local
// key's public key exists on-chain for the account; otherwise it opens the
// approval screen. So the precise guard is: is the local public key on-chain?
// The public key comes from the wallet's account info; the secret is never read.
async function localKeyCheck() {
  const present = meteorLocalKeyPresent();
  if (!present) return { id: "no_silent_key_local", ok: true, detail: "no local Meteor key for this account" };
  let pub = null;
  try { pub = (await wallet?.getAccounts())?.[0]?.publicKey || null; } catch { pub = null; }
  if (!pub) return { id: "no_silent_key_local", ok: false, detail: "Meteor holds a local key but its public key is unknown: cannot prove it is unusable. Disconnect first." };
  const onchain = (await accessKeys(C.ACCOUNT_ID)).map((k) => k.public_key);
  const usable = onchain.includes(pub);
  return {
    id: "no_silent_key_local", ok: !usable,
    detail: usable
      ? `local key ${pub} IS registered on-chain: it could sign without a prompt. Disconnect first.`
      : `local key ${pub} is not registered on-chain (${onchain.length} on-chain key(s)), so it cannot sign; Meteor must ask for approval`,
  };
}

function meteorLocalKeyPresent() {
  // Meteor keeps function-call keys in localStorage under "_meteor_wallet<account>:<network>".
  // We only test for presence and never read or display the value.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("_meteor_wallet") && k.includes(`${C.ACCOUNT_ID}:${C.NETWORK_ID}`)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function render() {
  const connected = accountId !== null;
  $("btn-connect").hidden = connected;
  $("btn-disconnect").hidden = !connected;
  $("wallet-status").textContent = connected ? `Connected: ${accountId} (${selector.options.network.networkId})` : "Not connected";

  const l = ledgerGet();
  const canWrite = connected && checksOk && !busy && state;
  $("btn-register").disabled = !(canWrite && !state.registered && l.register?.status !== "submitted");
  $("btn-mint").disabled = !(canWrite && state.registered && BigInt(state.balance) < BigInt(C.MINT_AMOUNT) && l.mint?.status !== "submitted" && l.mint?.status !== "success");

  if (state) {
    if (state.registered && !$("register-result").textContent) $("register-result").textContent = "Already registered on-chain: nothing to do.";
    if (BigInt(state.balance) >= BigInt(C.MINT_AMOUNT) && !$("mint-result").textContent) $("mint-result").textContent = "Balance is already at least 10 USDC.e: mint locked.";
  }
}

async function runChecks() {
  $("checks").innerHTML = '<li class="muted">Running…</li>';
  try {
    const checks = await preflight(accountId, accountId ? selector.options.network.networkId : null);
    checks.push(await localKeyCheck());
    state = await tokenState();
    checksOk = checks.every((c) => c.ok);
    $("checks").innerHTML = checks.map((c) => `<li><span class="${c.ok ? "pass" : "fail"}">${c.ok ? "PASS" : "FAIL"}</span><span><b>${c.id}</b>: ${escapeHtml(c.detail)}</span></li>`).join("")
      + `<li><span class="muted">STATE</span><span>registered = <b>${state.registered}</b>, ft_balance_of = <b>${fmt(state.balance)} USDC.e</b> (${state.balance})</span></li>`;
    log(`preflight: ${checksOk ? "all pass" : "BLOCKED: " + checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}; registered=${state.registered} balance=${state.balance}`);
    await reconcileLedger();
  } catch (e) {
    checksOk = false;
    $("checks").innerHTML = `<li><span class="fail">ERROR</span><span>${escapeHtml(e.message)}</span></li>`;
    log(`preflight error: ${e.message}`);
  }
  render();
}

// If a transaction was handed to the wallet but the page lost track of it,
// the chain decides: registration exists / balance reached => success.
async function reconcileLedger() {
  const l = ledgerGet();
  if (l.register?.status === "submitted" && state.registered) ledgerSet("register", { ...l.register, status: "success", reconciled: true });
  if (l.mint?.status === "submitted" && BigInt(state.balance) >= BigInt(C.MINT_AMOUNT)) ledgerSet("mint", { ...l.mint, status: "success", reconciled: true });
}

const fmt = (raw) => (Number(BigInt(raw)) / 10 ** C.EXPECTED_DECIMALS).toFixed(6);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const txLink = (h) => `<a href="${C.EXPLORER_TX}${h}" target="_blank" rel="noopener">${h}</a>`;

// ---- wallet ----------------------------------------------------------------
async function connect() {
  try {
    wallet = await selector.wallet("meteor-wallet");
    // No contractId: Meteor creates no function-call key, so every transaction
    // has to go through its approval screen.
    const accounts = await wallet.signIn({});
    accountId = accounts?.[0]?.accountId ?? null;
    log(`connected: ${accountId}`);
    if (accountId !== C.ACCOUNT_ID) log(`WRONG ACCOUNT: expected ${C.ACCOUNT_ID}; writes stay locked`);
  } catch (e) { log(`connect failed: ${e.message}`); }
  await runChecks();
}

async function disconnect() {
  try { await wallet?.signOut(); } catch (e) { log(`sign-out: ${e.message}`); }
  accountId = null; log("disconnected");
  await runChecks();
}

// ---- transactions ----------------------------------------------------------
async function send(action, method, args, depositYocto, resultEl) {
  if (busy) return;
  busy = true; render();
  const el = $(resultEl);
  try {
    // Fresh checks immediately before signing (state may have changed).
    await runChecks();
    if (!checksOk) throw new Error("pre-flight checks failed: not sending");
    if (action === "register" && state.registered) throw new Error("already registered: not sending");
    if (action === "mint" && (!state.registered || BigInt(state.balance) >= BigInt(C.MINT_AMOUNT))) throw new Error("mint preconditions not met: not sending");

    busy = true; render();
    ledgerSet(action, { status: "submitted" });
    el.className = "result warn"; el.textContent = "Waiting for your approval in Meteor…";
    log(`${action}: requesting signature for ${C.TOKEN_ID}.${method}(${JSON.stringify(args)}) deposit=${depositYocto} gas=${C.GAS_30_TGAS}`);

    const outcome = await wallet.signAndSendTransaction({
      signerId: C.ACCOUNT_ID,
      receiverId: C.TOKEN_ID,
      actions: [actionCreators.functionCall(method, args, BigInt(C.GAS_30_TGAS), BigInt(depositYocto))],
    });
    const hash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
    if (!hash) throw new Error("wallet returned no transaction hash; check the explorer before retrying");
    ledgerSet(action, { status: "submitted", hash });
    el.innerHTML = `Submitted ${txLink(hash)}: verifying final status on-chain…`;

    // Independent verification: final status + the exact call that executed.
    const t = await finalTx(hash, C.ACCOUNT_ID);
    const matches = t.signer === C.ACCOUNT_ID && t.receiver === C.TOKEN_ID && t.actionCount === 1 && t.method === method
      && JSON.stringify(t.args) === JSON.stringify(args) && t.deposit === depositYocto;
    log(`${action}: tx ${hash} finality=${t.finality} success=${t.success} matches_request=${matches}${t.failure ? " failure=" + t.failure : ""}`);
    if (!t.success) { ledgerSet(action, { status: "failed", hash }); el.className = "result bad"; el.innerHTML = `FAILED on-chain: ${txLink(hash)}<br>${escapeHtml(t.failure)}`; return; }
    ledgerSet(action, { status: "success", hash, finality: t.finality, matches });
    el.className = matches ? "result ok" : "result warn";
    el.innerHTML = `${matches ? "Success" : "Succeeded, but the executed call differs from the request: review"} (${t.finality}): ${txLink(hash)}`;

    state = await tokenState();
    if (action === "register") el.innerHTML += `<br>storage_balance_of: ${escapeHtml(JSON.stringify(state.storage))}`;
    if (action === "mint") {
      const exact = state.balance === C.MINT_AMOUNT;
      el.innerHTML += `<br>ft_balance_of = <b>${fmt(state.balance)} USDC.e</b> (${state.balance}) ${exact ? "✓ exactly 10 USDC.e" : "≠ 10 USDC.e: check"}`;
      log(`mint: ft_balance_of=${state.balance} exact10=${exact}`);
    }
  } catch (e) {
    el.className = "result bad"; el.textContent = e.message;
    log(`${action}: ${e.message}`);
    // A rejection before any hash leaves nothing pending on-chain; unlock only
    // after the chain has been re-read (render() re-applies the chain guards).
    const l = ledgerGet()[action];
    if (l?.status === "submitted" && !l.hash) ledgerSet(action, { status: "not_sent" });
  } finally {
    busy = false;
    await runChecks();
  }
}

async function checkBalance() {
  const el = $("balance-result");
  try {
    state = await tokenState();
    el.className = "result"; el.innerHTML = `registered = <b>${state.registered}</b> · ft_balance_of = <b>${fmt(state.balance)} USDC.e</b> (${state.balance})`;
    log(`balance: registered=${state.registered} ft_balance_of=${state.balance}`);
  } catch (e) { el.className = "result bad"; el.textContent = e.message; }
  render();
}

// ---- boot ------------------------------------------------------------------
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

async function boot() {
  $("btn-recheck").onclick = runChecks;
  $("btn-balance").onclick = checkBalance;
  $("btn-register").onclick = () => send("register", "storage_deposit", C.REGISTER_ARGS, C.STORAGE_DEPOSIT_YOCTO, "register-result");
  $("btn-mint").onclick = () => send("mint", "mint", C.MINT_ARGS, "0", "mint-result");
  $("btn-connect").disabled = true;

  // Chain checks first: they do not depend on the wallet.
  log("boot: reading testnet state");
  await runChecks();

  log("boot: initialising Wallet Selector (testnet, Meteor)");
  selector = await withTimeout(setupWalletSelector({ network: C.NETWORK_ID, modules: [setupMeteorWallet()] }), 20000, "Wallet Selector setup");
  if (selector.options.network.networkId !== "testnet") throw new Error("selector not on testnet: aborting");
  const st = selector.store.getState();
  if (st.selectedWalletId === "meteor-wallet" && st.accounts.length) {
    wallet = await selector.wallet("meteor-wallet");
    accountId = st.accounts[0].accountId;
    log(`restored session: ${accountId}`);
  }
  $("btn-connect").onclick = connect;
  $("btn-disconnect").onclick = disconnect;
  $("btn-connect").disabled = false;
  log("boot: ready");
  await runChecks();
}
boot().catch((e) => { log(`boot failed: ${e.message}`); $("checks").innerHTML = `<li><span class="fail">ERROR</span><span>${escapeHtml(e.message)}</span></li>`; });
