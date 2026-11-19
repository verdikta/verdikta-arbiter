'use strict';

// Node A19, the stake's documents in the context pack (owner decision Q61 (a); @verdikta/common 1.9.0-attest.4,
// docs/CODE_REVIEW_SPECIFICATION.md, "Stake documents"): common picks the files (selectDocuments) and decides what
// counts as text (isDocumentText), and its constants give the tier's place (CONTEXT_PACK_TIERS) and its bytes
// (STAKE_DOCUMENT_LIMITS). The runner reads each file from the listed commit's objects, puts the tier right after the
// in-scope source, and accounts for every file it leaves out. A listing without documents is pack.test.js's
// BEFORE_DOCUMENTS: byte for byte what it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeReview } = require('@verdikta/common');
const {
  assemblePack, TIER_NAMES, FACT_REASONS, LOSS_REASONS, MANIFEST_RESERVE_BYTES, DOCUMENTS_MANIFEST_RESERVE_BYTES, FILE_OVERHEAD_BYTES
} = require('../../src/pack');
const { claimSandbox } = require('../helpers/fakeClaim');
const { GitStore } = require('../helpers/gitStore');
const { claimRequest, finding, runClaim, forgeSpec } = require('../helpers/claimRun');

const { STAKE_DOCUMENT_LIMITS, CONTEXT_PACK_TIERS } = codeReview;
const STANDARD = STAKE_DOCUMENT_LIMITS.tierBytes['code-standard'];
const PREMIUM = STAKE_DOCUMENT_LIMITS.tierBytes['code-premium'];
const DOCS = ['README.md', 'docs/**'];
const LABEL = 'the maker\'s document at the listed commit (stake.documents): ';

const listOf = (items, omitted = {}) => ({ asked: items.length + Object.values(omitted).reduce((n, c) => n + c, 0), items, omitted });
const doc = (p, n, ch = 'd') => ({ path: p, text: ch.repeat(n), bytes: n, cut: false });
const docs = (count, n, prefix = 'docs/f') => Array.from({ length: count }, (_, i) => doc(`${prefix}${String(i).padStart(2, '0')}.md`, n));

function inputs(over = {}) {
  const wrap = { ...over };
  for (const key of ['pocFiles', 'sources', 'documents']) if (Array.isArray(wrap[key])) wrap[key] = listOf(wrap[key]);
  return {
    pocDiff: 'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol\n+contract ExploitTest {}\n',
    pocFiles: listOf([{ path: 'test/Exploit.t.sol', text: 'contract ExploitTest {}\n', bytes: 24, cut: false }]),
    sources: listOf([{ path: 'src/Vault.sol', text: 'contract Vault {}\n', bytes: 18, cut: false }]),
    callSites: { ...listOf([{ symbol: 'deposit', path: 'src/Vault.sol', line: 5, text: 'function deposit() external {}', cut: false }]), symbols: { found: 1, withSites: 1, noSites: 0, overCap: 0, longLines: 0 } },
    tree: 'src/ (1 file)\ntest/ (2 files)\n',
    documents: listOf([]),
    ...wrap
  };
}

function knownIssue(i, size) {
  const entry = { title: `Known issue ${i}`, class: 'LOW', paths: ['src/Vault.sol'], description: `${'accepted '.repeat(Math.ceil(size / 9)).slice(0, size)} ${i}` };
  return { id: codeReview.knownIssueId(entry), ...entry };
}

function prior(i) {
  return { bcid: `Qm${String(i + 1).repeat(44).slice(0, 44)}`, finding: finding({ title: `Prior ${i}`, rootCause: `${i} ${'r'.repeat(4000)}` }), report: '# prior\n' };
}

/** A claim on a listing that names `documents` (undefined: the field left out). */
function request(documents = DOCS, over = {}) {
  const stake = { scope: { include: ['src/**'] }, ...(documents === undefined ? {} : { documents }) };
  return claimRequest({ spec: forgeSpec({ stake }), knownIssues: [knownIssue(1, 200)], priorFindings: [prior(1)], ...over });
}

