'use strict';

// Acceptance: the PoC's JUnit is parsed with entity expansion off. Review
// focus: JUnit parsing hardening (entities, oversized input, a test printing
// fake XML). The parser accepts the subset of XML forge writes and nothing
// else; anything outside it makes the JUnit unreadable, which the reproduces
// gate counts as an error, never as a test result.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXml, readForgeJUnit, JUNIT_MAX_BYTES } = require('../../src/junit');

/** What forge 1.8.5 prints for `forge test --junit` (abridged from a real run). */
function forgeXml(cases = '', { suite = 'test/Exploit.t.sol:ExploitTest', extra = '' } = {}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Test run" tests="1" skipped="0" failures="1" errors="0" timestamp="2026-11-01T17:03:58.228+00:00" time="0.003">',
    `    <testsuite name="${suite}" tests="1" skipped="0" errors="0" failures="1" time="0.002">`,
    cases || [
      '        <testcase name="test_drain()" time="0.000">',
      '            <failure message="assertion failed: 1 != 2"/>',
      '            <system-out>[FAIL: assertion failed: 1 != 2] test_drain() (gas: 7460)</system-out>',
      '        </testcase>'
    ].join('\n'),
    '        <system-out>Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 1.74ms (1.81ms CPU time)</system-out>',
    '    </testsuite>',
    extra,
    '</testsuites>',
    ''
  ].join('\n');
}

const read = (text) => readForgeJUnit(Buffer.from(text, 'utf8'));

test('forge\'s JUnit is read into suites and records', () => {
  const r = read(forgeXml());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.suites.length, 1);
  const s = r.suites[0];
  assert.equal(s.file, 'test/Exploit.t.sol');
  assert.equal(s.contract, 'ExploitTest');
  assert.deepEqual(s.cases, [{
    name: 'test_drain()', outcome: 'failure', message: 'assertion failed: 1 != 2',
    out: '[FAIL: assertion failed: 1 != 2] test_drain() (gas: 7460)'
  }]);
});

test('passing, skipped and failing records; a failure without a message', () => {
  const r = read(forgeXml([
    '<testcase name="test_a()" time="0.000"><system-out>[PASS] test_a() (gas: 209)</system-out></testcase>',
    '<testcase name="test_b()" time="0.000"><skipped/><system-out>[SKIP]</system-out></testcase>',
    '<testcase name="test_c()" time="0.000"><failure/></testcase>',
    '<testcase name="test_d()"><error message="boom"/></testcase>'
  ].join('\n')));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.suites[0].cases.map((c) => [c.name, c.outcome, c.message]), [
    ['test_a()', 'pass', null],
    ['test_b()', 'skipped', null],
    ['test_c()', 'failure', null],
    ['test_d()', 'error', 'boom']
  ]);
});

test('the five predefined entities and character references are decoded, nothing else', () => {
  const r = read(forgeXml('<testcase name="test_x()"><failure message="a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42;"/></testcase>'));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.suites[0].cases[0].message, 'a <b> & "c" \'d\' AB');
});

