// The tests beside arbiter-operator/scripts/lib (the registry walk and
// deregistration run, the in-flight guard) need no dependencies, and no CI job
// ran them: the installer job runs installer/tests/*.test.cjs, the operator
// job runs `hardhat test`, which reads arbiter-operator/test only. Requiring
// them here registers their tests in this run.
// Run: node --test installer/tests/operator-script-lib.test.cjs
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const LIB = path.resolve(__dirname, '../../arbiter-operator/scripts/lib');
const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.test.js')).sort();

test('the operator script lib has its tests', () => {
  assert.ok(files.includes('registry.test.js') && files.includes('inflight.test.js'), files.join(', '));
});

for (const f of files) require(path.join(LIB, f));
