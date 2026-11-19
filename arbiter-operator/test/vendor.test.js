const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

describe('Pinned Operator adaptation', () => {
  it('differs from Chainlink 1.4.0 only in imports and three hook/storage declarations', () => {
    const original = fs.readFileSync(require.resolve('@chainlink/contracts/src/v0.8/operatorforwarder/Operator.sol'), 'utf8');
    assert.equal(createHash('sha256').update(original).digest('hex'), '581105b56dac6fbdb575cfa00142b616a7f345a56425a914b61dd775f4075a81');
    const adapted = original.replace(/from "([^"]+)"/g, (_match, relative) =>
      `from "@chainlink/contracts/${path.posix.normalize('src/v0.8/operatorforwarder/' + relative)}"`)
      .replace('mapping(bytes32 => Commitment) private s_commitments;', 'mapping(bytes32 => Commitment) internal s_commitments;')
      .replace(') private validateNotToLINK(callbackAddress)', ') internal virtual validateNotToLINK(callbackAddress)')
      .replace('uint256 dataVersion\n  ) internal {', 'uint256 dataVersion\n  ) internal virtual {');
    assert.equal(fs.readFileSync(path.join(__dirname, '../contracts/vendor/Operator.sol'), 'utf8'), adapted);
  });
});
