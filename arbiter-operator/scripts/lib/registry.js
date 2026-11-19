/* What the ReputationKeeper has registered for one operator contract, and the
 * deregistration run built on it.
 *
 * The installer used to deregister only the job ids written in
 * installer/.contracts and to treat "Not registered – skipping" for every one
 * of them as success. When that file no longer named the job that was actually
 * registered, a job-count change replaced the node's jobs, registered the new
 * ids and left the old one on the keeper with its 100 wVDKA stake and no node
 * behind it (Base mainnet, 2026-11-11). The keeper's registry is the only
 * record of where the stake is, so this module reads it:
 *
 *   listRegisteredJobs  every job id the keeper lists for the operator
 *   runDeregistration   deregister the ids given, optionally every other id
 *                       the keeper lists for the operator too, and then
 *                       require that the keeper lists none
 *
 * No ethers here: the keeper is passed in (an ethers Contract in the scripts,
 * a fake in registry.test.js), so the logic is tested without a chain.
 */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A job id is the 32-character Chainlink external job id as UTF-8 text in a
 * bytes32; a full 0x…64 value is taken as is. */
function toBytes32(id) {
  const s = String(id);
  if (/^0x[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const hex = Buffer.from(s, "utf8").toString("hex");
  if (hex.length > 64) throw new Error(`Job ID too long: ${s}`);
  return "0x" + hex.padEnd(64, "0");
}

/* The text form for messages; the hex value when it is not printable text. */
function jobIdText(bytes32) {
  const raw = Buffer.from(String(bytes32).slice(2), "hex");
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  const text = raw.subarray(0, end).toString("latin1");
  return /^[\x21-\x7e]+$/.test(text) ? text : String(bytes32).toLowerCase();
}

/* registerOracle() sets stake and isActive; setOracleActive(false) pauses an
 * oracle with its stake in place, and a slash can take the stake to zero on an
 * oracle that is still listed. deregisterOracle() accepts any of the three, so
 * that is what "registered" means here. `isActive` alone skipped a paused
 * oracle and left its stake. */
function isRegistered(info) {
  if (!info) return false;
  const stake = info.stakeAmount === undefined ? info[6] : info.stakeAmount;
  const active = info.isActive === undefined ? info[0] : info.isActive;
  const blocked = info.blocked === undefined ? info[8] : info.blocked;
  return Boolean(active) || Boolean(blocked) || (stake !== undefined && BigInt(stake) > 0n);
}

async function withRetry(fn, { tries = 4, delayMs = 1500, sleep = defaultSleep } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt < tries) await sleep(delayMs * attempt);
    }
  }
  throw last;
}

/* Every job id the keeper lists for `oracle` (bytes32, lower case), in
 * registry order. The registry is an array that deregisterOracle() edits with
 * swap-and-pop, so it can change under the walk: the length is read again
 * afterwards and the walk repeated until two reads agree. A read that keeps
 * failing is an error — the caller must not take "could not read" for "none". */