/** Everything a hunter can pad, padded, and the maker's lists at their largest. */
function padded(documents = DOCS) {
  return request(documents, {
    report: 'r'.repeat(400000),
    fixPatch: Buffer.alloc(300000, 'f'),
    knownIssues: Array.from({ length: 256 }, (_, i) => knownIssue(i, 1900)),
    priorFindings: Array.from({ length: 8 }, (_, i) => prior(i))
  });
}

function paddedInputs(over = {}) {
  const big = (p, n) => ({ path: p, text: 'line of code\n'.repeat(Math.ceil(n / 13)), bytes: n, cut: false });
  return inputs({
    pocDiff: 'd'.repeat(600000),
    pocFiles: [big('test/A.t.sol', 300000)],
    sources: Array.from({ length: 40 }, (_, i) => big(`src/F${i}.sol`, 100000)),
    callSites: {
      ...listOf(Array.from({ length: 160 }, (_, l) => ({ symbol: `s${l % 16}`, path: 'src/Vault.sol', line: l + 1, text: `call();`.padEnd(300, ' '), cut: false }))),
      symbols: { found: 16, withSites: 16, noSites: 0, overCap: 0, longLines: 0 }
    },
    tree: 'dir/\n'.repeat(200000),
    ...over
  });
}

const tierOf = (pack, name) => pack.tiers.find((t) => t.name === name);
const filesOf = (pack, name) => pack.files.filter((f) => f.tier === name);
const shareOf = (budgetBytes, percent) => Math.floor((budgetBytes * percent) / 100);

function assertSums(pack) {
  const manifest = JSON.parse(pack.files[0].text);
  assert.deepEqual(manifest.tiers, pack.tiers);
  for (const t of pack.tiers) {
    const sum = Object.values(t.omitted).reduce((n, c) => n + c, 0);
    assert.equal(t.asked, t.delivered + sum, `${t.name}: asked ${t.asked}, delivered ${t.delivered}, omitted ${JSON.stringify(t.omitted)}`);
    for (const reason of Object.keys(t.omitted)) assert.ok([...FACT_REASONS, ...LOSS_REASONS].includes(reason), reason);
    const lost = LOSS_REASONS.reduce((n, r) => n + (t.omitted[r] || 0), 0) + t.cut + (t.symbols ? t.symbols.overCap + t.symbols.longLines : 0);
    if (t.status === 'full') assert.equal(lost, 0, t.name);
    if (lost > 0) assert.ok(['truncated', 'dropped'].includes(t.status), `${t.name} is ${t.status}`);
  }
}

// ------------------------------------------------------------------ the tier's place and its files

