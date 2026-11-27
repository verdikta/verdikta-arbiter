// Run: node --test arbiter-operator/scripts/lib/registry.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { toBytes32, jobIdText, keyState, listOperatorKeys, runExits } = require("./registry.js");

const noSleep = async () => {};
const fast = { sleep: noSleep, delayMs: 0 };
const OP = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"; // made-up addresses and job ids
const OTHER = "0x00000000000000000000000000000000000000A1";
const OLD = "aaaa1111bbbb2222cccc3333dddd4444"; // the job the node used to run
const NEW1 = "eeee5555ffff6666aaaa7777bbbb8888";
const NEW2 = "cccc9999dddd0000eeee1111ffff2222";
const THEIRS = "1111aaaa2222bbbb3333cccc4444dddd";
const DAY = 86400n;
const UNBONDING = 2n * DAY;

const keyOf = (oracle, jobId) =>
  "0x" + crypto.createHash("sha256").update(`${oracle.toLowerCase()}|${toBytes32(jobId)}`).digest("hex");
const F = { REG: 1n, PAUSED: 2n, BANNED: 4n, EXITING: 8n };

/* The parts of the v2 ReputationKeeper these scripts use: registrations come
 * from its ArbiterRegistered events (never removed), state from getArbiter;
 * requestExit and completeExit behave as in the contract. */
function fakeKeeper(entries, { failReads = 0, staleReadsAfterSend = 0, start = 1_000_000n } = {}) {
  const k = {
    t: start,
    regs: [],
    arbiters: new Map(),
    stale: 0,
    snapshot: null,
    registrations: async (oracle) => {
      if (failReads > 0) {
        failReads--;
        throw new Error("429 Too Many Requests");
      }
      return k.regs.filter((r) => r.oracle.toLowerCase() === oracle.toLowerCase()).map(({ key, jobId }) => ({ key, jobId }));
    },
    keyOf: async (oracle, jobId) => keyOf(oracle, jobId),
    getArbiter: async (key) => {
      const src = k.stale > 0 && k.snapshot ? (k.stale--, k.snapshot) : k.arbiters;
      const a = src.get(key);
      return a ? { ...a } : { flags: 0n, stake: 0n, exitAt: 0n, blockedUntil: 0n };
    },
    now: async () => k.t,
    save() {
      k.snapshot = new Map([...k.arbiters].map(([key, a]) => [key, { ...a }]));
      k.stale = staleReadsAfterSend;
    },
    requestExit(key) {
      const a = k.arbiters.get(key);
      if (!a || (a.flags & F.REG) === 0n) throw new Error("NotRegistered");
      if ((a.flags & F.EXITING) !== 0n) throw new Error("AlreadyExiting");
      k.save();
      a.flags |= F.EXITING;
      a.exitAt = k.t + UNBONDING;
    },
    completeExit(key) {
      const a = k.arbiters.get(key);
      if (!a || (a.flags & F.EXITING) === 0n || k.t < a.exitAt) throw new Error("StillBonded");
      if (a.blockedUntil > k.t) throw new Error("Blocked");
      k.save();
      a.stake = 0n;
      if ((a.flags & F.BANNED) === 0n) a.flags = 0n;
    },
  };
  for (const [oracle, job, state] of entries) {
    const key = keyOf(oracle, job);
    k.regs.push({ oracle, key, jobId: toBytes32(job) });
    k.arbiters.set(key, { flags: F.REG, stake: 100n, exitAt: 0n, blockedUntil: 0n, ...state });
  }
  return k;
}
const run = (keeper, opts) => {
  const logs = [];
  const sent = [];
  const p = runExits({
    keeper,
    oracle: OP,
    now: keeper.now,
    log: (m) => logs.push(m),
    readOptions: fast,
    settleDelayMs: 0,
    requestExit: async (key) => {
      keeper.requestExit(key);
      sent.push(["requestExit", key]);
    },
    completeExit: async (key) => {
      keeper.completeExit(key);
      sent.push(["completeExit", key]);
    },
    ...opts,
  });
  return p.then(
    (result) => ({ result, logs: logs.join("\n"), sent }),
    (error) => ({ error, logs: logs.join("\n"), sent })
  );
};

