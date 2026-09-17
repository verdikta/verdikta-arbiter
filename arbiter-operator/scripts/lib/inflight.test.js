// Run: node --test arbiter-operator/scripts/lib/inflight.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createInFlightGuard, isInFlightLimit } = require("./inflight.js");

const noSleep = async () => {};
const fakeProvider = (nonces) => {
  // nonces: array of [pending, latest] answers, last one repeats
  let i = 0;
  return {
    getTransactionCount: async (_addr, tag) => {
      const pair = nonces[Math.min(i, nonces.length - 1)];
      if (tag === "latest") i++;
      return tag === "pending" ? pair[0] : pair[1];
    },
  };
};

test("recognises the provider's in-flight error and nothing else", () => {
  assert.equal(isInFlightLimit(new Error("in-flight transaction limit reached for delegated accounts")), true);
  assert.equal(isInFlightLimit({ message: "In-Flight Transaction Limit" }), true);
  assert.equal(isInFlightLimit(new Error("insufficient funds")), false);
  assert.equal(isInFlightLimit(null), false);
});

test("waits until the pending nonce equals the mined nonce before a send", async () => {
  const logs = [];
  const g = createInFlightGuard({ provider: fakeProvider([[5, 3], [5, 4], [5, 5]]), sender: "0xabc", log: (m) => logs.push(m), sleep: noSleep });
  assert.equal(await g.waitForNonceSettle("test"), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /waiting for 2 in-flight tx to settle before test/);
});

test("gives up waiting after settleTries and says so, then still sends", async () => {
  const logs = [];
  const g = createInFlightGuard({ provider: fakeProvider([[9, 1]]), sender: "0xabc", log: (m) => logs.push(m), sleep: noSleep, settleTries: 3, settleDelayMs: 1000 });
  assert.equal(await g.waitForNonceSettle("x"), false);
  assert.match(logs[logs.length - 1], /did not settle within 3 s; continuing anyway/);
});

test("retries on the in-flight error with a back-off and returns the eventual result", async () => {
  const slept = [];
  const g = createInFlightGuard({ provider: fakeProvider([[1, 1]]), sender: "0xabc", log: () => {}, sleep: async (ms) => { slept.push(ms); }, retryDelayMs: 10000 });
  let calls = 0;
  const out = await g.sendWithRetry("deregisterOracle", async () => {
    calls++;
    if (calls < 3) throw new Error("ProviderError: in-flight transaction limit reached for delegated accounts");
    return "tx";
  });
  assert.equal(out, "tx");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [10000, 10000]);
});

test("rethrows any other error immediately and the in-flight error after the last attempt", async () => {
  const g = createInFlightGuard({ provider: fakeProvider([[1, 1]]), sender: "0xabc", log: () => {}, sleep: noSleep, retries: 2 });
  let calls = 0;
  await assert.rejects(g.sendWithRetry("x", async () => { calls++; throw new Error("insufficient funds"); }), /insufficient funds/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(g.sendWithRetry("x", async () => { calls++; throw new Error("in-flight transaction limit reached"); }), /in-flight/);
  assert.equal(calls, 2);
});
