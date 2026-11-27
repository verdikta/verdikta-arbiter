// arbiter-operator/scripts/lib/migration.js: what an operator migration reads before it
// starts and requires when it is done. Fakes stand in for the contracts, with the keeper's
// real registry shape (an array of (oracle, job id), records by (oracle, job id)).
// The script that drives it: migrate-operator.test.sh. Against a real keeper, read-only:
//   HARDHAT_NETWORK=… node arbiter-operator/scripts/operator-migration.js plan …
// Run: node --test installer/tests/operator-migration.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPlan, checkDeployment, verifyMigration, formatUnits, gasBudget } = require('../../arbiter-operator/scripts/lib/migration.js');
const { toBytes32 } = require('../../arbiter-operator/scripts/lib/registry.js');

const OWNER = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const OLD = '0x1111111111111111111111111111111111111111';
const NEW = '0x9999999999999999999999999999999999999999';
const ELSE = '0x7777777777777777777777777777777777777777';
const AGG = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x2222222222222222222222222222222222222222';
const KEYS = ['0xK1', '0xK2'];
const [J1, J2, J3, ORPHAN] = ['aaaaaaaa1111bbbb2222cccc33334444', 'bbbbbbbb1111bbbb2222cccc33334444', 'cccccccc1111bbbb2222cccc33334444', 'dddddddd1111bbbb2222cccc33334444'];
const E18 = 10n ** 18n;
const fast = { sleep: async () => {}, delayMs: 0 };

/* entries: [oracle, job, { classes, fee, stake, lockedUntil, active, blocked }] */
function fakeKeeper(entries, { approved = [AGG], stakeRequirement = 100n * E18 } = {}) {
  const registry = entries.map(([oracle, job, info = {}]) => ({ oracle, jobId: toBytes32(job),
    info: { isActive: info.active ?? true, fee: info.fee ?? 20000000000000n, stakeAmount: info.stake ?? 100n * E18, lockedUntil: BigInt(info.lockedUntil ?? 0), blocked: info.blocked ?? false },
    classes: info.classes ?? [128n, 131n] }));
  const find = (oracle, job) => registry.find(e => e.oracle.toLowerCase() === oracle.toLowerCase() && e.jobId === job);
  const keeper = {
    getRegisteredOraclesCount: async () => BigInt(registry.length),
    registeredOracles: async i => ({ oracle: registry[Number(i)].oracle, jobId: registry[Number(i)].jobId }),
    getOracleInfo: async (oracle, job) => (find(oracle, job) || { info: { isActive: false, fee: 0n, stakeAmount: 0n, lockedUntil: 0n, blocked: false } }).info,
    getOracleClassesByKey: async (oracle, job) => (find(oracle, job) || { classes: [] }).classes,
    isContractApproved: async address => approved.includes(address),
  };
  if (stakeRequirement !== null) keeper.STAKE_REQUIREMENT = async () => stakeRequirement;
  else keeper.STAKE_REQUIREMENT = async () => { throw new Error('no such function'); };
  return keeper;
}
const operator = ({ owner = OWNER, senders = KEYS } = {}) => ({ owner: async () => owner, getAuthorizedSenders: async () => senders });
const provider = ({ balance = E18, gasPrice = 10n ** 7n } = {}) => ({ getFeeData: async () => ({ gasPrice, maxFeePerGas: null }), getBalance: async () => balance });
const token = (balance = 0n) => ({ balanceOf: async () => balance });
const aggregator = (timeout = 300n) => ({ responseTimeoutSeconds: async () => { if (timeout === null) throw new Error('no such function'); return timeout; } });
const three = () => fakeKeeper([[OLD, J1], [ELSE, 'eeeeeeee1111bbbb2222cccc33334444'], [OLD, J2], [OLD, J3]]);
const plan = (overrides = {}) => readPlan({ provider: provider(), signerAddress: OWNER, operator: operator(), operatorAddress: OLD,
  aggregator: aggregator(), aggregatorAddress: AGG, keeper: three(), keeperAddress: KEEPER, token: token(), nodeJobIds: [J1, J2, J3],
  now: 1_800_000_000, readOptions: fast, ...overrides });

test('the plan is what the keeper holds for this operator: jobs, classes, fee, stake, and the node keys', async () => {
  const p = await plan();
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.jobs.map(job => job.id), [J1, J2, J3]);
  assert.deepEqual(p.groups, [{ classes: '128,131', feeEth: '0.00002', jobIds: [J1, J2, J3] }]);
  assert.deepEqual(p.senders, KEYS);
  assert.equal(p.refund, '300'); assert.equal(p.stakeNeeded, '300'); assert.equal(p.tokenBalance, '0');
  assert.equal(p.responseTimeoutSeconds, 300);
  assert.equal(p.operatorOwner, OWNER); assert.equal(p.keeper, KEEPER); assert.equal(p.aggregator, AGG);
  // Another operator's registration on the same keeper is not this node's business.
  assert.ok(!JSON.stringify(p).includes('eeeeeeee'));
  // The gas figure is the budget at the current price, with a fifth on top.
  assert.equal(p.ethNeeded, formatUnits(gasBudget(3) * 10n ** 7n * 12n / 10n));
});