test('the tiers are common\'s CONTEXT_PACK_TIERS: documents right after the source and before the call sites, rank 4, the tiers below one down', () => {
  assert.deepEqual(TIER_NAMES, [...CONTEXT_PACK_TIERS]);
  assert.deepEqual(TIER_NAMES.slice(2, 5), ['source', 'documents', 'callSites']);
  const pack = assemblePack({ request: request(DOCS, { fixPatch: Buffer.from('diff\n') }), inputs: inputs({ documents: [doc('README.md', 40)] }) });
  assert.deepEqual(pack.tiers.map((t) => t.name), [...CONTEXT_PACK_TIERS]);
  assert.deepEqual(pack.tiers.map((t) => t.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const names = pack.files.map((f) => f.name);
  assert.ok(names.indexOf('03-source-001.txt') < names.indexOf('04-document-001.txt'));
  assert.ok(names.indexOf('04-document-001.txt') < names.indexOf('05-call-sites.txt'));
  assert.deepEqual(names.slice(-4), ['06-known-issues.txt', '07-prior-findings.txt', '08-fix-diff.patch', '09-tree.txt']);
  assertSums(pack);
});

test('each document is one file, labelled as the maker\'s document at the listed commit, in the order the gathering read them', () => {
  const pack = assemblePack({ request: request(), inputs: inputs({ documents: [doc('README.md', 30, 'R'), doc('docs/spec.md', 30, 'S')] }) });
  const files = filesOf(pack, 'documents');
  assert.deepEqual(files.map((f) => f.name), ['04-document-001.txt', '04-document-002.txt']);
  assert.equal(files[0].text, `# ${LABEL}README.md\n${'R'.repeat(30)}`);
  assert.equal(files[1].text, `# ${LABEL}docs/spec.md\n${'S'.repeat(30)}`);
  const tier = tierOf(pack, 'documents');
  assert.deepEqual([tier.rank, tier.status, tier.asked, tier.delivered, tier.omitted, tier.cut], [4, 'full', 2, 2, {}, 0]);
});

test('a listing that names documents and matches none has the tier, empty; the tiers below keep their bytes', () => {
  const none = assemblePack({ request: request(DOCS), inputs: inputs() });
  const tier = tierOf(none, 'documents');
  assert.deepEqual([tier.rank, tier.status, tier.asked, tier.delivered, tier.bytes, tier.bytesIncluded], [4, 'empty', 0, 0, 0, 0]);
  const without = assemblePack({ request: request(undefined), inputs: inputs() });
  for (const name of ['callSites', 'knownIssues', 'priorFindings', 'tree']) {
    assert.deepEqual(filesOf(none, name).map((f) => f.text), filesOf(without, name).map((f) => f.text), name);
  }
});

test('a pack for a listing that names documents needs the gathering\'s account of them: none is a runner bug, never an empty tier', () => {
  assert.throws(() => assemblePack({ request: request(DOCS), inputs: { ...inputs(), documents: undefined } }), /documents/);
});

// ------------------------------------------------------------------ the tier's bytes

test('the reserved share: a hunter who pads poc.patch, report.md and the files the finding names cannot push the first reserved bytes out', () => {
  const budgetBytes = 60000 * 4;
  const pack = assemblePack({ request: padded(), inputs: paddedInputs({ documents: docs(30, 2000) }) });
  const tier = tierOf(pack, 'documents');
  assert.ok(tier.bytesIncluded <= STANDARD.reserved && tier.bytesIncluded > STANDARD.reserved - 2 * FILE_OVERHEAD_BYTES, `${tier.bytesIncluded} of ${STANDARD.reserved}`);
  assert.equal(tier.status, 'truncated');
  // documents take nothing of the shares above them
  assert.ok(tierOf(pack, 'poc').bytesIncluded >= shareOf(budgetBytes, 30) - 1000);
  assert.ok(tierOf(pack, 'claim').bytesIncluded >= shareOf(budgetBytes, 10) - 1000);
  assert.ok(tierOf(pack, 'source').bytesIncluded >= shareOf(budgetBytes, 24) - 1000);
  assert.ok(pack.usedTokens <= 60000);
  assertSums(pack);
});

test('past the reserved share documents take only room the tiers above leave, never more than max', () => {
  const pack = assemblePack({ request: request(), inputs: inputs({ documents: docs(100, 2000) }) });
  const tier = tierOf(pack, 'documents');
  assert.ok(tier.bytesIncluded > STANDARD.reserved, 'room left over goes back up to them');
  assert.ok(tier.bytesIncluded <= STANDARD.max, `${tier.bytesIncluded} of ${STANDARD.max}`);
  assert.ok(tier.bytesIncluded > STANDARD.max - 2 * FILE_OVERHEAD_BYTES - 2200, 'up to max');
  assert.equal(tier.delivered + tier.omitted.overBudget, 100);
  assert.equal(tier.bytes, filesOf(pack, 'documents').length ? 100 * (2000 + Buffer.byteLength(`# ${LABEL}docs/f00.md\n`) + FILE_OVERHEAD_BYTES) : 0, 'what it asked, in bytes');
  assertSums(pack);
});

test('files are taken whole while they fit; the first that does not is cut on a whole character and marked; the rest are left out', () => {
  const pack = assemblePack({ request: padded(), inputs: paddedInputs({ documents: [doc('README.md', 10000, 'é'), doc('docs/a.md', 20000, 'a'), doc('docs/b.md', 300)] }) });
  const tier = tierOf(pack, 'documents');
  const files = filesOf(pack, 'documents');
  assert.equal(files.length, 2);
  assert.ok(files[0].text.endsWith('é'.repeat(10)), 'whole');
  assert.match(files[1].text, /\n\[cut by the runner: the first [0-9]+ of [0-9]+ bytes\]$/);
  assert.ok(!files[1].text.includes('�'));
  assert.deepEqual([tier.delivered, tier.cut, tier.omitted], [2, 1, { overBudget: 1 }]);
  assert.equal(tier.status, 'truncated');
});

test('every tier full: the tiers below give up the documents\' share, prior findings first, then known issues, then call sites; the fix and the tree get what is left', () => {
  const budgetBytes = 60000 * 4;
  const docsIn = paddedInputs({ documents: docs(30, 2000) });
  const withDocs = assemblePack({ request: padded(), inputs: docsIn });
  const without = assemblePack({ request: padded(undefined), inputs: paddedInputs() });
  const delta = (name) => tierOf(without, name).bytesIncluded - tierOf(withDocs, name).bytesIncluded;
  // The tiers above keep their own shares (the room left over, which went back up to them, is what the documents' share took).
  for (const [name, share] of [['poc', 30], ['claim', 10], ['source', 24]]) assert.ok(tierOf(withDocs, name).bytesIncluded >= shareOf(budgetBytes, share) - 1000, name);
  for (const name of ['callSites', 'knownIssues']) assert.equal(delta(name), 0, name);
  assert.ok(delta('priorFindings') > 0, 'the lowest tier with a share gives first');
  for (const name of ['fix', 'tree']) assert.equal(tierOf(withDocs, name).bytesIncluded, 0, `${name}: no share, nothing left`);

  // A smaller budget, where the prior findings' share cannot cover the documents' reserve: the known issues give next.
  const small = assemblePack({ request: padded(), inputs: docsIn, budgetTokens: 30000 });
  const smallWithout = assemblePack({ request: padded(undefined), inputs: paddedInputs(), budgetTokens: 30000 });
  assert.equal(tierOf(small, 'priorFindings').bytesIncluded, 0);
  assert.ok(tierOf(small, 'knownIssues').bytesIncluded < tierOf(smallWithout, 'knownIssues').bytesIncluded);
  assert.equal(tierOf(small, 'callSites').bytesIncluded, tierOf(smallWithout, 'callSites').bytesIncluded);
  assert.ok(tierOf(small, 'documents').bytesIncluded > STANDARD.reserved - 2 * FILE_OVERHEAD_BYTES);
  assertSums(withDocs);
  assertSums(small);
});

test('the class\'s bytes: code-premium reserves and caps the premium tierBytes', () => {
  const padded96 = assemblePack({ request: padded(), inputs: paddedInputs({ documents: docs(60, 2000) }), codeClass: 'code-premium' });
  const tier = tierOf(padded96, 'documents');
  assert.ok(tier.bytesIncluded <= PREMIUM.reserved && tier.bytesIncluded > PREMIUM.reserved - 2 * FILE_OVERHEAD_BYTES, `${tier.bytesIncluded}`);
  const roomy = assemblePack({ request: request(), inputs: inputs({ documents: docs(100, 2000) }), codeClass: 'code-premium' });
  assert.ok(tierOf(roomy, 'documents').bytesIncluded <= PREMIUM.max && tierOf(roomy, 'documents').bytesIncluded > PREMIUM.reserved);
  assert.equal(PREMIUM.reserved, (codeReview.getCodeClass('code-premium').envelope.contextPackTokens * 4) / 10, 'common\'s reserve is 10% of the class budget');
  assert.equal(STANDARD.max, (codeReview.getCodeClass('code-standard').envelope.contextPackTokens * 4) / 5, 'and its max 20%');
});

// ------------------------------------------------------------------ the account

test('every file left out is counted with its reason; a cap or a size bound makes the tier truncated, a fact leaves it full', () => {
  const tierWith = (omitted, items = [doc('README.md', 10)]) => tierOf(assemblePack({ request: request(), inputs: inputs({ documents: listOf(items, omitted) }) }), 'documents');
  for (const fact of ['inSource', 'symlink', 'submodule', 'notText', 'notAskable']) {
    assert.ok(FACT_REASONS.includes(fact), fact);
    assert.equal(tierWith({ [fact]: 2 }).status, 'full', fact);
    assert.equal(tierWith({ [fact]: 2 }, []).status, 'empty', fact);
  }
  for (const loss of ['pastCap', 'tooLarge']) {
    assert.ok(LOSS_REASONS.includes(loss), loss);
    assert.equal(tierWith({ [loss]: 1 }).status, 'truncated', loss);
    assert.equal(tierWith({ [loss]: 1 }, []).status, 'dropped', loss);
  }
  const all = tierWith({ inSource: 1, pastCap: 3, symlink: 1, submodule: 1, tooLarge: 1, notText: 2 });
  assert.deepEqual([all.asked, all.delivered], [10, 1]);
});

test('the manifest stays inside its reserve at the largest case with documents: every reason on every tier, in the largest counts', () => {
  const omitted = Object.fromEntries([...FACT_REASONS, ...LOSS_REASONS].map((r) => [r, 1000000000]));
  const big = (items) => ({ asked: items.length + Object.values(omitted).reduce((n, c) => n + c, 0), items, omitted });
  const file = { path: 'src/V.sol', text: 'contract V {}\n', bytes: 14, cut: false };
  const pack = assemblePack({
    request: padded(),
    codeClass: 'code-premium',
    inputs: inputs({
      pocFiles: big([file]), sources: big([file]), documents: big([doc('README.md', 10)]),
      callSites: { ...big([{ symbol: 'f', path: 'src/V.sol', line: 1, text: 'f();', cut: false }]), symbols: { found: 3000000000, withSites: 1000000000, noSites: 1000000000, overCap: 1000000000, longLines: 1000000000 } }
    })
  });
  const room = MANIFEST_RESERVE_BYTES + DOCUMENTS_MANIFEST_RESERVE_BYTES;
  assert.ok(Buffer.byteLength(pack.files[0].text) <= room, `${Buffer.byteLength(pack.files[0].text)} of ${room} bytes`);
  assert.ok(pack.usedTokens <= 120000);
});

// ------------------------------------------------------------------ the gathering, through a claim

const DEP_FILES = { 'src/Test.sol': '// forge-std\n', 'README.md': '# forge-std\n', 'docs/inner.md': 'SUBMODULE-DOC\n' };

/**
 * The fake env image (fakeClaim.js) with the listed commit's files `extra` added (a function of the store, for a
 * submodule of its own), beside the default lib/forge-std submodule, whose README.md and docs are not the listed commit's.
 */
function image(extra = {}) {
  const store = new GitStore('sha1');
  const dep = store.repo(DEP_FILES, 'forge-std');
  const files = {
    '.gitmodules': '[submodule "lib/forge-std"]\n\tpath = lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
    'foundry.toml': '[profile.default]\n',
    'lib/forge-std': { gitlink: dep },
    'src/Vault.sol': 'contract Vault {}\n',
    'test/Vault.t.sol': 'contract VaultTest {}\n',
    ...(typeof extra === 'function' ? extra(store) : extra)
  };
  return { store, base: store.repo(files, 'base'), dep, files };
}

function claimOn(img, documents, over = {}) {
  const base = claimRequest();
  const spec = forgeSpec({ stake: { scope: { include: ['src/**'] }, documents } });
  spec.baseCommit = img.base;
  return { ...base, spec, baseline: { ...base.baseline, baseCommit: img.base }, ...over };
}

/** The `<commit>:<path>` lines of each `git cat-file --batch` the claim's sandbox ran, in order. */
const batchesOf = (sb) => sb.pocExecs()
  .filter((d) => d.kind === 'git' && d.sub[0] === 'cat-file' && d.sub.includes('--batch') && d.stdin)
  .map((d) => Buffer.from(d.stdin).toString('utf8').split('\n').filter(Boolean))
  .filter((lines) => lines.some((l) => l.includes(':')));
/** The documents read: the one batch that asks for a path under docs/ or README.md. */
const documentsRead = (sb) => batchesOf(sb).filter((lines) => lines.some((l) => /:(?:README\.md|docs\/)/.test(l)));
const stepNames = (r) => r.steps.map((s) => s.name);

test('the gathering: common\'s selection from the listed commit\'s own files, in the listing\'s order, read by commit id before any maker command', async () => {
  const img = image((store) => ({
    'README.md': '# Vault\nwithdraw must never revert for a solvent vault.\n',
    'docs/b.md': 'B\n',
    'docs/a.md': 'A\n',
    'docs/run.sh': { exec: '#!/bin/sh\necho run\n' },
    'docs/link.md': { link: '../README.md' },
    // A submodule of its own: its files are not the listed commit's.
    'docs/sub': { gitlink: store.repo({ 'inner.md': 'SUBMODULE-DOC\n' }, 'docs-sub') },
    'src/Other.sol': 'contract Other {}\n'
  }));
  const sb = claimSandbox({ image: img });
  const req = claimOn(img, ['README.md', 'docs/**', 'src/**'], { finding: finding({ affectedPaths: ['src/Vault.sol'] }) });
  const r = await runClaim(sb, req);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  const pack = r.contextPack;
  const tier = tierOf(pack, 'documents');

  // What common selects from the listed commit's own paths, as git ls-tree -r lists them (a submodule is one entry).
  const own = ['.gitmodules', 'README.md', 'docs/a.md', 'docs/b.md', 'docs/link.md', 'docs/run.sh', 'docs/sub', 'foundry.toml', 'lib/forge-std', 'src/Other.sol', 'src/Vault.sol', 'test/Vault.t.sol'];
  const selection = codeReview.selectDocuments(own, req.spec.stake, req.finding.affectedPaths);
  assert.deepEqual(selection, { paths: ['README.md', 'docs/a.md', 'docs/b.md', 'docs/link.md', 'docs/run.sh', 'docs/sub', 'src/Other.sol'], inSource: ['src/Vault.sol'], pastCap: [] });

  const shown = filesOf(pack, 'documents').map((f) => f.text.split('\n')[0]);
  assert.deepEqual(shown, ['README.md', 'docs/a.md', 'docs/b.md', 'docs/run.sh', 'src/Other.sol'].map((p) => `# ${LABEL}${p}`));
  assert.deepEqual([tier.asked, tier.delivered, tier.omitted, tier.status], [8, 5, { inSource: 1, symlink: 1, submodule: 1 }, 'full']);
  assert.ok(filesOf(pack, 'documents')[0].text.includes('withdraw must never revert'));
  assert.ok(!JSON.stringify(pack).includes('SUBMODULE-DOC'), 'no file of a submodule');
  assert.ok(!JSON.stringify(pack).includes('# forge-std'), 'nor of lib/forge-std');
  assert.equal(filesOf(pack, 'source').length, 1, 'src/Vault.sol once, in the source tier');

  // Read from git's objects by commit id, only what counts, before the build.
  const reads = documentsRead(sb);
  assert.equal(reads.length, 1, 'one read');
  assert.deepEqual(reads[0].map((l) => l.slice(l.indexOf(':') + 1)), ['README.md', 'docs/a.md', 'docs/b.md', 'docs/run.sh', 'src/Other.sol']);
  assert.ok(reads[0].every((l) => /^[0-9a-f]{40}:/.test(l)), 'by commit id');
  const steps = stepNames(r);
  assert.ok(steps.indexOf('pack:source') >= 0 && steps.indexOf('pack:source') < steps.indexOf('pack:documents'), steps.join(' '));
  assert.ok(steps.indexOf('pack:documents') < steps.indexOf('pack:grep:1') || !steps.includes('pack:grep:1'), 'before the call sites');
  assert.ok(steps.indexOf('pack:documents') < steps.indexOf('build'), 'before any maker command');
  assertSums(pack);
});

test('which files count: a file over maxFileBytes is left unread, a file that is not UTF-8 text is skipped, each counted with its reason', async () => {
  const max = STAKE_DOCUMENT_LIMITS.maxFileBytes;
  const img = image({
    'docs/big.md': 'b'.repeat(max + 1),
    'docs/exact.md': 'e'.repeat(max),
    'docs/nul.md': 'text\0more\n',
    'docs/latin1.md': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    'docs/bom.md': Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a])
  });
  const sb = claimSandbox({ image: img });
  const r = await runClaim(sb, claimOn(img, ['docs/**']));
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  const tier = tierOf(r.contextPack, 'documents');
  assert.deepEqual([tier.asked, tier.omitted.tooLarge, tier.omitted.notText], [5, 1, 2]);
  assert.equal(tier.delivered + (tier.omitted.overBudget || 0), 2, 'bom.md and exact.md');
  assert.equal(tier.status, 'truncated', 'a size bound left one out');
  const [read] = documentsRead(sb);
  assert.ok(!read.some((l) => l.endsWith(':docs/big.md')), 'left unread');
  assert.ok(read.some((l) => l.endsWith(':docs/exact.md')), 'a file of exactly maxFileBytes counts');
  assert.ok(isText(Buffer.from([0xef, 0xbb, 0xbf, 0x68])), 'common counts a byte-order mark as text');
  assertSums(r.contextPack);
});

