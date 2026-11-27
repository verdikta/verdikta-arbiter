/* Gas money for the owner wallet's calls.
 *
 * A registration that the owner wallet cannot pay for used to end in a wall of
 * output: "Gas estimation failed" (it had not), a retry at a fallback gas
 * limit, four static calls at other limits, a third send, and a ProviderError
 * with its stack. On 2026-11-21 that was the whole account of a job-count
 * change whose deregistrations had spent the wallet. These helpers say it in
 * one line, before anything is sent where that is possible:
 *
 *   checkGasBudget   — the wallet's balance against the most the calls about
 *                      to be sent can cost;
 *   isInsufficientFunds / ownerFundsError — the same sentence for a send the
 *                      node refused anyway.
 *
 * The deregistration that starts a job change checks the registrations that
 * follow it too (unregister-oracle-cl.js --then-register): that day the wallet
 * could pay for the ten deregistrations and not for what came after, and the
 * node was left with no job registered.
 *
 * No ethers here: the provider is passed in, amounts are wei as BigInt.
 */

const OWNER_FUNDS = "OWNER_FUNDS";
/* Exit code of unregister-oracle-cl.js (and so of unregister-oracle.sh) when
 * the owner wallet cannot pay; upgrade-arbiter.sh reads it. 65 is taken. */
const OWNER_FUNDS_EXIT = 66;

/* The most gas each kind of call is given by the script that sends it.
 *   register       estimated per call, times 1.2 (about 360,000 with 30
 *                  identities in the keeper's registry, which it walks);
 *                  falls back to 500,000
 *   approve        sent with this limit (a wVDKA approval uses about 50,000)
 *   deregister     estimated, times 1.2 (150,000 to 180,000 used); falls back
 *                  to 300,000
 *   authorizeKeys  setAuthorizedSenders.js: estimated, times 1.2; falls back
 *                  to 500,000 */
const GAS_BUDGET = Object.freeze({
  register: 500_000,
  approve: 100_000,
  deregister: 300_000,
  authorizeKeys: 500_000,
});

const RERUN_REGISTER = "job ids already registered are skipped";
const RERUN_DEREGISTER = "job ids already deregistered are skipped";

function formatEth(wei) {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const fraction = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  // Anything smaller than the eight places shown is still not nothing.
  if (abs > 0n && text === "0") return `${negative ? "-" : ""}<0.00000001`;
  return `${negative ? "-" : ""}${text}`;
}