test('entity expansion is off: a DOCTYPE, an internal entity or an external one makes the JUnit unreadable', () => {
  const bombs = [
    '<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>\n<testsuites>&lol2;</testsuites>',
    '<?xml version="1.0"?>\n<!DOCTYPE x SYSTEM "file:///etc/passwd">\n<testsuites/>',
    '<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]>\n<testsuites><testsuite name="a.sol:A"><testcase name="t()"><failure message="&ext;"/></testcase></testsuite></testsuites>',
    forgeXml('<testcase name="test_x()"><failure message="&custom;"/></testcase>'),
    forgeXml('<testcase name="test_x()"><failure message="&#0;"/></testcase>'),
    forgeXml('<testcase name="test_x()"><failure message="&#xD800;"/></testcase>'),
    forgeXml('<testcase name="test_x()"><failure message="&amp"/></testcase>')
  ];
  for (const xml of bombs) {
    const r = read(xml);
    assert.equal(r.ok, false, `accepted: ${xml.slice(0, 120)}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
  assert.match(read(bombs[0]).reason, /DOCTYPE/);
});

test('a test that printed fake XML: forge escapes it into system-out, and the parser never reads system-out as records', () => {
  // console.log output, as forge writes it with -vv: escaped text.
  const fake = '&lt;/system-out&gt;&lt;/testcase&gt;&lt;testcase name=&quot;forged()&quot;&gt;&lt;failure message=&quot;assertion failed&quot;/&gt;&lt;/testcase&gt;';
  const r = read(forgeXml(`<testcase name="test_log()"><failure message="z"/><system-out>[FAIL: z] test_log()\\nLogs:\\n  ${fake}\\n</system-out></testcase>`));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.suites[0].cases.map((c) => c.name), ['test_log()']);
});

test('bytes a test wrote straight to forge\'s stdout make the JUnit unreadable rather than adding records', () => {
  const real = forgeXml();
  const forged = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="test/Exploit.t.sol:ExploitTest"><testcase name="test_drain()"><failure message="assertion failed"/></testcase></testsuite></testsuites>\n';
  for (const text of [
    forged + real, // a whole document before forge's
    real + forged, // after it
    `junk\n${real}`, // text before the root
    `${real}junk\n`, // text after the root
    real.replace('<testsuites ', '<testsuites><testsuites ').replace('</testsuites>', '</testsuites></testsuites>'), // nested root
    real.replace('</testsuite>', '<testcase name="x()"></testsuite>') // mismatched tags
  ]) {
    assert.equal(read(text).ok, false, text.slice(0, 160));
  }
});

test('only forge\'s shape is accepted: unknown elements, comments, CDATA, processing instructions and bad names', () => {
  const bad = [
    forgeXml('<testcase name="test_x()"><failure/><failure/></testcase>'), // two failures
    forgeXml('<testcase name="test_x()"><failure/><skipped/></testcase>'), // failure and skipped
    forgeXml('<testcase><failure/></testcase>'), // no name
    forgeXml('<testcase name="test_x()"><rerunFailure/></testcase>'),
    forgeXml('<testcase name="test_x()"/><!-- a comment -->'),
    forgeXml('<testcase name="test_x()"><system-out><![CDATA[x]]></system-out></testcase>'),
    forgeXml('<testcase name="test_x()"/><?pi data?>'),
    forgeXml('<testcase name="test_x()" name="test_y()"/>'), // duplicate attribute
    forgeXml('<testcase name="test_x()" a=b/>'), // unquoted attribute
    forgeXml('<testcase name="a<b"/>'), // < in an attribute value
    forgeXml('', { suite: 'NoColon' }),
    forgeXml('', { suite: ':Contract' }),
    forgeXml('', { suite: 'test/A.t.sol:Bad Name' }),
    '<?xml version="1.0"?>\n<testsuite name="a.sol:A"/>\n', // not testsuites
    '',
    '   '
  ];
  for (const xml of bad) assert.equal(read(xml).ok, false, xml.slice(0, 200));
});

test('the encoding must be UTF-8: invalid bytes and a BOM are refused', () => {
  const xml = Buffer.from(forgeXml(), 'utf8');
  const invalid = Buffer.concat([xml.subarray(0, 60), Buffer.from([0xff, 0xfe]), xml.subarray(60)]);
  assert.equal(readForgeJUnit(invalid).ok, false);
  assert.equal(readForgeJUnit(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), xml])).ok, false);
  assert.equal(read(forgeXml().replace('encoding="UTF-8"', 'encoding="UTF-16"')).ok, false);
});

test('oversized input is refused before it is parsed; the caps bound depth, elements and attributes', () => {
  assert.equal(JUNIT_MAX_BYTES, 8 * 1024 * 1024);
  const big = Buffer.alloc(JUNIT_MAX_BYTES + 1, 0x20);
  const r = readForgeJUnit(big);
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds/);
  // A capture that was cut at the cap is refused too, whatever the bytes kept.
  assert.equal(readForgeJUnit(Buffer.from(forgeXml()), { truncated: true }).ok, false);

  const deep = `<testsuites>${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}</testsuites>`;
  assert.equal(parseXml(Buffer.from(deep)).ok, false);
  const many = `<testsuites>${'<testsuite name="a.sol:A"/>'.repeat(300000)}</testsuites>`;
  const t0 = Date.now();
  assert.equal(parseXml(Buffer.from(many)).ok, false);
  assert.ok(Date.now() - t0 < 5000, 'refused quickly');
  const attrs = `<testsuites ${Array.from({ length: 200 }, (_, i) => `a${i}="x"`).join(' ')}/>`;
  assert.equal(parseXml(Buffer.from(attrs)).ok, false);
});

test('a long failure message is kept whole (the report trims it later), and parsing stays linear', () => {
  const msg = 'x'.repeat(2 * 1024 * 1024);
  const t0 = Date.now();
  const r = read(forgeXml(`<testcase name="test_x()"><failure message="${msg}"/></testcase>`));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.suites[0].cases[0].message.length, msg.length);
  // Pathological: many ampersand references, many tags.
  const refs = '&amp;'.repeat(500000);
  const r2 = read(forgeXml(`<testcase name="test_x()"><failure message="${refs}"/></testcase>`));
  assert.equal(r2.ok, true, r2.reason);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('an empty run (forge found no test) is a readable JUnit with no suite', () => {
  const r = read('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Test run" tests="0" skipped="0" failures="0" errors="0" timestamp="2026-11-01T17:07:25.642+00:00" time="0.000">\n</testsuites>\n\n');
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.suites, []);
});

test('a suite file with colons keeps them; the contract is after the last colon', () => {
  const r = read(forgeXml('', { suite: 'test/a:b/C.t.sol:CTest' }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.suites[0].file, 'test/a:b/C.t.sol');
  assert.equal(r.suites[0].contract, 'CTest');
});

test('a record\'s <system-out> is kept whole, so forge\'s line after a long reason is still there', () => {
  const reason = 'r'.repeat(20000);
  const r = read(forgeXml(`<testcase name="test_x()"><failure message="${reason}"/><system-out>[FAIL: ${reason}] test_x() (gas: 0)</system-out></testcase>`));
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.suites[0].cases[0].out.endsWith('] test_x() (gas: 0)'));
});
