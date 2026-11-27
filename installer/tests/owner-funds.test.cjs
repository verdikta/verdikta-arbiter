// arbiter-operator/scripts/lib/funds.js: the owner wallet's gas money, said in
// one line. The case it was written for (Base Sepolia, 2026-11-21): ten
// deregistrations at a fixed 5 gwei left the wallet 0.000296 ETH, and the
// registration that followed ended, after a fallback gas limit and four static
// calls, with
//   ProviderError: insufficient funds for gas * price + value: have 296326845228620 want 2138235000000000
// Run: node --test installer/tests/owner-funds.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const funds = require('../../arbiter-operator/scripts/lib/funds.js');

const SENDER = '0x00000000000000000000000000000000000000A1'; // made up
const GWEI = 1_000_000_000n;
const REFUSAL = 'insufficient funds for gas * price + value: have 296326845228620 want 2138235000000000';

function fakeProvider({ balance, maxFeePerGas = null, gasPrice = null, failBalance = false }) {
  const calls = [];
  return {
    calls,
    getBalance: async (address) => {
      calls.push(['getBalance', address]);
      if (failBalance) throw new Error('503 from the endpoint');
      return balance;
    },
    getFeeData: async () => {
      calls.push(['getFeeData']);
      return { maxFeePerGas, gasPrice };
    },
  };
}

test('amounts are printed without losing small ones', () => {
  assert.equal(funds.formatEth(0n), '0');
  assert.equal(funds.formatEth(10n ** 18n), '1');
  assert.equal(funds.formatEth(296326845228620n), '0.00029632');
  assert.equal(funds.formatEth(2138235000000000n), '0.00213823');
  assert.equal(funds.formatEth(5n), '<0.00000001'); // dust is not "0"
  assert.equal(funds.formatGwei(5n * GWEI), '5');
  assert.equal(funds.formatGwei(5_000_000n), '0.005');
  assert.equal(funds.formatGwei(7_382_812n), '0.007382812');
});

test('a refusal for lack of funds is recognised wherever the node text ends up', () => {
  assert.equal(funds.isInsufficientFunds(new Error(REFUSAL)), true);
  assert.equal(funds.isInsufficientFunds({ code: 'INSUFFICIENT_FUNDS', message: 'x' }), true); // ethers
  assert.equal(funds.isInsufficientFunds({ message: 'could not coalesce error', error: { message: REFUSAL } }), true);
  assert.equal(funds.isInsufficientFunds({ message: 'x', info: { error: { message: 'Insufficient funds for transfer' } } }), true);
  assert.equal(funds.isInsufficientFunds({ message: 'wrapped', cause: { parent: { message: REFUSAL } } }), true);
  assert.equal(funds.isInsufficientFunds(REFUSAL), true);
  assert.equal(funds.isInsufficientFunds(new Error('execution reverted: Oracle is already registered')), false);
  assert.equal(funds.isInsufficientFunds(new Error('in-flight transaction limit reached')), false);
  assert.equal(funds.isInsufficientFunds(null), false);
  assert.deepEqual(funds.parseHaveWant(new Error(REFUSAL)), { have: 296326845228620n, want: 2138235000000000n });
  assert.equal(funds.parseHaveWant(new Error('insufficient funds')), null);
});

test('the check passes on the network price where the pinned 5 gwei did not', async () => {
  const calls = [{ count: 9, gas: 500_000 }, { count: 1, gas: 100_000 }];
  const lines = [];
  // The network's max fee that day: about 0.0074 gwei.
  const network = fakeProvider({ balance: 296326845228620n, maxFeePerGas: 7_382_812n });
  const ok = await funds.checkGasBudget({ provider: network, sender: SENDER, calls, configuredGasPrice: 'auto', what: '9 registration(s)', log: (l) => lines.push(l) });
  assert.equal(ok.pinned, false);
  assert.equal(ok.needed, 4_600_000n * 7_382_812n);
  assert.match(lines.join('\n'), /Owner ETH balance: 0\.00029632/);
  assert.match(lines.join('\n'), /Gas for 9 registration\(s\): up to 0\.00003396 ETH \(4600000 gas at up to 0\.007382812 gwei\)/);

  const pinned = fakeProvider({ balance: 296326845228620n, maxFeePerGas: 7_382_812n });
  await assert.rejects(
    funds.checkGasBudget({ provider: pinned, sender: SENDER, calls, configuredGasPrice: 5_000_000_000, what: '9 registration(s)', log: () => {} }),
    (e) => {
      assert.equal(e.code, funds.OWNER_FUNDS);
      assert.match(e.message, new RegExp(`The owner wallet ${SENDER} holds 0\\.00029632 ETH and 9 registration\\(s\\) can take 0\\.023 ETH in gas`));
      assert.match(e.message, /at the pinned gas price of 5 gwei \(VERDIKTA_GAS_PRICE_GWEI\)/);
      assert.match(e.message, /Nothing was sent for it/);
      assert.match(e.message, /at least 0\.02270367 ETH more/);
      assert.match(e.message, /already registered are skipped/);
      return true;
    }
  );
  assert.deepEqual(pinned.calls.map((c) => c[0]), ['getBalance']); // a pinned price asks the network nothing
});

