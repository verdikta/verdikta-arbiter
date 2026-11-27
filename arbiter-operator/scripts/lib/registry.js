/* What the v2 ReputationKeeper holds for one operator contract, and the exit
 * run built on it.
 *
 * The installer used to act only on the job ids written in installer/.contracts
 * and to treat "Not registered – skipping" for every one of them as success.
 * When that file no longer named the job that was actually registered, a
 * job-count change replaced the node's jobs and left the old one on the keeper
 * with its stake and no node behind it (Base mainnet, v1 keeper, 2026-11-11).
 * The keeper is the only record of where the stake is, so this module reads it.
 *
 * In v2 (the beacon-branch keeper) a registered job is an arbiter key,
 * keyOf(oracle, jobId), and leaving is two steps: requestExit (the key stops
 * being selectable at once; its stake stays bonded for the unbonding period,
 * 2 days by default) and, after that period, completeExit (the stake goes back
 * to the operator's owner). A key left behind with no node behind it is worse
 * than in v1: it can still be drawn, and every round it misses counts against
 * it. The v2 keeper has no per-operator list in storage; its ArbiterRegistered
 * event indexes the operator, so the keys an operator ever registered are read
 * from the logs, and each one's current state from getArbiter.
 *
 *   listOperatorKeys  every key the keeper ever registered for the operator
 *                     that is still registered (exiting ones included)
 *   runExits          request or complete the exit of the ids given, and
 *                     optionally of every other registered key of the
 *                     operator too; then require that none is left selectable
 *
 * No ethers here: the keeper is passed in (an ethers Contract plus a
 * `registrations(oracle)` reader in the scripts, a fake in registry.test.js),
 * so the logic is tested without a chain.
 */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const F_REGISTERED = 1n;
const F_BANNED = 4n;
const F_EXITING = 8n;

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

const field = (v, name, i) => BigInt(v[name] === undefined ? v[i] : v[name]);

/* The state of one key from getArbiter, at time `now` (seconds).
 *   none      not registered, or exited (a banned key's record stays, with no stake)
 *   active    registered and not exiting: selectable, paused or blocked; it holds stake
 *   exiting   exit requested; completeExit is not due yet (or it is blocked)
 *   due       completeExit can run now */
