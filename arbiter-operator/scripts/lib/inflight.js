/* In-flight transaction guard for the registration scripts (issues #29, #38).
 *
 * Some RPC providers (Infura, for EIP-7702 delegated accounts such as a
 * MetaMask smart account) cap the number of in-flight transactions per
 * sender and reject the next send with "in-flight transaction limit reached
 * for delegated accounts" even though each tx.wait() has returned — their
 * view lags a block or two. Before every send, wait until the sender's
 * pending nonce equals its mined nonce; on that specific error, back off and
 * retry. Any other error is rethrown at once.
 *
 * Used by register-oracle-cl.js and unregister-oracle-cl.js so a run of ten
 * registrations or deregistrations survives the cap instead of dying on the
 * eighth send (#38 — the deregistration half of a count change died that
 * way and the upgrade with it).
 */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isInFlightLimit(e) {
  return /in-flight transaction limit/i.test(String(e && (e.message || e)));
}

function createInFlightGuard({
  provider,
  sender,
  log = console.log,
  sleep = defaultSleep,
  settleTries = 30,
  settleDelayMs = 3000,
  retries = 5,
  retryDelayMs = 10000,
}) {
  const waitForNonceSettle = async (label) => {
    for (let i = 0; i < settleTries; i++) {
      const [pending, latest] = await Promise.all([
        provider.getTransactionCount(sender, "pending"),
        provider.getTransactionCount(sender, "latest"),
      ]);
      if (pending === latest) return true;
      if (i === 0) log(`  waiting for ${pending - latest} in-flight tx to settle before ${label}…`);
      await sleep(settleDelayMs);
    }
    log(`  in-flight transactions did not settle within ${Math.round((settleTries * settleDelayMs) / 1000)} s; continuing anyway`);
    return false;
  };

  const sendWithRetry = async (label, fn) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      await waitForNonceSettle(label);
      try {
        return await fn();
      } catch (e) {
        if (!isInFlightLimit(e) || attempt === retries) throw e;
        log(`  provider in-flight limit hit (attempt ${attempt}); backing off ${Math.round(retryDelayMs / 1000)} s and retrying…`);
        await sleep(retryDelayMs);
      }
    }
    return undefined;
  };

  return { waitForNonceSettle, sendWithRetry, isInFlightLimit };
}

module.exports = { createInFlightGuard, isInFlightLimit };
