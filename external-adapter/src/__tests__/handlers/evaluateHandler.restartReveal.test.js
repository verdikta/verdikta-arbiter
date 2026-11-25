// An adapter restart (or upgrade) between a commit and its reveal must not lose the reveal: with the
// v2 keeper each promoted slot that cannot be revealed is a failed reveal (T_MISS_FAILED). The commit
// goes through one loaded copy of the handler and commit store, the reveal through a fresh one that
// only shares the store directory (COMMIT_STORE_DIR, set per test file by jest.setup.js).
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

jest.mock('../../services/aiClient');
const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return {
    ...actual,
    createClient: (cfg) => {
      const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
      client.archiveService.getArchive = jest.fn();
      client.ipfsClient.uploadToIPFS = jest.fn();
      mockState.client = client;
      return client;
    }
  };
});

const cid = require('../helpers/cid.cjs');
const FIXTURES = path.join(__dirname, '..', 'integration', 'fixtures', 'bcid');
const PRIMARY = cid('BountyPrimary');
const NOT_JSON = cid('PrimaryNotJson');
const ARCHIVES = { [PRIMARY]: 'bounty-primary.zip', [NOT_JSON]: 'bcid-primary-not-json.zip' };
const AGG = '0x' + '0'.repeat(63) + '7';
const request = (cidString) => ({ id: 'job-1', data: { cid: cidString, aggId: AGG } });

/** a fresh process: the handler, the store and the mocked client loaded again */
function boot() {
  let handler;
  jest.isolateModules(() => { handler = require('../../handlers/evaluateHandler'); });
  const { archiveService, ipfsClient } = mockState.client;
  archiveService.getArchive.mockImplementation(async (c) => fs.readFileSync(path.join(FIXTURES, ARCHIVES[c])));
  ipfsClient.uploadToIPFS.mockResolvedValue('QmJustificationAfterRestart');
  return handler;
}

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => console.log.mockRestore());

test('a commit made before a restart is revealed after it, and the reveal opens the commitment', async () => {
  const before = boot();
  const commit = await before(request(`1:${PRIMARY},${NOT_JSON}`));
  expect(commit.statusCode).toBe(200);
  const [commitment] = commit.data.aggregatedScore;
  const file = path.join(process.env.COMMIT_STORE_DIR, `${BigInt(commitment).toString(16).padStart(64, '0')}.json`);
  expect(fs.existsSync(file)).toBe(true);                        // durable before the commit was answered
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);

  const after = boot();                                           // the restarted adapter
  expect(after).not.toBe(before);
  const reveal = await after(request(`2:${BigInt(commitment).toString(16).padStart(64, '0')}`));
  expect(reveal.statusCode).toBe(200);
  const [cidPart, salt] = reveal.data.justificationCid.split(':');
  expect(cidPart).toBe('QmJustificationAfterRestart');
  const onChain = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['bytes32', 'address', 'uint256[]', 'uint256'],
    [AGG, process.env.OPERATOR_ADDR, reveal.data.aggregatedScore, BigInt('0x' + salt)]));
  expect(BigInt(onChain).toString()).toBe(commitment);
});