test('jobs registered on separate classes or at another fee go back as separate registrations', async () => {
  const keeper = fakeKeeper([[OLD, J1, { classes: [133n], fee: 100000000000000n }], [OLD, J2], [OLD, J3, { classes: [128n, 131n] }]]);
  const p = await plan({ keeper });
  assert.deepEqual(p.groups, [{ classes: '133', feeEth: '0.0001', jobIds: [J1] }, { classes: '128,131', feeEth: '0.00002', jobIds: [J2, J3] }]);
  assert.deepEqual(p.problems, []);
});

test('each reason not to start is named, and none of them sends anything', async () => {
  const cases = [
    [{ signerAddress: ELSE }, /operator contract's owner is 0xAAaA.*only the owner can deregister/],
    [{ keeper: fakeKeeper([[OLD, J1]], { approved: [] }), nodeJobIds: [J1] }, /does not approve the aggregator/],
    [{ operator: operator({ senders: [] }) }, /authorizes no node key/],
    [{ keeper: fakeKeeper([[OLD, J1, { lockedUntil: 1_800_086_400 }]]), nodeJobIds: [J1] }, /job aaaaaaaa1111bbbb2222cccc33334444 is locked on the keeper until 2027-01-16T08:00:00.000Z/],
    // A slashed job gives back less than registering it again takes.
    [{ keeper: fakeKeeper([[OLD, J1, { stake: 60n * E18 }], [OLD, J2]]), nodeJobIds: [J1, J2] }, /takes 200 wVDKA; the owner holds 0 and the deregistration refunds 160.*: 40 short/],
    [{ provider: provider({ balance: 1n }) }, /holds 0\.000000000000000001 ETH, and the migration's transactions may take up to/],
    [{ keeper: fakeKeeper([[OLD, J1, { classes: [] }]]), nodeJobIds: [J1] }, /names no class for job/],
  ];
  for (const [overrides, reason] of cases) {
    const p = await plan(overrides);
    assert.equal(p.problems.length, 1, JSON.stringify(p.problems));
    assert.match(p.problems[0], reason);
  }
  // The shortfall is covered by what the owner already holds.
  assert.deepEqual((await plan({ keeper: fakeKeeper([[OLD, J1, { stake: 60n * E18 }]]), nodeJobIds: [J1], token: token(40n * E18) })).problems, []);
  // A lock that has run out is no lock.
  assert.deepEqual((await plan({ keeper: fakeKeeper([[OLD, J1, { lockedUntil: 1_799_999_999 }]]), nodeJobIds: [J1] })).problems, []);
});

test('a registration that is not this node\'s job is deregistered and not registered again; an unregistered job stays so', async () => {
  const p = await plan({ keeper: fakeKeeper([[OLD, J1], [OLD, ORPHAN]]), nodeJobIds: [J1, J2] });
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.orphans, [ORPHAN]);
  assert.deepEqual(p.unregistered, [J2]);
  assert.deepEqual(p.groups, [{ classes: '128,131', feeEth: '0.00002', jobIds: [J1] }]);
  assert.equal(p.refund, '200'); assert.equal(p.stakeNeeded, '100');
  assert.match(p.notes.join('\n'), /job dddddddd1111bbbb2222cccc33334444 is registered for this operator and is not a job of this node/);
  assert.match(p.notes.join('\n'), /job bbbbbbbb1111bbbb2222cccc33334444 of this node is not registered/);
  // A paused job (its stake in place) and a blocked one are registrations; a record with nothing is not.
  const odd = await plan({ keeper: fakeKeeper([[OLD, J1, { active: false }], [OLD, J2, { active: false, stake: 0n, blocked: true }], [OLD, J3, { active: false, stake: 0n }]]) });
  assert.deepEqual(odd.jobs.map(job => job.id), [J1, J2]);
  const none = await plan({ keeper: fakeKeeper([]) });
  assert.deepEqual(none.problems, []); assert.deepEqual(none.groups, []);
  assert.match(none.notes.join('\n'), /registers nothing/);
});

test('an older keeper or aggregator is read with the defaults they had', async () => {
  const p = await plan({ keeper: fakeKeeper([[OLD, J1]], { stakeRequirement: null }), nodeJobIds: [J1], aggregator: aggregator(null) });
  assert.equal(p.stakeNeeded, '100'); assert.equal(p.responseTimeoutSeconds, 300);
  assert.equal((await plan({ aggregator: aggregator(900n) })).responseTimeoutSeconds, 900);
});

test('a keeper that cannot be read is an error, not an empty plan', async () => {
  const keeper = three();
  keeper.getRegisteredOraclesCount = async () => { throw new Error('rate limited'); };
  await assert.rejects(() => plan({ keeper }), /could not read the keeper's registry/);
});

const newOperator = ({ version = 1n, owner = OWNER, senders = KEYS, keeperListed = true, approves = true } = {}) => ({
  requestAuthorizationVersion: async () => { if (version === null) throw new Error('no such function'); return version; },
  owner: async () => owner, getAuthorizedSenders: async () => senders,
  isReputationKeeper: async () => keeperListed, isRequesterApproved: async () => approves,
});
const verify = (overrides = {}) => verifyMigration({ signerAddress: OWNER, oldOperatorAddress: OLD, newOperator: newOperator(), newOperatorAddress: NEW,
  aggregatorAddress: AGG, keeper: fakeKeeper([[NEW, J1], [NEW, J2], [NEW, J3]]), keeperAddress: KEEPER, senders: KEYS, expectedJobIds: [J1, J2, J3],
  anonymousRequestReverts: async () => true, readOptions: fast, ...overrides });

test('the end state holds when everything moved', async () => {
  assert.deepEqual(await verify(), { problems: [], registered: [J1, J2, J3] });
  // A node that had nothing registered needs no keeper on its new operator yet.
  assert.deepEqual((await verify({ expectedJobIds: [], keeper: fakeKeeper([]), newOperator: newOperator({ keeperListed: false, approves: false }) })).problems, []);
  // Sender addresses are compared without regard to case.
  assert.deepEqual((await verify({ newOperator: newOperator({ senders: ['0xk1', '0xK2'] }) })).problems, []);
});

test('each thing that did not move is named', async () => {
  const cases = [
    [{ newOperator: newOperator({ version: null }) }, /does not report request authorization v1/],
    [{ newOperator: newOperator({ version: 2n }) }, /does not report request authorization v1/],
    [{ newOperator: newOperator({ owner: ELSE }) }, /owner is 0x7777/],
    [{ newOperator: newOperator({ senders: ['0xK1'] }) }, /node key 0xK2 is not an authorized sender/],
    [{ newOperator: newOperator({ keeperListed: false }) }, /does not list the ReputationKeeper: it refuses every request/],
    [{ newOperator: newOperator({ approves: false }) }, /does not approve the aggregator/],
    [{ keeper: fakeKeeper([[NEW, J1], [NEW, J2]]) }, /job cccccccc1111bbbb2222cccc33334444 is not registered on the new operator/],
    [{ keeper: fakeKeeper([[NEW, J1], [NEW, J2], [NEW, J3], [NEW, ORPHAN]]) }, /job dddddddd1111bbbb2222cccc33334444 is registered on the new operator and was not on the old one/],
    [{ keeper: fakeKeeper([[NEW, J1], [NEW, J2], [NEW, J3], [OLD, ORPHAN]]) }, /1 job id\(s\) are still registered on the old operator, with their stake: dddddddd/],
    [{ anonymousRequestReverts: async () => false }, /a request from an unapproved address was not refused/],
  ];
  for (const [overrides, reason] of cases) {
    const { problems } = await verify(overrides);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], reason);
  }
  assert.deepEqual(await checkDeployment({ operator: newOperator(), signerAddress: OWNER.toLowerCase() }), []);
});

test('a contract\'s refusal is told from an RPC failure, in ethers\' shape and in Hardhat\'s', () => {
  const { contractRefused } = require('../../arbiter-operator/scripts/lib/request-authorization.js');
  // What Hardhat's provider throws for a call a real legacy operator reverts (Base, 2026-11).
  assert.equal(contractRefused(Object.assign(new Error('execution reverted'), { code: 3 })), true);
  assert.equal(contractRefused(Object.assign(new Error('execution reverted: Unable to create request'), { code: -32000 })), true);
  assert.equal(contractRefused(Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION' })), true);
  assert.equal(contractRefused(Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA' })), true);
  for (const failure of [Object.assign(new Error('rate limit exceeded'), { code: -32005 }), Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'NETWORK_ERROR' }), new TypeError('fetch failed'), null, undefined]) {
    assert.equal(contractRefused(failure), false, String(failure && failure.message));
  }
});

test('amounts are written without rounding', () => {
  assert.equal(formatUnits(0n), '0');
  assert.equal(formatUnits(100n * E18), '100');
  assert.equal(formatUnits(20000000000000n), '0.00002');
  assert.equal(formatUnits(1n), '0.000000000000000001');
  assert.equal(formatUnits(1500000000000000000n), '1.5');
});