test("job ids: text ↔ bytes32", () => {
  const b = toBytes32(OLD);
  assert.equal(b, "0x" + Buffer.from(OLD).toString("hex"));
  assert.equal(jobIdText(b), OLD);
  assert.equal(toBytes32(b.toUpperCase().replace("0X", "0x")), b);
  assert.throws(() => toBytes32("x".repeat(33)), /too long/);
  // an all-digit job id stays text (yargs would make it a number without string: true)
  assert.equal(jobIdText(toBytes32("12345678901234567890123456789012")), "12345678901234567890123456789012");
});

test("key state: active, exiting, due, and gone (a banned key's record included)", () => {
  const now = 1000n;
  assert.equal(keyState({ flags: 0n, stake: 0n, exitAt: 0n, blockedUntil: 0n }, now), "none");
  assert.equal(keyState({ flags: F.REG, stake: 100n, exitAt: 0n, blockedUntil: 0n }, now), "active");
  assert.equal(keyState({ flags: F.REG | F.PAUSED, stake: 100n, exitAt: 0n, blockedUntil: 0n }, now), "active");
  assert.equal(keyState({ flags: F.REG | F.BANNED, stake: 100n, exitAt: 0n, blockedUntil: 0n }, now), "active");
  assert.equal(keyState({ flags: F.REG | F.EXITING, stake: 100n, exitAt: 2000n, blockedUntil: 0n }, now), "exiting");
  assert.equal(keyState({ flags: F.REG | F.EXITING, stake: 100n, exitAt: 500n, blockedUntil: 1500n }, now), "exiting");
  assert.equal(keyState({ flags: F.REG | F.EXITING, stake: 100n, exitAt: 500n, blockedUntil: 0n }, now), "due");
  assert.equal(keyState({ flags: F.REG | F.EXITING | F.BANNED, stake: 0n, exitAt: 500n, blockedUntil: 0n }, now), "none");
});

test("lists only this operator's registered keys, whatever the address case, without exited ones", async () => {
  const k = fakeKeeper([[OP, OLD], [OTHER, THEIRS], [OP.toLowerCase(), NEW1], [OP, NEW2, { flags: 0n, stake: 0n }]]);
  const keys = await listOperatorKeys(k, OP, { ...fast, now: k.t });
  assert.deepEqual(keys.map((x) => jobIdText(x.jobId)), [OLD, NEW1]);
});

test("a registrations read that keeps failing is an error, never an empty list", async () => {
  const k = fakeKeeper([[OP, OLD]], { failReads: 99 });
  await assert.rejects(listOperatorKeys(k, OP, { ...fast, now: k.t }), /could not read the keeper's registrations/);
});

test("the job the file does not name: reported without --all-registered, and left", async () => {
  const k = fakeKeeper([[OP, OLD]]);
  const { result, logs, sent } = await run(k, { jobIds: [NEW1] });
  assert.equal(sent.length, 0);
  assert.match(logs, new RegExp(`also holds 1 job id\\(s\\).*${OLD}`));
  assert.match(logs, /--all-registered/);
  assert.equal(result.unlisted.length, 1);
});

test("the job the file does not name: its exit is requested with --all-registered", async () => {
  const k = fakeKeeper([[OP, OLD], [OTHER, THEIRS]]);
  const { result, error, sent } = await run(k, { jobIds: [NEW1], allRegistered: true });
  assert.equal(error, undefined);
  assert.deepEqual(sent, [["requestExit", keyOf(OP, OLD)]]);
  assert.equal(result.latestExit, k.t + UNBONDING);
  assert.equal(keyState(await k.getArbiter(keyOf(OTHER, THEIRS)), k.t), "active"); // another operator's is untouched
});

test("--all-registered with no job ids given exits everything of the operator's", async () => {
  const k = fakeKeeper([[OP, OLD], [OP, NEW1]]);
  const { error, sent } = await run(k, { allRegistered: true });
  assert.equal(error, undefined);
  assert.deepEqual(sent.map((s) => s[1]), [keyOf(OP, OLD), keyOf(OP, NEW1)]);
});

test("the usual case is unchanged: listed ids exit once, in order; a second run after unbonding completes them", async () => {
  const k = fakeKeeper([[OP, NEW1], [OP, NEW2]]);
  let r = await run(k, { jobIds: [NEW1, NEW2, NEW1] });
  assert.deepEqual(r.sent, [["requestExit", keyOf(OP, NEW1)], ["requestExit", keyOf(OP, NEW2)]]);
  r = await run(k, { jobIds: [NEW1, NEW2] });
  assert.equal(r.sent.length, 0);
  assert.equal(r.result.pending.length, 2);
  k.t += UNBONDING;
  r = await run(k, { jobIds: [NEW1, NEW2], allRegistered: true });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.sent.map((s) => s[0]), ["completeExit", "completeExit"]);
  assert.equal((await listOperatorKeys(k, OP, { ...fast, now: k.t })).length, 0);
});