const isText = (b) => codeReview.isDocumentText(b);

test('past maxFiles the rest are pastCap: left out, and the pack says how many', async () => {
  const extra = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`docs/f${String(i).padStart(2, '0')}.md`, `doc ${i}\n`]));
  const img = image(extra);
  const sb = claimSandbox({ image: img });
  const r = await runClaim(sb, claimOn(img, ['docs/**']));
  const tier = tierOf(r.contextPack, 'documents');
  assert.deepEqual([tier.asked, tier.delivered, tier.omitted, tier.status], [40, 32, { pastCap: 8 }, 'truncated']);
  const [read] = documentsRead(sb);
  assert.equal(read.length, STAKE_DOCUMENT_LIMITS.maxFiles);
  assert.ok(read.at(-1).endsWith(':docs/f31.md'), 'the first 32 in byte order');
});

test('a path that is not UTF-8 has no spelling a glob names: it is no candidate, and the selection is common\'s over the rest', async () => {
  const img = image({ 'docs/caf\xe9.md': 'latin-1 name\n', 'docs/ok.md': 'OK-DOC\n' });
  const sb = claimSandbox({ image: img });
  const r = await runClaim(sb, claimOn(img, ['docs/**']));
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  const tier = tierOf(r.contextPack, 'documents');
  assert.deepEqual([tier.asked, tier.delivered, tier.omitted], [1, 1, {}]);
  assert.ok(filesOf(r.contextPack, 'documents')[0].text.includes('OK-DOC'));
});