function formatGwei(wei) {
  const whole = wei / 10n ** 9n;
  const fraction = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/* Every place a provider, ethers or Hardhat puts the node's text. */
function errorTexts(e, depth = 0) {
  if (e == null || depth > 4) return [];
  if (typeof e === "string") return [e];
  const texts = [e.code, e.message, e.shortMessage, e.reason].filter((t) => typeof t === "string");
  for (const inner of [e.error, e.cause, e.info && e.info.error, e.parent]) texts.push(...errorTexts(inner, depth + 1));
  return texts;
}

function isInsufficientFunds(e) {
  return errorTexts(e).some((t) => /INSUFFICIENT_FUNDS|insufficient funds|insufficient balance/i.test(t));
}

/* geth: "insufficient funds for gas * price + value: have 296326845228620 want 2138235000000000" */
function parseHaveWant(e) {
  for (const t of errorTexts(e)) {
    const m = /have (\d+) want (\d+)/.exec(t);
    if (m) return { have: BigInt(m[1]), want: BigInt(m[2]) };
  }
  return null;
}

function ownerFundsError({ sender, balance, needed, what, gasPrice = null, pinned = false, rerun = RERUN_REGISTER }) {
  const price =
    gasPrice == null
      ? ""
      : pinned
        ? ` at the pinned gas price of ${formatGwei(gasPrice)} gwei (VERDIKTA_GAS_PRICE_GWEI)`
        : ` at up to ${formatGwei(gasPrice)} gwei`;
  const e = new Error(
    `The owner wallet ${sender} holds ${formatEth(balance)} ETH and ${what} can take ${formatEth(needed)} ETH in gas${price}. ` +
      `Nothing was sent for it. Send the wallet at least ${formatEth(needed - balance)} ETH more and run this again: ${rerun}.`
  );
  e.code = OWNER_FUNDS;
  return e;
}

/* The price a call's gas limit is multiplied by when the node decides whether
 * the sender can afford it: the pinned price, or the network's max fee. */
async function budgetGasPrice({ provider, configured }) {
  if (typeof configured === "number" && configured > 0) return { gasPrice: BigInt(configured), pinned: true };
  const fees = await provider.getFeeData();
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  if (gasPrice == null) throw new Error("the RPC endpoint gave no gas price (eth_gasPrice and the latest block's base fee are both missing)");
  return { gasPrice: BigInt(gasPrice), pinned: false };
}

/* What a deregistration run can send, and with thenRegister > 0 what the job
 * change it starts sends after it: the registrations, their approval and the
 * key authorization. Returns { calls, what } for checkGasBudget; null when
 * there is nothing to pay for. */
function deregistrationBudget({ deregistrations, thenRegister = 0 }) {
  if (deregistrations === 0 && thenRegister === 0) return null;
  const calls = [{ count: deregistrations, gas: GAS_BUDGET.deregister }];
  let what = `${deregistrations} deregistration(s)`;
  if (thenRegister > 0) {
    calls.push(
      { count: thenRegister, gas: GAS_BUDGET.register },
      { count: 1, gas: GAS_BUDGET.approve },
      { count: 1, gas: GAS_BUDGET.authorizeKeys }
    );
    what += ` and the ${thenRegister} registration(s) that follow (with their approval and the key authorization)`;
  }
  return { calls, what };
}

/* calls: [{ count, gas }] — the most gas each kind of call is given. Throws
 * ownerFundsError when the balance does not cover all of them. */
async function checkGasBudget({ provider, sender, calls, configuredGasPrice, what, rerun = RERUN_REGISTER, log = console.log }) {
  const { gasPrice, pinned } = await budgetGasPrice({ provider, configured: configuredGasPrice });
  const gas = calls.reduce((sum, c) => sum + BigInt(c.count) * BigInt(c.gas), 0n);
  const needed = gas * gasPrice;
  const balance = BigInt(await provider.getBalance(sender));
  log(`Owner ETH balance: ${formatEth(balance)}`);
  log(`Gas for ${what}: up to ${formatEth(needed)} ETH (${gas} gas at ${pinned ? "the pinned" : "up to"} ${formatGwei(gasPrice)} gwei)`);
  if (balance < needed) throw ownerFundsError({ sender, balance, needed, what, gasPrice, pinned, rerun });
  return { balance, needed, gasPrice, pinned };
}

/* A send the node refused for lack of funds, as the same sentence. */
async function describeRefusedSend({ error, provider, sender, what, rerun = RERUN_REGISTER }) {
  const parsed = parseHaveWant(error);
  let balance = parsed ? parsed.have : null;
  if (balance == null) {
    try {
      balance = BigInt(await provider.getBalance(sender));
    } catch {
      balance = null;
    }
  }
  if (balance == null || !parsed) {
    const e = new Error(
      `The owner wallet ${sender} cannot pay the gas for ${what}` +
        (balance == null ? "" : ` (it holds ${formatEth(balance)} ETH)`) +
        `. Fund it and run this again: ${rerun}.`
    );
    e.code = OWNER_FUNDS;
    return e;
  }
  return ownerFundsError({ sender, balance, needed: parsed.want, what, rerun });
}

module.exports = {
  OWNER_FUNDS,
  OWNER_FUNDS_EXIT,
  GAS_BUDGET,
  RERUN_REGISTER,
  RERUN_DEREGISTER,
  formatEth,
  formatGwei,
  isInsufficientFunds,
  parseHaveWant,
  ownerFundsError,
  budgetGasPrice,
  deregistrationBudget,
  checkGasBudget,
  describeRefusedSend,
};