test("a paused or banned key holds its stake, so its exit is requested too; a blocked one waits", async () => {
  const k = fakeKeeper([[OP, OLD, { flags: F.REG | F.PAUSED }], [OP, NEW1, { flags: F.REG | F.BANNED }]]);
  let r = await run(k, { jobIds: [OLD, NEW1] });
  assert.equal(r.sent.length, 2);
  k.t += UNBONDING;
  k.arbiters.get(keyOf(OP, OLD)).blockedUntil = k.t + DAY;
  r = await run(k, { jobIds: [OLD, NEW1] });
  assert.deepEqual(r.sent, [["completeExit", keyOf(OP, NEW1)]]);
  assert.match(r.logs, /blocked until/);
  r = await run(k, { jobIds: [NEW1] }); // a banned key's record is gone once its exit is complete
  assert.equal(r.sent.length, 0);
  assert.match(r.logs, /Not registered – skipping/);
});

test("--all-registered fails when the keeper cannot be read, before anything is sent", async () => {
  const k = fakeKeeper([[OP, OLD]], { failReads: 99 });
  const { error, sent } = await run(k, { jobIds: [OLD], allRegistered: true });
  assert.match(error.message, /could not read/);
  assert.equal(sent.length, 0);
});

test("without --all-registered an unreadable keeper is a warning and the listed ids still go", async () => {
  const k = fakeKeeper([[OP, OLD]], { failReads: 4 });
  const { error, logs, sent } = await run(k, { jobIds: [OLD] });
  assert.equal(error, undefined);
  assert.match(logs, /Warning: could not read/);
  assert.equal(sent.length, 1);
});

test("--all-registered fails when a key is still selectable at the end", async () => {
  const k = fakeKeeper([[OP, OLD]]);
  const { error } = await run(k, {
    jobIds: [OLD],
    allRegistered: true,
    requestExit: async () => {}, // the send "succeeds" but nothing changes on the keeper
  });
  assert.match(error.message, /still registered and not exiting/);
  assert.match(error.message, new RegExp(OLD));
});

test("a send that fails stops the run with its error", async () => {
  const k = fakeKeeper([[OP, OLD], [OP, NEW1]]);
  const exited = [];
  const { error } = await run(k, {
    jobIds: [OLD, NEW1],
    requestExit: async (key) => {
      if (key === keyOf(OP, NEW1)) throw new Error("replacement transaction underpriced");
      k.requestExit(key);
      exited.push(key);
    },
  });
  assert.match(error.message, /underpriced/);
  assert.deepEqual(exited, [keyOf(OP, OLD)]);
});

test("a lagging RPC backend right after the last send is asked again, not believed", async () => {
  const k = fakeKeeper([[OP, OLD]], { staleReadsAfterSend: 2 });
  const { error, sent } = await run(k, { jobIds: [OLD], allRegistered: true });
  assert.equal(error, undefined);
  assert.equal(sent.length, 1);
});
