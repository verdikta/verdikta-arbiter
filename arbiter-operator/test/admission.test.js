const assert = require('node:assert/strict');
const { ethers, network } = require('hardhat');
const { readJob, runJob, decodeArgs } = require('./support/job');
const { ensureRequestAuthorization } = require('../scripts/lib/request-authorization');
const { checkRequestAuthorization, VERSION_SELECTOR, REQUEST_SELECTOR } = require('../../installer/util/check-request-authorization.cjs');

describe('ArbiterOperator admission (local ERC-677 integration)', function () {
  let op, link, keeper, requester, stranger, owner, node;
  const job = ethers.encodeBytes32String('test-job');
  let nonce;
  beforeEach(async () => {
    assert.equal(network.name, 'hardhat', 'Admission tests must use the local in-memory chain');
    [owner, node] = await ethers.getSigners();
    const deploy = async name => { const c = await (await ethers.getContractFactory(name)).deploy(); await c.waitForDeployment(); return c; };
    link = await deploy('LinkToken');
    op = await (await ethers.getContractFactory('ArbiterOperator')).deploy(await link.getAddress());
    await op.waitForDeployment();
    keeper = await deploy('AdmissionKeeper');
    requester = await deploy('AdmissionRequester'); stranger = await deploy('AdmissionRequester');
    await link.grantMintRole(owner.address);
    await link.mint(requester.target, 1000); await link.mint(stranger.target, 1000);
    await op.setAuthorizedSenders([node.address]); nonce = 1;
  });
  async function approve() {
    await keeper.setApproved(requester.target, true); await op.addReputationKeeper(keeper.target);
  }
  function payload({ legacy = false, callback, sender = ethers.ZeroAddress, payment = 999, version = 2, n = nonce++ } = {}) {
    const args = [sender, payment, job];
    if (legacy) args.push(callback || requester.target);
    args.push(requester.interface.getFunction('fulfill').selector, n, version, '0x');
    return op.interface.encodeFunctionData(legacy ? 'oracleRequest' : 'operatorRequest', args);
  }
  async function send(caller = requester, options = {}, amount = 0) {
    const receipt = await (await caller.request(link.target, op.target, amount, payload(options))).wait();
    return receipt.logs.map(log => { try { return op.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === 'OracleRequest').args;
  }
  const args = event => [event.requestId, event.payment, event.requester, event.callbackFunctionId, event.cancelExpiration];
  const allowed = event => op.isAuthorizedRequest(...args(event));
  async function fulfill(event, method = 'fulfillOracleRequestV') {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256[]', 'string'], [event.requestId, [1000000, 0], 'cid:salt']);
    return op.connect(node)[method](...args(event), method === 'fulfillOracleRequest' ? ethers.ZeroHash : data, { gasLimit: 1500000 });
  }
  async function rejectedWithoutWork(action) {
    const before = await link.balanceOf(op.target);
    await assert.rejects(action);
    assert.equal(await link.balanceOf(op.target), before);
    // Rejected ERC-677 admission leaves no log to start any Chainlink task.
    assert.equal((await op.queryFilter(op.filters.OracleRequest())).length, 0);
    assert.equal(await requester.callbacks(), 0n);
  }
  it('preserves ownership and the legacy ERC-165 registration interface', async () => {
    assert.equal(await op.owner(), owner.address);
    assert.ok((await op.deploymentTransaction().wait()).gasUsed < 3500000n, 'Fits the existing deployment script gas limit');
    const marker = ['fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)',
      'isReputationKeeper(address)', 'isReputationKeeperListEmpty()']
      .reduce((value, signature) => value ^ BigInt(ethers.id(signature).slice(0, 10)), 0n);
    assert.equal(await op.supportsInterface(ethers.toBeHex(marker, 4)), true);
    assert.equal(await op.requestAuthorizationVersion(), 1n);
    assert.equal(op.interface.getFunction('requestAuthorizationVersion').selector, VERSION_SELECTOR);
    assert.equal(op.interface.getFunction('isAuthorizedRequest').selector, REQUEST_SELECTOR);
    // The installer's read-only probes against the real local contract.
    await checkRequestAuthorization({ operator: op.target, chainId: 84532, rpcUrls: 'http://local.invalid',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const result = request.method === 'eth_chainId' ? '0x14a34' : await network.provider.send(request.method, request.params);
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
      },
    });
  });
  for (const legacy of [false, true]) {
    it(`rejects an empty keeper list before ${legacy ? 'legacy' : 'multiword'} request events`, async () => {
      await rejectedWithoutWork(() => send(requester, { legacy }));
    });
    it(`rejects an unapproved caller via ${legacy ? 'oracleRequest' : 'operatorRequest'}, despite a forged approved sender`, async () => {
      await approve();
      await rejectedWithoutWork(() => send(stranger, { legacy, sender: requester.target, callback: stranger.target }, 10));
      assert.equal(await link.balanceOf(stranger.target), 1000n);
    });
    it(`admits and fulfills an approved ${legacy ? 'legacy' : 'multiword'} v2 request`, async () => {
      await approve();
      const event = await send(requester, { legacy, sender: stranger.target }, 10);
      assert.equal(event.requester, requester.target); // token overwrites the claimed sender
      assert.equal(event.payment, 10n); // token overwrites the claimed payment
      assert.equal(await allowed(event), true);
      await (await fulfill(event)).wait();
      assert.equal(await requester.callbacks(), 1n);
      assert.equal(await op.withdrawable(), 10n);
      assert.equal(await allowed(event), false);
    });
  }
  it('supports zero-token requests used by the ETH-funded dispatcher', async () => {
    await approve(); const event = await send();
    assert.equal(event.payment, 0n); assert.equal(await allowed(event), true);
    await (await fulfill(event)).wait(); assert.equal(await requester.callbacks(), 1n);
  });
  it('rejects direct calls not from the configured payment token', async () => {
    await approve();
    await rejectedWithoutWork(() => op.onTokenTransfer(requester.target, 0, payload()));
    await rejectedWithoutWork(() => owner.sendTransaction({ to: op.target, data: payload() }));
  });
  it('rejects a real ERC-677 transfer from an EOA even if a keeper approves it', async () => {
    await approve(); await keeper.setApproved(owner.address, true);
    await rejectedWithoutWork(() => link.transferAndCall(op.target, 0, payload()));
  });
  it('rejects distinct legacy callbacks and unsupported data versions before events', async () => {
    await approve(); await keeper.setApproved(stranger.target, true);
    await rejectedWithoutWork(() => send(requester, { legacy: true, callback: stranger.target }));
    await rejectedWithoutWork(() => send(requester, { version: 1 }));
  });
  for (const mode of [1, 2, 3, 4, 5, 6]) {
    it(`denies malformed/reverting/exhausted keeper mode ${mode} at configuration and admission`, async () => {
      await keeper.setMode(mode);
      await assert.rejects(() => op.addReputationKeeper(keeper.target), /RK: interface/);
      await keeper.setMode(0); await approve(); await keeper.setMode(mode);
      assert.equal(await op.isRequesterApproved(requester.target), false);
      await rejectedWithoutWork(() => send());
    });
  }
  it('continues to a valid keeper when another keeper fails', async () => {
    await approve(); await keeper.setMode(5);
    const good = await (await ethers.getContractFactory('AdmissionKeeper')).deploy();
    await good.setApproved(requester.target, true); await op.addReputationKeeper(good.target);
    assert.equal(await allowed(await send()), true);
  });
  it('requires owner authority for keepers and denies after removing the last one', async () => {
    await assert.rejects(() => op.connect(node).addReputationKeeper(keeper.target));
    await approve(); await assert.rejects(() => op.connect(node).removeReputationKeeper(keeper.target));
    await op.removeReputationKeeper(keeper.target);
    assert.equal(await op.isReputationKeeperListEmpty(), true);
    await rejectedWithoutWork(() => send());
  });
  it('rejects forged and unknown event parameters at the pre-work boundary', async () => {
    await approve(); const event = await send(); const valid = args(event);
    for (const [index, value] of [[0, ethers.ZeroHash], [1, 5], [2, stranger.target], [3, '0x12345678'], [4, event.cancelExpiration + 1n]]) {
      const changed = [...valid]; changed[index] = value;
      assert.equal(await op.isAuthorizedRequest(...changed), false);
    }
  });
  it('revocation blocks pre-work and every fulfillment selector', async () => {
    await approve(); const event = await send(); await keeper.setApproved(requester.target, false);
    assert.equal(await allowed(event), false);
    for (const method of ['fulfillOracleRequestV', 'fulfillOracleRequest2', 'fulfillOracleRequest']) {
      await assert.rejects(() => fulfill(event, method), /requester not approved/);
    }
    assert.equal(await requester.callbacks(), 0n);
  });
  it('permits pending work after the refund threshold, but denies cancelled requests', async () => {
    await approve(); const event = await send(requester, {}, 10);
    await network.provider.send('evm_setNextBlockTimestamp', [Number(event.cancelExpiration)]);
    await network.provider.send('evm_mine'); assert.equal(await allowed(event), true);
    await keeper.setApproved(requester.target, false);
    await requester.cancel(op.target, event.requestId, event.payment, event.callbackFunctionId, event.cancelExpiration);
    assert.equal(await link.balanceOf(requester.target), 1000n);
    await keeper.setApproved(requester.target, true); assert.equal(await allowed(event), false);
  });
  it('every result the job reads from an ethabidecode is a key that task produces', async () => {
    // abi="(bool allowed)" decodes on Chainlink 2.23.0 under the key "allowed)": the conditional
    // after it then fails on every request and the bridge is never called.
    assert.deepEqual(decodeArgs('(bool allowed)'), [{ type: 'bool', name: 'allowed)' }]);
    assert.deepEqual(decodeArgs('bytes32 requestId, uint256[] value'), [{ type: 'bytes32', name: 'requestId' }, { type: 'uint256', name: 'value' }]);
    const tasks = readJob();
    const decoders = [...tasks].filter(([, task]) => task.type === 'ethabidecode');
    assert.equal(decoders.length, 2);
    for (const [name, task] of decoders) {
      const keys = decodeArgs(task.abi).map(arg => arg.name);
      const read = [...tasks.values()].flatMap(other => Object.values(other).filter(value => typeof value === 'string'))
        .flatMap(value => [...value.matchAll(new RegExp(`\\$\\(${name}\\.(\\w+)\\)`, 'g'))].map(match => match[1]));
      assert.ok(read.length > 0, `${name} is read`);
      for (const key of read) assert.ok(keys.includes(key), `$(${name}.${key}) is not a key of abi="${task.abi}"`);
    }
  });
  it('the parsed job permits approved work and blocks revoked, forged, and RPC-failed work', async () => {
    await approve(); const event = await send();
    assert.deepEqual(await runJob({ event, op, ethers }), { bridge: 1, transaction: 1 });
    assert.deepEqual(await runJob({ event, op, ethers, rpcFailure: true }), { bridge: 0, transaction: 0 });
    const forged = { requestId: ethers.ZeroHash, payment: event.payment, requester: event.requester,
      callbackFunctionId: event.callbackFunctionId, cancelExpiration: event.cancelExpiration };
    assert.deepEqual(await runJob({ event: forged, op, ethers }), { bridge: 0, transaction: 0 });
    await keeper.setApproved(requester.target, false);
    assert.deepEqual(await runJob({ event, op, ethers }), { bridge: 0, transaction: 0 });
  });
  it('the parsed job rechecks revocation after the bridge before submitting a transaction', async () => {
    await approve(); const event = await send();
    assert.deepEqual(await runJob({ event, op, ethers, bridge: () => keeper.setApproved(requester.target, false) }),
      { bridge: 1, transaction: 0 });
  });
  it('the parsed job denies fulfilled requests and supports 780-second code-review work', async () => {
    await approve(); const fulfilled = await send(); await (await fulfill(fulfilled)).wait();
    assert.deepEqual(await runJob({ event: fulfilled, op, ethers }), { bridge: 0, transaction: 0 });
    const pending = await send();
    assert.deepEqual(await runJob({ event: pending, op, ethers, bridge: async () => {
      await network.provider.send('evm_increaseTime', [780]);
      await network.provider.send('evm_mine');
    } }), { bridge: 1, transaction: 1 });
    await (await fulfill(pending)).wait();
    assert.equal(await allowed(pending), false);
  });
  it('registration configures the selected keeper, is idempotent, and refuses unapproved aggregators', async () => {
    const options = { operator: op, keeper, keeperAddress: keeper.target, aggregatorAddress: requester.target,
      signerAddress: owner.address, log: () => {} };
    await assert.rejects(() => ensureRequestAuthorization(options), /not approved/);
    assert.equal(await op.isReputationKeeperListEmpty(), true);
    await keeper.setApproved(requester.target, true);
    await assert.rejects(() => ensureRequestAuthorization({ ...options, signerAddress: node.address }), /operator owner/);
    await ensureRequestAuthorization(options); await ensureRequestAuthorization(options);
    assert.equal((await op.queryFilter(op.filters.ReputationKeeperAdded())).length, 1);
    assert.equal(await allowed(await send()), true);
    await keeper.setApproved(requester.target, false);
    await assert.rejects(() => ensureRequestAuthorization(options), /not approved/);
    await assert.rejects(() => ensureRequestAuthorization({ ...options, operator: requester }), /Deploy the hardened operator/);
  });

  // An operator deployed before request authorization (contracts/test/LegacyArbiterOperator.sol).
  // Its node still takes this release: the contract admits anyone, so the job asks the keeper.
  describe('a legacy operator, guarded by its jobs', () => {
    const { describeOperator } = require('../../installer/util/check-request-authorization.cjs');
    const { expectedJob } = require('../../installer/util/job-template.cjs');
    const template = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../chainlink-node/basicJobSpec'), 'utf8');
    let legacy, dag;
    beforeEach(async () => {
      legacy = await (await ethers.getContractFactory('LegacyArbiterOperator')).deploy(await link.getAddress());
      await legacy.waitForDeployment();
      await legacy.setAuthorizedSenders([node.address]);
      dag = expectedJob(template, { operator: legacy.target, chainId: 31337, token: 'a'.repeat(64), mode: 'legacy', keeper: keeper.target }).dag;
    });
    async function sendLegacy(caller) {
      const data = legacy.interface.encodeFunctionData('operatorRequest',
        [ethers.ZeroAddress, 999, job, caller.interface.getFunction('fulfill').selector, nonce++, 2, '0x']);
      const receipt = await (await caller.request(link.target, legacy.target, 0, data)).wait();
      return receipt.logs.map(log => { try { return legacy.interface.parseLog(log); } catch { return null; } })
        .find(log => log?.name === 'OracleRequest').args;
    }
    const run = (event, extra = {}) => runJob({ event, op: legacy, ethers, dag, gate: keeper.target, ...extra });

    it('the contract admits an unapproved requester, and the job stops before the bridge', async () => {
      assert.equal(await legacy.isReputationKeeperListEmpty(), true);
      // What the hardened contract refuses on chain: an OracleRequest from a contract no keeper approved.
      const anonymous = await sendLegacy(stranger);
      assert.equal(anonymous.requester, stranger.target);
      assert.deepEqual(await run(anonymous), { bridge: 0, transaction: 0 });
      // The template's own job is no guard there: the legacy contract has no isAuthorizedRequest.
      assert.deepEqual(await runJob({ event: anonymous, op: legacy, ethers }), { bridge: 0, transaction: 0 });
    });
    it('an approved requester is served; revocation, also after the bridge, and an RPC failure stop the job', async () => {
      await keeper.setApproved(requester.target, true);
      const event = await sendLegacy(requester);
      assert.deepEqual(await run(event), { bridge: 1, transaction: 1 });
      assert.deepEqual(await run(event, { rpcFailure: true }), { bridge: 0, transaction: 0 });
      assert.deepEqual(await run(event, { bridge: () => keeper.setApproved(requester.target, false) }), { bridge: 1, transaction: 0 });
      assert.deepEqual(await run(event), { bridge: 0, transaction: 0 });
      // The requester in the event is the address the token saw, whatever the payload claims.
      const data = legacy.interface.encodeFunctionData('operatorRequest',
        [requester.target, 999, job, stranger.interface.getFunction('fulfill').selector, nonce++, 2, '0x']);
      const receipt = await (await stranger.request(link.target, legacy.target, 0, data)).wait();
      const forged = receipt.logs.map(log => { try { return legacy.interface.parseLog(log); } catch { return null; } })
        .find(log => log?.name === 'OracleRequest').args;
      assert.equal(forged.requester, stranger.target);
      await keeper.setApproved(requester.target, true);
      assert.deepEqual(await run(forged), { bridge: 0, transaction: 0 });
    });
    it('a keeper that reverts, hangs or answers nonsense opens nothing', async () => {
      await keeper.setApproved(requester.target, true);
      const event = await sendLegacy(requester);
      for (const mode of [1, 2, 3, 5, 6]) {
        await keeper.setMode(mode);
        assert.deepEqual(await run(event), { bridge: 0, transaction: 0 }, `keeper mode ${mode}`);
      }
      await keeper.setMode(0);
      assert.deepEqual(await run(event), { bridge: 1, transaction: 1 });
    });
    it('both jobs keep every result an ethabidecode is read for', async () => {
      const tasks = readJob(dag);
      assert.equal(tasks.get('authorize_call').contract, keeper.target);
      assert.equal(tasks.get('reauthorize_call').contract, keeper.target);
      assert.equal(tasks.get('authorize_data').abi, 'isContractApproved(address contractAddress)');
      // Everything else is the template's: same tasks, same edges.
      const base = readJob();
      assert.deepEqual([...tasks.keys()], [...base.keys()]);
      for (const [name, task] of tasks) {
        assert.deepEqual(task.parents, base.get(name).parents, name);
        if (!['authorize_data', 'authorize_call', 'reauthorize_call'].includes(name)) assert.equal(task.type, base.get(name).type, name);
      }
    });
    it('the installer tells it from a v1 operator, and registration accepts it without touching its keeper list', async () => {
      const rpc = async (_url, init) => {
        const request = JSON.parse(init.body);
        try {
          const result = await network.provider.send(request.method, request.params);
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) };
        } catch (error) {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted' } }) };
        }
      };
      const chainId = 84532;
      const chain = async (url, init) => JSON.parse(init.body).method === 'eth_chainId'
        ? { ok: true, json: async () => ({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x14a34' }) } : rpc(url, init);
      const base = { chainId, rpcUrls: 'http://local.invalid', fetchImpl: chain };
      assert.deepEqual(await describeOperator({ ...base, operator: op.target }), { mode: 'v1' });
      // The keeper is the aggregator's; this fixture is both, as AdmissionKeeper has no reputationKeeper().
      await assert.rejects(() => describeOperator({ ...base, operator: legacy.target }), /names no aggregator/);
      await assert.rejects(() => describeOperator({ ...base, operator: legacy.target, aggregator: requester.target, allowUnregistered: true }),
        /names no ReputationKeeper/);
      const options = { operator: legacy, keeper, keeperAddress: keeper.target, aggregatorAddress: requester.target,
        signerAddress: owner.address, log: () => {} };
      await assert.rejects(() => ensureRequestAuthorization(options), /not approved/);
      await keeper.setApproved(requester.target, true);
      await ensureRequestAuthorization(options);
      assert.equal(await legacy.isReputationKeeperListEmpty(), true);
      assert.equal((await legacy.queryFilter(legacy.filters.ReputationKeeperAdded())).length, 0);
    });
  });
});