// ------------------------------------------------------------------ a documents error is the requester's

test('DOCUMENTS_MATCH_TOO_COSTLY is the requester\'s broken package: requester_error before any maker command, so the claim abstains and never commits', async () => {
  const seg = 'a'.repeat(200);
  const deep = Array(14).fill(seg).join('/');
  const extra = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${deep}/a${i}b`, 'x\n']));
  const img = image(extra);
  const costly = `a${'**a'.repeat(150)}**b`;
  assert.equal(codeReview.documentGlobProblem(costly), null, 'a document glob, which the spec validates');
  const sb = claimSandbox({ image: img });
  const r = await runClaim(sb, claimOn(img, ['README.md', costly]));
  assert.equal(r.outcome, 'requester_error', JSON.stringify(r.abstain));
  assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['DOCUMENTS_MATCH_TOO_COSTLY', '/spec/stake/documents']]);
  assert.match(r.issues[0].detail, /narrower globs/);
  const kinds = sb.pocExecs().map((d) => d.kind);
  assert.ok(!kinds.includes('vcr-build') && !kinds.includes('vcr-poc'), 'no maker command ran');
  assert.ok(!r.contextPack, 'no pack');
});

test('R1-F1: with a fix check beside it, neither sandbox runs a maker command on such a listing, however far ahead the fix check runs', async () => {
  const { FIX_PATCH } = require('../helpers/fakeClaim');
  const seg = 'a'.repeat(200);
  const deep = Array(14).fill(seg).join('/');
  const img = image(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${deep}/a${i}b`, 'x\n'])));
  // The PoC's sandbox is slow to prepare, so the fix check's sandbox gets ahead of it.
  const slow = async (d, b) => { if (b.n === 1) await new Promise((resolve) => setTimeout(resolve, 400)); return { exitCode: 0 }; };
  const sb = claimSandbox({ image: img, git: { 'read-tree': slow } });
  const r = await runClaim(sb, claimOn(img, [`a${'**a'.repeat(150)}**b`], { fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'requester_error', JSON.stringify(r.abstain));
  assert.deepEqual(r.issues.map((i) => i.code), ['DOCUMENTS_MATCH_TOO_COSTLY']);
  const all = sb.execs();
  assert.ok(all.some((d) => d.box === 2), 'the fix check\'s sandbox ran');
  for (const kind of ['vcr-build', 'vcr-poc', 'vcr-suite']) assert.ok(!all.some((d) => d.kind === kind), `no ${kind} in either sandbox`);
  assert.ok(!all.some((d) => d.kind === 'git' && d.sub[0] === 'apply'), 'no patch was applied in either sandbox');
});

