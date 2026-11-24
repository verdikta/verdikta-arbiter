// Run: node --test arbiter-operator/scripts/lib/registry.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { toBytes32, jobIdText, isRegistered, listRegisteredJobs, runDeregistration } = require("./registry.js");

const noSleep = async () => {};
const fast = { sleep: noSleep, delayMs: 0 };
const OP = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"; // made-up addresses and job ids
const OTHER = "0x00000000000000000000000000000000000000A1";
const OLD = "aaaa1111bbbb2222cccc3333dddd4444"; // the job the node used to run
const NEW1 = "eeee5555ffff6666aaaa7777bbbb8888";
const NEW2 = "cccc9999dddd0000eeee1111ffff2222";
const THEIRS = "1111aaaa2222bbbb3333cccc4444dddd";

/* The parts of ReputationKeeper these scripts use, with its real removal:
 * deregisterOracle deletes the record and swap-and-pops the registry array. */
function fakeKeeper(entries, { failReads = 0, staleReadsAfterDeregister = 0 } = {}) {
  const registry = entries.map(([oracle, job, info]) => ({ oracle, jobId: toBytes32(job), info: { isActive: true, stakeAmount: 100n, blocked: false, ...info } }));
  const k = {
    registry,
    reads: 0,
    stale: 0,
    snapshot: null,
    view() {
      if (k.stale > 0 && k.snapshot) {
        k.stale--;
        return k.snapshot;
      }
      return registry;
    },
    getRegisteredOraclesCount: async () => {
      k.reads++;
      if (failReads > 0) {
        failReads--;
        throw new Error("429 Too Many Requests");
      }
      return BigInt(k.view().length);
    },
    registeredOracles: async (i) => {
      const e = k.view()[i];
      if (!e) throw new Error("execution reverted");
      return [e.oracle, e.jobId];
    },
    getOracleInfo: async (oracle, jobId) => {
      const e = registry.find((x) => x.oracle.toLowerCase() === oracle.toLowerCase() && x.jobId === jobId);
      return e ? e.info : { isActive: false, stakeAmount: 0n, blocked: false };
    },
    deregister(oracle, jobId) {
      k.snapshot = registry.slice();
      k.stale = staleReadsAfterDeregister;
      const i = registry.findIndex((x) => x.oracle.toLowerCase() === oracle.toLowerCase() && x.jobId === jobId);
      if (i < 0) throw new Error("Oracle not registered");
      registry[i] = registry[registry.length - 1];
      registry.pop();
    },
  };
  return k;
}
const run = (keeper, opts) => {
  const logs = [];
  const sent = [];
  const p = runDeregistration({
    keeper,
    oracle: OP,
    log: (m) => logs.push(m),
    readOptions: fast,
    settleDelayMs: 0,
    deregisterOne: async (id) => {
      keeper.deregister(OP, id);
      sent.push(jobIdText(id));
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
  assert.equal(b, "0x6161616131313131626262623232323263636363333333336464646434343434");
  assert.equal(jobIdText(b), OLD);
  assert.equal(toBytes32(b.toUpperCase().replace("0X", "0x")), b);
  assert.equal(toBytes32(12345678), toBytes32("12345678")); // a number from a CLI parser
  assert.throws(() => toBytes32("x".repeat(33)), /too long/);
  assert.equal(jobIdText("0x" + "00".repeat(32)), "0x" + "00".repeat(32));
});

test("registered = what deregisterOracle accepts: stake, active or blocked", () => {
  assert.equal(isRegistered({ isActive: true, stakeAmount: 100n, blocked: false }), true);
  assert.equal(isRegistered({ isActive: false, stakeAmount: 100n, blocked: false }), true); // paused, stake in place
  assert.equal(isRegistered({ isActive: true, stakeAmount: 0n, blocked: true }), true); // slashed to zero, still listed
  assert.equal(isRegistered({ isActive: false, stakeAmount: 0n, blocked: false }), false);
  assert.equal(isRegistered([false, 0n, 0n, 0n, "0x", 0n, 100n, 0n, false]), true); // positional result
  assert.equal(isRegistered(null), false);
});

test("lists only this operator's job ids, whatever the address case", async () => {
  const k = fakeKeeper([[OTHER, THEIRS], [OP.toLowerCase(), OLD], [OTHER, NEW2], [OP, NEW1]]);
  assert.deepEqual((await listRegisteredJobs(k, OP, fast)).map(jobIdText), [OLD, NEW1]);
  assert.deepEqual(await listRegisteredJobs(k, "0x000000000000000000000000000000000000dEaD", fast), []);
});

test("a registry read that keeps failing is an error, never an empty list", async () => {
  const flaky = fakeKeeper([[OP, OLD]], { failReads: 2 });
  assert.deepEqual((await listRegisteredJobs(flaky, OP, fast)).map(jobIdText), [OLD]);
  const dead = fakeKeeper([[OP, OLD]], { failReads: 1000 });
  await assert.rejects(listRegisteredJobs(dead, OP, { ...fast, tries: 2, passes: 2 }), /could not read the keeper's registry: 429/);
});

test("a registry that shrinks during the walk is read again", async () => {
  const k = fakeKeeper([[OTHER, THEIRS], [OP, OLD], [OP, NEW1]]);
  const original = k.registeredOracles;
  let once = true;
  k.registeredOracles = async (i) => {
    if (once && i === 1) {
      once = false;
      k.registry.splice(0, 1); // someone else deregisters mid-walk
    }
    return original(i);
  };
  assert.deepEqual((await listRegisteredJobs(k, OP, fast)).map(jobIdText).sort(), [NEW1, OLD].sort());
});

/* The 2026-11-11 case: installer/.contracts names a job id that was never
 * registered, the keeper holds another one with the 100 wVDKA stake. */
test("the job the file does not name: reported without --all-registered, and left", async () => {
  const k = fakeKeeper([[OTHER, THEIRS], [OP, OLD]]);
  const { result, logs, sent } = await run(k, { jobIds: [NEW1] });
  assert.deepEqual(sent, []);
  assert.match(logs, /Not registered – skipping/);
  assert.match(logs, new RegExp(`the keeper also lists 1 job id\\(s\\) for this operator that are not among the job ids given: ${OLD}`));
  assert.match(logs, /--all-registered/);
  assert.deepEqual(result.unlisted.map(jobIdText), [OLD]);
  assert.equal(k.registry.length, 2);
});

test("the job the file does not name: deregistered with --all-registered", async () => {
  const k = fakeKeeper([[OTHER, THEIRS], [OP, OLD]]);
  const { result, logs, sent, error } = await run(k, { jobIds: [NEW1], allRegistered: true });
  assert.equal(error, undefined);
  assert.deepEqual(sent, [OLD]);
  assert.match(logs, new RegExp(`Also registered for this operator on the keeper, but not among the job ids given: ${OLD}`));
  assert.match(logs, /The keeper lists no job id for this operator/);
  assert.deepEqual(result.skipped.map(jobIdText), [NEW1]);
  assert.deepEqual(k.registry.map((e) => jobIdText(e.jobId)), [THEIRS]); // other operators untouched
});

test("--all-registered with no job ids given deregisters everything of the operator's", async () => {
  const k = fakeKeeper([[OP, OLD], [OTHER, THEIRS], [OP, NEW1], [OP, NEW2]]);
  const { sent, error } = await run(k, { allRegistered: true });
  assert.equal(error, undefined);
  assert.deepEqual(sent.sort(), [NEW1, NEW2, OLD].sort());
  assert.deepEqual(k.registry.map((e) => jobIdText(e.jobId)), [THEIRS]);
});

test("the usual case is unchanged: listed ids deregistered once, in order", async () => {
  const k = fakeKeeper([[OP, NEW1], [OP, NEW2], [OTHER, THEIRS]]);
  const { sent, logs, error } = await run(k, { jobIds: [NEW1, NEW2, NEW1], allRegistered: true });
  assert.equal(error, undefined);
  assert.deepEqual(sent, [NEW1, NEW2]);
  assert.doesNotMatch(logs, /Also registered/);
});

test("a paused oracle keeps its stake on the keeper, so it is deregistered too", async () => {
  const k = fakeKeeper([[OP, OLD, { isActive: false }]]);
  const { sent } = await run(k, { jobIds: [OLD] });
  assert.deepEqual(sent, [OLD]);
});

test("--all-registered fails when the registry cannot be read, before anything is sent", async () => {
  const k = fakeKeeper([[OP, OLD]], { failReads: 1000 });
  const { error, sent } = await run(k, { jobIds: [OLD], allRegistered: true, readOptions: { ...fast, tries: 2, passes: 2 } });
  assert.match(error.message, /could not read the keeper's registry/);
  assert.deepEqual(sent, []);
});

test("without --all-registered an unreadable registry is a warning and the listed ids still go", async () => {
  const k = fakeKeeper([[OP, OLD]], { failReads: 4 });
  const { error, sent, logs } = await run(k, { jobIds: [OLD], readOptions: { ...fast, tries: 2, passes: 2 } });
  assert.equal(error, undefined);
  assert.deepEqual(sent, [OLD]);
  assert.match(logs, /Warning: could not read the keeper's registry/);
});

test("--all-registered fails when a job id is still registered at the end", async () => {
  const k = fakeKeeper([[OP, OLD], [OP, NEW1]]);
  const { error } = await run(k, {
    jobIds: [NEW1],
    allRegistered: true,
    deregisterOne: async (id) => {
      if (jobIdText(id) === NEW1) k.deregister(OP, id); // the send for OLD "succeeds" but changes nothing
    },
  });
  assert.match(error.message, new RegExp(`1 job id\\(s\\) are still registered for this operator after deregistration: ${OLD}`));
  assert.match(error.message, /stranded/);
});

test("a send that fails stops the run with its error", async () => {
  const k = fakeKeeper([[OP, OLD], [OP, NEW1]]);
  const { error, sent } = await run(k, {
    jobIds: [OLD, NEW1],
    allRegistered: true,
    deregisterOne: async () => {
      throw new Error("Oracle is locked and cannot be unregistered");
    },
  });
  assert.match(error.message, /locked/);
  assert.deepEqual(sent, []);
});

test("a lagging RPC backend right after the last send is asked again, not believed", async () => {
  const k = fakeKeeper([[OP, OLD]], { staleReadsAfterDeregister: 6 }); // two full stale walks
  const { error, logs } = await run(k, { jobIds: [OLD], allRegistered: true });
  assert.equal(error, undefined);
  assert.match(logs, /The keeper lists no job id for this operator/);
});
