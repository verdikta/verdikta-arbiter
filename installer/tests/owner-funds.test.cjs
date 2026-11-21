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