test('the budget price: the pinned one, else the max fee, else the legacy price, else an error', async () => {
  assert.deepEqual(await funds.budgetGasPrice({ provider: fakeProvider({}), configured: 50_000_000 }), { gasPrice: 50_000_000n, pinned: true });
  assert.deepEqual(await funds.budgetGasPrice({ provider: fakeProvider({ maxFeePerGas: 11n, gasPrice: 6n }), configured: 'auto' }), { gasPrice: 11n, pinned: false });
  assert.deepEqual(await funds.budgetGasPrice({ provider: fakeProvider({ gasPrice: 6n }), configured: undefined }), { gasPrice: 6n, pinned: false });
  await assert.rejects(funds.budgetGasPrice({ provider: fakeProvider({}), configured: 'auto' }), /gave no gas price/);
});

test('a call that is not needed adds nothing, and an exact balance is enough', async () => {
  const provider = fakeProvider({ balance: 500_000n * 10n, maxFeePerGas: 10n });
  const ok = await funds.checkGasBudget({ provider, sender: SENDER, calls: [{ count: 1, gas: 500_000 }, { count: 0, gas: 100_000 }], configuredGasPrice: 'auto', what: '1 registration(s)', log: () => {} });
  assert.equal(ok.needed, 5_000_000n);
  const short = fakeProvider({ balance: 500_000n * 10n - 1n, maxFeePerGas: 10n });
  await assert.rejects(funds.checkGasBudget({ provider: short, sender: SENDER, calls: [{ count: 1, gas: 500_000 }], configuredGasPrice: 'auto', what: '1 registration(s)', log: () => {} }), { code: funds.OWNER_FUNDS });
});

test('a send the node refused is said with its own numbers', async () => {
  const e = await funds.describeRefusedSend({ error: new Error(REFUSAL), provider: fakeProvider({ balance: 1n }), sender: SENDER, what: 'registering job id abc' });
  assert.equal(e.code, funds.OWNER_FUNDS);
  assert.match(e.message, /holds 0\.00029632 ETH and registering job id abc can take 0\.00213823 ETH in gas\./);
  assert.match(e.message, /at least 0\.0018419 ETH more/);
});

test('a refusal without numbers still names the wallet, with its balance when it can be read', async () => {
  const read = await funds.describeRefusedSend({ error: { code: 'INSUFFICIENT_FUNDS' }, provider: fakeProvider({ balance: 42n * 10n ** 12n }), sender: SENDER, what: 'this call' });
  assert.equal(read.code, funds.OWNER_FUNDS);
  assert.match(read.message, new RegExp(`The owner wallet ${SENDER} cannot pay the gas for this call \\(it holds 0\\.000042 ETH\\)`));
  const unread = await funds.describeRefusedSend({ error: { code: 'INSUFFICIENT_FUNDS' }, provider: fakeProvider({ failBalance: true }), sender: SENDER, what: 'this call' });
  assert.match(unread.message, /cannot pay the gas for this call\. Fund it/);
});

