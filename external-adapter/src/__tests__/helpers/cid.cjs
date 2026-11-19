const crypto = require('crypto');
const { utils } = require('ethers');

// Valid CIDv0 multihash, unlike a Qm prefix padded with arbitrary text.
module.exports = label => utils.base58.encode(Buffer.concat([
  Buffer.from([0x12, 0x20]), crypto.createHash('sha256').update(label).digest()
]));