test('R1-F1: the documents are chosen at the preparation, before the patch, so a claim whose patch does not apply abstains on such a listing too', async () => {
  const seg = 'a'.repeat(200);
  const deep = Array(14).fill(seg).join('/');
  const img = image(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${deep}/a${i}b`, 'x\n'])));
  const sb = claimSandbox({ image: img, git: { 'apply --index': () => ({ exitCode: 1, stderr: 'error: patch failed\n' }) } });
  const r = await runClaim(sb, claimOn(img, [`a${'**a'.repeat(150)}**b`]));
  assert.equal(r.outcome, 'requester_error');
  assert.ok(!sb.execs().some((d) => d.kind === 'git' && d.sub[0] === 'apply'), 'the patch was never applied');
});

test('any other error from common\'s selection is the requester\'s too: requester_error, never a pack without the tier', async () => {
  const common = require('../../src/common');
  const real = common.selectDocuments;
  common.selectDocuments = () => { throw new TypeError('something common could not read'); };
  try {
    const img = image({ 'README.md': 'r\n' });
    const sb = claimSandbox({ image: img });
    const r = await runClaim(sb, claimOn(img, ['README.md']));
    assert.equal(r.outcome, 'requester_error', JSON.stringify(r.abstain));
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['STAKE_DOCUMENTS_INVALID', '/spec/stake/documents']]);
    assert.ok(!sb.pocExecs().some((d) => d.kind === 'vcr-build'));
  } finally {
    common.selectDocuments = real;
  }
});