// A deregistration says "deregistered", not "registered", in the same sentence.
test('the sentence ends with what a second run skips: registered, or deregistered', async () => {
  const short = fakeProvider({ balance: 1n, maxFeePerGas: 10n });
  await assert.rejects(
    funds.checkGasBudget({ provider: short, sender: SENDER, calls: [{ count: 1, gas: 300_000 }], configuredGasPrice: 'auto', what: '1 deregistration(s)', rerun: funds.RERUN_DEREGISTER, log: () => {} }),
    (e) => e.code === funds.OWNER_FUNDS && /run this again: job ids already deregistered are skipped\.$/.test(e.message)
  );
  const numbers = await funds.describeRefusedSend({ error: new Error(REFUSAL), provider: short, sender: SENDER, what: 'deregistering job id abc', rerun: funds.RERUN_DEREGISTER });
  assert.match(numbers.message, /deregistering job id abc can take 0\.00213823 ETH in gas\. Nothing was sent for it\..*already deregistered are skipped\.$/);
  const bare = await funds.describeRefusedSend({ error: { code: 'INSUFFICIENT_FUNDS' }, provider: fakeProvider({ failBalance: true }), sender: SENDER, what: 'this call', rerun: funds.RERUN_DEREGISTER });
  assert.match(bare.message, /Fund it and run this again: job ids already deregistered are skipped\.$/);
  const dflt = await funds.describeRefusedSend({ error: new Error(REFUSAL), provider: short, sender: SENDER, what: 'registering job id abc' });
  assert.match(dflt.message, /already registered are skipped\.$/);
});

// The shape of the job change of 2026-11-21, with the check it did not have:
// ten jobs to deregister, nine to register, at the fixed 5 gwei, and a wallet
// that can pay for the first half and not for the second.
test('a job change is checked whole before its first deregistration', async () => {
  assert.equal(funds.deregistrationBudget({ deregistrations: 0, thenRegister: 0 }), null);
  assert.deepEqual(funds.deregistrationBudget({ deregistrations: 3 }), { calls: [{ count: 3, gas: 300_000 }], what: '3 deregistration(s)' });
  const change = funds.deregistrationBudget({ deregistrations: 10, thenRegister: 9 });
  assert.deepEqual(change.calls, [{ count: 10, gas: 300_000 }, { count: 9, gas: 500_000 }, { count: 1, gas: 100_000 }, { count: 1, gas: 500_000 }]);
  assert.equal(change.what, '10 deregistration(s) and the 9 registration(s) that follow (with their approval and the key authorization)');
  // Nothing registered now, registrations to come: still checked.
  assert.deepEqual(funds.deregistrationBudget({ deregistrations: 0, thenRegister: 2 }).calls[1], { count: 2, gas: 500_000 });

  const startBalance = 20_000_000_000_000_000n; // 0.02 ETH
  const gas = 10n * 300_000n + 9n * 500_000n + 100_000n + 500_000n;
  // The deregistrations alone pass at 5 gwei (0.015 ETH at most).
  await funds.checkGasBudget({ provider: fakeProvider({ balance: startBalance }), sender: SENDER, configuredGasPrice: 5_000_000_000, rerun: funds.RERUN_DEREGISTER, log: () => {}, ...funds.deregistrationBudget({ deregistrations: 10 }) });
  // The whole change does not, and says so while all ten are still registered.
  await assert.rejects(
    funds.checkGasBudget({ provider: fakeProvider({ balance: startBalance }), sender: SENDER, configuredGasPrice: 5_000_000_000, rerun: funds.RERUN_DEREGISTER, log: () => {}, ...change }),
    (e) => {
      assert.equal(e.code, funds.OWNER_FUNDS);
      assert.match(e.message, /holds 0\.02 ETH and 10 deregistration\(s\) and the 9 registration\(s\) that follow \(with their approval and the key authorization\) can take 0\.0405 ETH in gas at the pinned gas price of 5 gwei/);
      assert.match(e.message, /Nothing was sent for it/);
      return true;
    }
  );
  // At the network's price the same wallet pays for all of it many times over.
  const ok = await funds.checkGasBudget({ provider: fakeProvider({ balance: startBalance, maxFeePerGas: 7_382_812n }), sender: SENDER, configuredGasPrice: 'auto', rerun: funds.RERUN_DEREGISTER, log: () => {}, ...change });
  assert.equal(ok.needed, gas * 7_382_812n);
  assert.ok(ok.needed * 100n < startBalance);
});

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

