'use strict';

/**
 * Test only, loaded with `node --require` into a script a test starts: that process's production
 * builder set holds the test's key, so the production path can run to its end with no production
 * signature. Nothing outside the tests names this file, and no script reads this variable: a script
 * has no switch that widens its trust. The set is common's own snapshot, taken when it loads.
 */
const file = require.resolve('@verdikta/common/src/codeReview/trustedBuilderKeys.js');
const { keyId, publicKey } = JSON.parse(process.env.E2E_TEST_PRODUCTION_KEY);
require.cache[file] = { id: file, filename: file, loaded: true, exports: [{ keyId, publicKey }] };