function keyState(view, now) {
  const flags = field(view, "flags", 4);
  const stake = field(view, "stake", 9);
  const exitAt = field(view, "exitAt", 11);
  const blockedUntil = field(view, "blockedUntil", 5);
  if ((flags & F_REGISTERED) === 0n) return "none";
  if ((flags & F_BANNED) !== 0n && (flags & F_EXITING) !== 0n && stake === 0n && now >= exitAt) return "none";
  if ((flags & F_EXITING) === 0n) return "active";
  if (now < exitAt || blockedUntil > now) return "exiting";
  return "due";
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

/* Every key the keeper registered for `oracle` that is still registered, as
 * [{ key, jobId }] (bytes32, lower case), in registration order. A read that
 * keeps failing is an error — the caller must not take "could not read" for
 * "none". */
async function listOperatorKeys(keeper, oracle, { now, tries, delayMs, sleep } = {}) {
  const retry = { tries, delayMs, sleep };
  let regs;
  try {
    regs = await withRetry(() => keeper.registrations(oracle), retry);
  } catch (e) {
    throw new Error(`could not read the keeper's registrations for this operator: ${(e && e.message) || e}`);
  }
  const seen = new Set();
  const out = [];
  for (const r of regs) {
    const key = String(r.key).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const view = await withRetry(() => keeper.getArbiter(key), retry);
    if (keyState(view, now) !== "none") out.push({ key, jobId: String(r.jobId).toLowerCase() });
  }
  return out;
}

/* Request or complete the exit of `jobIds` (text or bytes32) for `oracle`.
 *
 *   allRegistered  also exit every other key the keeper holds for the operator,
 *                  and fail unless none of the operator's keys is left
 *                  selectable afterwards (exits still bonding are fine: a later
 *                  run completes them). Without it, such keys are reported and
 *                  left alone.
 *   requestExit, completeExit  async (key, label) — send the transaction and wait.
 *   now            async () => the latest block's timestamp (seconds, BigInt).
 *
 * Returns { requested, completed, pending, skipped, unlisted, remaining, latestExit }
 * (key arrays; latestExit a BigInt). Throws when a send fails, when
 * allRegistered is set and the keeper cannot be read, or when keys are still
 * selectable at the end. */
async function runExits({
  keeper,
  oracle,
  jobIds = [],
  allRegistered = false,
  requestExit,
  completeExit,
  now,
  log = console.log,
  readOptions = {},
  settleTries = 5,
  settleDelayMs = 3000,
}) {
  const targets = [];
  const labels = new Map();
  for (const raw of jobIds) {
    const jobId = toBytes32(raw);
    const key = String(await withRetry(() => keeper.keyOf(oracle, jobId), readOptions)).toLowerCase();
    if (!labels.has(key)) {
      targets.push(key);
      labels.set(key, `${String(raw)} → ${jobId} (key ${key})`);
    }
  }

  /* 1. What does the keeper hold for this operator? */
  let held = null;
  try {
    held = await listOperatorKeys(keeper, oracle, { ...readOptions, now: await now() });
  } catch (e) {
    if (allRegistered) throw e;
    log(`Warning: ${e.message}. Only the job ids given are checked.`);
  }
  const unlisted = held ? held.filter((k) => !labels.has(k.key)) : [];
  if (unlisted.length > 0) {
    const names = unlisted.map((k) => jobIdText(k.jobId)).join(", ");
    if (allRegistered) {
      log(`\nAlso registered for this operator on the keeper, but not among the job ids given: ${names}`);
      log("Exiting those too (their stake comes back like the others').");
      for (const k of unlisted) {
        targets.push(k.key);
        labels.set(k.key, `${jobIdText(k.jobId)} (key ${k.key})`);
      }
    } else {
      log(`\nWarning: the keeper also holds ${unlisted.length} job id(s) for this operator that are not among the job ids given: ${names}`);
      log("They stay registered (and selectable). Run again with --all-registered to exit every job id of this operator.");
    }
  }

  /* 2. Exit: whichever step is due for each key. */
  const requested = [], completed = [], pending = [], skipped = [];
  let latestExit = 0n;
  for (const key of targets) {
    const label = labels.get(key);
    log(`\nJobID ${label}`);
    const t = await now();
    const view = await withRetry(() => keeper.getArbiter(key), readOptions);
    const state = keyState(view, t);
    if (state === "none") {
      log("Not registered – skipping");
      skipped.push(key);
      continue;
    }
    if (state === "active") {
      await requestExit(key, label);
      const exitAt = field(await withRetry(() => keeper.getArbiter(key), readOptions), "exitAt", 11);
      if (exitAt > latestExit) latestExit = exitAt;
      log(`  No longer selectable. The stake comes back with completeExit from ${when(exitAt)}: run this again then.`);
      requested.push(key);
      continue;
    }
    if (state === "exiting") {
      const exitAt = field(view, "exitAt", 11);
      const blockedUntil = field(view, "blockedUntil", 5);
      if (t < exitAt) {
        log(`Exit pending: the stake can be withdrawn from ${when(exitAt)} – skipping`);
        if (exitAt > latestExit) latestExit = exitAt;
      } else {
        log(`Exit pending: blocked until ${when(blockedUntil)}, then completeExit can run – skipping`);
        if (blockedUntil > latestExit) latestExit = blockedUntil;
      }
      pending.push(key);
      continue;
    }
    await completeExit(key, label);
    completed.push(key);
  }

  /* 3. Nothing of this operator's may be left selectable when every job is being replaced. */
  let remaining = [];
  if (allRegistered) {
    /* A load-balanced RPC can answer from a backend a block or two behind the
     * one that mined the last exit, so a non-empty answer is asked again a few
     * times before it is believed. */
    const sleep = readOptions.sleep || defaultSleep;
    const sent = requested.length + completed.length;
    for (let attempt = 1; attempt <= settleTries; attempt++) {
      const t = await now();
      remaining = [];
      for (const k of await listOperatorKeys(keeper, oracle, { ...readOptions, now: t })) {
        const state = keyState(await withRetry(() => keeper.getArbiter(k.key), readOptions), t);
        if (state === "active") remaining.push(k);
      }
      if (remaining.length === 0 || sent === 0) break;
      if (attempt < settleTries) await sleep(settleDelayMs);
    }
    if (remaining.length > 0) {
      throw new Error(
        `${remaining.length} job id(s) of this operator are still registered and not exiting: ` +
          `${remaining.map((k) => jobIdText(k.jobId)).join(", ")}. With no node behind them they would still be drawn.`
      );
    }
    log("\nThe keeper holds no selectable job id for this operator.");
  }
  return { requested, completed, pending, skipped, unlisted: unlisted.map((k) => k.key), remaining, latestExit };
}

function when(t) {
  return new Date(Number(t) * 1000).toISOString();
}

module.exports = { toBytes32, jobIdText, keyState, listOperatorKeys, runExits, withRetry, when, F_REGISTERED, F_BANNED, F_EXITING };