// The deregistration script: the check is the run's beforeSend, a refusal for
// funds skips the fallback gas limit, and the exit code is the one the
// installer reads.
test('unregister-oracle-cl.js checks the gas money before it sends, and exits 66 when the wallet cannot pay', () => {
  const source = read('arbiter-operator/scripts/unregister-oracle-cl.js');
  assert.equal(funds.OWNER_FUNDS_EXIT, 66);
  assert.match(source, /\.option\("then-register",\s+\{ type: "number",\s+default: 0 \}\)/);
  assert.match(source, /deregistrationBudget\(\{ deregistrations: pending\.length, thenRegister: argv\["then-register"\] \}\)/);
  assert.match(source, /configuredGasPrice: hre\.network\.config\.gasPrice/);
  assert.match(source, /await runDeregistration\(\{[\s\S]{0,200}beforeSend,\s*\}\);/);
  const stop = source.indexOf('if (isInsufficientFunds(error))');
  const fallbackNote = source.indexOf('Gas estimation failed, trying with fallback gas limit');
  assert.ok(stop > 0 && stop < fallbackNote, 'a refusal for funds must stop before the fallback gas limit');
  assert.match(source, /shown\.code === OWNER_FUNDS[\s\S]{0,160}process\.exit\(OWNER_FUNDS_EXIT\)/);
  // The shell side of the same number.
  assert.match(read('installer/bin/upgrade-arbiter.sh'), /\[ "\$unregister_rc" -eq 66 \]/);
  assert.match(read('installer/bin/upgrade-arbiter.sh'), /\[ "\$dereg_rc" -eq 66 \]/);
  assert.match(read('installer/util/unregister-oracle.sh'), /exit \$UNREGISTER_RC/);
});

// Without a limit of its own the approval gets the network's configured `gas`
// (10,000,000 on Base Sepolia), and the node wants the wallet to hold that much
// at the max fee: twenty times the budget the check gave it.
test('the approval is sent with the limit it is budgeted at', () => {
  const source = read('arbiter-operator/scripts/register-oracle-cl.js');
  assert.match(source, /verdikta\.approve\(keeperAddr, totalStake, \{ gasLimit: GAS_BUDGET\.approve \}\)/);
  assert.match(source, /\{ count: pendingJobs\.length, gas: GAS_BUDGET\.register \}/);
  assert.equal(funds.GAS_BUDGET.approve, 100_000);
});

// upgrade-arbiter.sh puts register-oracle-cl.js into the install before the
// job-template check can register with it, ahead of the full copy. Every
// module the script requires has to go with it.
test('the upgrade copies the registration script with everything it requires', () => {
  const upgrade = read('installer/bin/upgrade-arbiter.sh');
  const early = upgrade.slice(upgrade.indexOf('# Re-registration below must use the admission-aware script'), upgrade.indexOf('# Check for job specification template changes BEFORE component upgrades'));
  assert.match(early, /cp "\$REPO_ROOT\/arbiter-operator\/scripts\/register-oracle-cl\.js"/);
  assert.match(early, /cp "\$REPO_ROOT\/arbiter-operator\/scripts\/lib\/"\*\.js "\$TARGET_DIR\/arbiter-operator\/scripts\/lib\/"/);
  for (const script of ['register-oracle-cl.js', 'unregister-oracle-cl.js']) {
    const required = [...read(`arbiter-operator/scripts/${script}`).matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(required.includes('lib/funds.js'), script);
    for (const rel of required) {
      assert.match(rel, /^lib\/[a-z-]+\.js$/, `${script} requires ${rel}: the upgrade's early copy takes scripts/lib/*.js only`);
      assert.ok(fs.existsSync(path.resolve(__dirname, '../../arbiter-operator/scripts', rel)), rel);
    }
  }
});

// The registration script: the check runs before the first transaction, and a
// refusal for funds skips the gas-limit retries that buried it.
test('register-oracle-cl.js checks the gas money before it sends, and stops on a refusal for funds', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../arbiter-operator/scripts/register-oracle-cl.js'), 'utf8');
  const check = source.indexOf('await checkGasBudget({');
  const approve = source.indexOf('verdikta.approve(');
  const firstSend = source.indexOf('await keeper.registerOracle(oracleAddr');
  assert.ok(check > 0 && approve > check && firstSend > check, 'checkGasBudget must come before approve and registerOracle');
  assert.match(source, /configuredGasPrice: hre\.network\.config\.gasPrice/);
  const estimateCatch = source.indexOf('} catch (estimateError) {');
  const fallbackNote = source.indexOf('Gas estimation failed, trying with fallback gas limit');
  const stop = source.indexOf('if (isInsufficientFunds(estimateError))');
  assert.ok(estimateCatch > 0 && stop > estimateCatch && stop < fallbackNote, 'a refusal for funds must stop before the fallback gas limit');
  assert.match(source, /if \(isInsufficientFunds\(fallbackError\)\)/);
  assert.match(source, /shown\.code === OWNER_FUNDS[\s\S]{0,120}console\.error\(`Error during oracle registration: \$\{shown\.message\}`\)/);
});