async function listRegisteredJobs(keeper, oracle, { passes = 4, tries, delayMs, sleep } = {}) {
  const want = String(oracle).toLowerCase();
  const retry = { tries, delayMs, sleep };
  let lastError;
  for (let pass = 1; pass <= passes; pass++) {
    try {
      const count = Number(await withRetry(() => keeper.getRegisteredOraclesCount(), retry));
      const found = [];
      for (let i = 0; i < count; i++) {
        const entry = await withRetry(() => keeper.registeredOracles(i), retry);
        const entryOracle = entry.oracle === undefined ? entry[0] : entry.oracle;
        const entryJob = entry.jobId === undefined ? entry[1] : entry.jobId;
        if (String(entryOracle).toLowerCase() === want) found.push(String(entryJob).toLowerCase());
      }
      const after = Number(await withRetry(() => keeper.getRegisteredOraclesCount(), retry));
      if (after === count) return [...new Set(found)];
      lastError = new Error(`the registry changed during the read (${count} → ${after} entries)`);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`could not read the keeper's registry: ${(lastError && lastError.message) || lastError}`);
}

/* Deregister `jobIds` (text or bytes32) for `oracle`.
 *
 *   allRegistered  also deregister every other job id the keeper lists for the
 *                  operator, and fail unless the keeper lists none afterwards.
 *                  A job change (count change, regenerated job specs) replaces
 *                  every job of the node, so nothing of the operator's may stay
 *                  behind. Without it, such ids are reported and left alone.
 *   deregisterOne  async (bytes32, label) — sends the transaction and waits.
 *
 * Returns { deregistered, skipped, unlisted, remaining } (bytes32 arrays).
 * Throws when a send fails, when allRegistered is set and the registry cannot
 * be read, or when ids are still registered at the end. */
async function runDeregistration({
  keeper,
  oracle,
  jobIds = [],
  allRegistered = false,
  deregisterOne,
  log = console.log,
  readOptions = {},
  settleTries = 5,
  settleDelayMs = 3000,
}) {
  const targets = [];
  const labels = new Map();
  for (const raw of jobIds) {
    const id = toBytes32(raw);
    if (!labels.has(id)) {
      targets.push(id);
      labels.set(id, String(raw));
    }
  }

  /* 1. What does the keeper list for this operator? */
  let registered = null;
  try {
    registered = await listRegisteredJobs(keeper, oracle, readOptions);
  } catch (e) {
    if (allRegistered) throw e;
    log(`Warning: ${e.message}. Only the job ids given are checked.`);
  }
  const unlisted = registered ? registered.filter((id) => !labels.has(id)) : [];
  if (unlisted.length > 0) {
    const names = unlisted.map(jobIdText).join(", ");
    if (allRegistered) {
      log(`\nAlso registered for this operator on the keeper, but not among the job ids given: ${names}`);
      log("Deregistering those too (their stake is refunded like the others).");
      for (const id of unlisted) {
        targets.push(id);
        labels.set(id, jobIdText(id));
      }
    } else {
      log(`\nWarning: the keeper also lists ${unlisted.length} job id(s) for this operator that are not among the job ids given: ${names}`);
      log("Their stake stays locked. Run again with --all-registered to deregister every job id of this operator.");
    }
  }

  /* 2. Deregister. */
  const deregistered = [];
  const skipped = [];
  for (const id of targets) {
    const label = labels.get(id);
    log(`\nJobID ${label} → ${id}`);
    const info = await withRetry(() => keeper.getOracleInfo(oracle, id), readOptions);
    if (!isRegistered(info)) {
      log("Not registered – skipping");
      skipped.push(id);
      continue;
    }
    log("Calling deregisterOracle…");
    await deregisterOne(id, label);
    deregistered.push(id);
  }

  /* 3. Nothing of this operator's may be left when every job is being replaced. */
  let remaining = [];
  if (allRegistered) {
    /* A load-balanced RPC can answer from a backend a block or two behind the
     * one that mined the last deregistration, so a non-empty answer is asked
     * again a few times before it is believed. */
    const sleep = readOptions.sleep || defaultSleep;
    for (let attempt = 1; attempt <= settleTries; attempt++) {
      remaining = await listRegisteredJobs(keeper, oracle, readOptions);
      if (remaining.length === 0 || deregistered.length === 0) break;
      if (attempt < settleTries) await sleep(settleDelayMs);
    }
    if (remaining.length > 0) {
      throw new Error(
        `${remaining.length} job id(s) are still registered for this operator after deregistration: ` +
          `${remaining.map(jobIdText).join(", ")}. Their stake would be stranded if the jobs were replaced now.`
      );
    }
    log("\nThe keeper lists no job id for this operator.");
  }
  return { deregistered, skipped, unlisted, remaining };
}

module.exports = { toBytes32, jobIdText, isRegistered, listRegisteredJobs, runDeregistration, withRetry };
