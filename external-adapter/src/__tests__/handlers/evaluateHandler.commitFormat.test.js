// The v2 commitment (verdikta-dispatcher, ReputationAggregator items 4 and 5):
//   keccak256(abi.encode(bytes32 aggId, address operator, uint256[] scores, uint256 salt)), all 32 bytes,
// with a 128-bit salt. The aggregator recomputes exactly this at reveal, so any drift here makes every
// reveal fail on chain. The reference value comes from the dispatcher's own test helper
// (reputationBasedAggregator/test/helpers.js commitWord), whose tests check it against the contract.
jest.mock('../../services/aiClient');
const { commitmentHash } = require('../../handlers/evaluateHandler');

const AGG = '0x' + '0'.repeat(63) + '5';                       // bytes32(roundId 5): v2 ids are sequential
const OPERATOR = '0x1234567890AbcdEF1234567890aBcdef12345678';
const SALT = (1n << 127n) | 1n;                                  // a full 128-bit salt
const SCORES = [600000n, 400000n];

describe('v2 commitment', () => {
  it('matches the dispatcher helper that the aggregator tests check against the contract', () => {
    expect(commitmentHash(AGG, OPERATOR, SCORES, SALT))
      .toBe('a4bc7ea099d8f74b935af3719549f3c07a771c0e7409e895b2700b29ed769945');
  });

  it('is 64 lowercase hex chars and ignores the operator address case', () => {
    const h = commitmentHash(AGG, OPERATOR, SCORES, SALT);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(commitmentHash(AGG, OPERATOR.toLowerCase(), SCORES, SALT)).toBe(h);
  });

  it('binds the round, the operator, the scores and the salt', () => {
    const h = commitmentHash(AGG, OPERATOR, SCORES, SALT);
    const other = '0x' + '0'.repeat(63) + '6';
    expect(commitmentHash(other, OPERATOR, SCORES, SALT)).not.toBe(h);
    expect(commitmentHash(AGG, '0x' + '11'.repeat(20), SCORES, SALT)).not.toBe(h);
    expect(commitmentHash(AGG, OPERATOR, [400000n, 600000n], SALT)).not.toBe(h);
    expect(commitmentHash(AGG, OPERATOR, SCORES, SALT + 1n)).not.toBe(h);
  });
});
