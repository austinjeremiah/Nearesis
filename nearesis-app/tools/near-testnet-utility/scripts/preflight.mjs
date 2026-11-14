// Node runner for the same read-only checks the page performs (no wallet).
// `npm run check` — useful to confirm the chain state before opening the page.
import { preflight, tokenState } from "../src/chain.js";
import * as C from "../src/config.js";

const checks = await preflight(C.ACCOUNT_ID, C.NETWORK_ID); // wallet checks assumed; the page re-checks for real
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(22)} ${c.detail}`);
const s = await tokenState();
console.log(`STATE registered=${s.registered} storage=${JSON.stringify(s.storage)} ft_balance_of=${s.balance}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
