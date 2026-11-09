'use strict';

// Node A15 (the owner's decision of 2026-11-09): the L4 fixture vault says what deposit must do, and
// the jurors read it. With no word on it, the jurors split on whether deposit must credit exactly
// `amount`, and some settled the time- and randomness-dependent claims INVALID on that alone. So
// src/Vault.sol carries a NatSpec line on deposit, and a claim whose finding names that file gets
// it in the pack's sources. Here: the fixture tree as prepare-l4-listings.js commits it, the claims
// as build-l4-claims.js makes them, and the pack by the runner's own gathering and assembly, with
// the runner's own git argv run on that repository.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const F = require('../../l2/claim/fixtures');

const CODE_RUNNER = path.join(__dirname, '..', '..', '..', '..', 'code-runner');
const repo = require(path.join(CODE_RUNNER, 'test', 'docker', 'forgeFixture'));
const { gatherPackInputs, assemblePack } = require(path.join(CODE_RUNNER, 'src', 'pack'));
const { GIT_DIR, WORK_TREE } = require(path.join(CODE_RUNNER, 'src', 'git'));
const { parseNameStatusZ, parseAddedLines } = require(path.join(CODE_RUNNER, 'src', 'patch'));
const { matchesAny } = require(path.join(CODE_RUNNER, 'src', 'common'));

jest.setTimeout(60000);

const PREPARE = path.join(__dirname, '..', '..', '..', 'scripts', 'prepare-l4-listings.js');
const IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'b'.repeat(64)}`;
/** The vault as the 43679c1 listings hold it: what the documented one must be, but for the one line. */
const VAULT_BEFORE = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'contract Vault {',
  '    mapping(address => uint256) public balanceOf;',
  '    function deposit(uint256 amount) external { balanceOf[msg.sender] += amount + 1; }',
  '}',
  ''
].join('\n');
const SUITE_BEFORE = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'import {Vault} from "../src/Vault.sol";',
  'import {Base} from "./Vm.sol";',
  'contract VaultTest is Base {',
  '    function test_deposit() public { Vault v = new Vault(); v.deposit(1); require(v.balanceOf(address(this)) > 0, "no credit"); }',
  '}',
  ''
].join('\n');

let dir;
let fixture;
let baseCommit;
let set;

/** git on the host, for setting the test up: no one's configuration, fixed identity. */
function hostGit(args, cwd, input) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@verdikta.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * A ctx whose exec runs the runner's git argv (`/usr/bin/env -i … git …`) on `work`: the runner's
 * repository paths become this one's, and nothing else of the argv changes.
 */
function localCtx(work) {
  const swap = { [`GIT_DIR=${GIT_DIR}`]: `GIT_DIR=${path.join(work, '.git')}`, [`GIT_WORK_TREE=${WORK_TREE}`]: `GIT_WORK_TREE=${work}` };
  return {
    exec(argv, { stdin, tee }) {
      if (argv[0] !== '/usr/bin/env' || !argv.includes(`GIT_DIR=${GIT_DIR}`)) throw new Error(`not the runner's git argv: ${argv.slice(0, 3).join(' ')}`);
      return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1).map((a) => swap[a] || a), { stdio: ['pipe', 'pipe', 'ignore'] });
        child.stdout.on('data', (chunk) => tee.write(chunk));
        child.on('error', reject);
        child.on('close', (exitCode) => resolve({ exitCode }));
        child.stdin.end(stdin || Buffer.alloc(0));
      });
    }
  };
}

const memberOf = (claim, name) => new AdmZip(claim.buffer).getEntry(name).getData();

/** The claim's PoC committed on the listed commit, in a clone of its own; what the runner reads of it. */
function pocCommitted(claim, name) {
  const work = path.join(dir, name);
  hostGit(['clone', '--quiet', fixture, work], dir);
  hostGit(['apply', '--index', '-'], work, memberOf(claim, 'poc.patch'));
  hostGit(['commit', '--quiet', '--no-verify', '-m', 'poc.patch'], work);
  const poc = hostGit(['rev-parse', 'HEAD'], work).trim();
  const touched = parseNameStatusZ(Buffer.from(hostGit(['diff', '--name-status', '-z', '--no-renames', baseCommit, poc, '--'], work)));
  const added = parseAddedLines(Buffer.from(hostGit(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', baseCommit, poc, '--'], work)));
  expect(added.ok).toBe(true);
  const tests = set.listing.spec.paths.tests;
  return { work, poc, touched, added: new Map([...added.files].filter(([file]) => matchesAny(file, tests))) };
}

/** The context pack the jurors read for one claim of the set, as the runner gathers and assembles it. */
async function packFor(key) {
  const claim = set.claims[key];
  const { work, poc, touched, added } = pocCommitted(claim, key);
  const request = {
    spec: set.listing.spec,
    finding: JSON.parse(memberOf(claim, 'finding.json').toString('utf8')),
    report: memberOf(claim, 'report.md').toString('utf8'),
    knownIssues: [],
    priorFindings: []
  };
  const inputs = await gatherPackInputs(localCtx(work), { request, listed: baseCommit, poc, touched, added });
  return { request, pack: assemblePack({ request, inputs }) };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fixture-vault-'));
  fixture = path.join(dir, 'fixture');
  baseCommit = execFileSync(process.execPath, [PREPARE, 'fixture-repo', '--out', fixture], { encoding: 'utf8' }).split('\n')[0];
  expect(baseCommit).toMatch(/^[0-9a-f]{40}$/);
  // Nothing here fetches by CID: each put needs only a name of its own.
  let n = 0;
  const put = async () => {
    n += 1;
    return `Qm${String(n).padStart(44, 'x')}`;
  };
  set = await F.makeClaimSet({ repo, put, image: IMAGE, baseCommit });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the L4 fixture vault documents deposit', () => {
  it('is a NatSpec line on deposit saying it credits the caller exactly amount', () => {
    expect(typeof repo.DEPOSIT_RULE).toBe('string');
    expect(repo.DEPOSIT_RULE).toMatch(/^\/\/\/ @notice Credits the caller with exactly `amount`/);
    expect(repo.DEPOSIT_RULE).not.toMatch(/\n/);
    // The fixtures' own edits find the bug by this text: the line must not hold it.
    expect(repo.DEPOSIT_RULE).not.toContain('amount + 1');
    const lines = repo.VAULT_REPO['src/Vault.sol'].split('\n');
    const at = lines.indexOf(`    ${repo.DEPOSIT_RULE}`);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^ {4}function deposit\(uint256 amount\) external /);
  });

  it('changes nothing but the documentation: the bug (amount + 1) and the passing suite are as before', () => {
    expect(repo.VAULT_REPO['src/Vault.sol'].replace(`    ${repo.DEPOSIT_RULE}\n`, '')).toBe(VAULT_BEFORE);
    expect(repo.VAULT_REPO['test/Vault.t.sol']).toBe(SUITE_BEFORE);
    expect(repo.vaultBaseline(baseCommit).stable).toEqual(['test/Vault.t.sol > VaultTest > test_deposit()']);
  });

  it('is in the tree prepare-l4-listings.js commits for the L4 listings, at the fixture commit', () => {
    expect(hostGit(['show', `${baseCommit}:src/Vault.sol`], fixture)).toBe(repo.VAULT_REPO['src/Vault.sol']);
  });
});

describe('the line reaches the jury pack\'s sources', () => {
  it.each([
    ['valid', 'claim-l4-valid'],
    ['timeDependent', 'claim-l4-time-dependent'],
    ['randomnessDependent', 'claim-l4-randomness-dependent']
  ])('for the %s claim (%s): its finding names src/Vault.sol, and the source tier carries it whole', async (key) => {
    const { request, pack } = await packFor(key);
    expect(request.finding.affectedPaths).toEqual(['src/Vault.sol']);
    const sources = pack.files.filter((f) => f.tier === 'source');
    expect(sources).toHaveLength(1);
    expect(sources[0].text.startsWith('# source file: src/Vault.sol\n')).toBe(true);
    expect(sources[0].text).toContain(`    ${repo.DEPOSIT_RULE}\n`);
    expect(sources[0].text).toContain('balanceOf[msg.sender] += amount + 1;');
    const tier = pack.tiers.find((t) => t.name === 'source');
    expect([tier.asked, tier.delivered, tier.status]).toEqual([1, 1, 'full']);
    // The PoC is what the claim adds under test/, and it is in the pack beside the source.
    expect(pack.files.some((f) => f.tier === 'poc' && f.text.includes('diff --git'))).toBe(true);
  });
});

describe('the editsSource claim', () => {
  it('still applies to the documented vault, and edits only the code', () => {
    const work = path.join(dir, 'edits-source');
    hostGit(['clone', '--quiet', fixture, work], dir);
    const patch = memberOf(set.claims.editsSource, 'poc.patch');
    hostGit(['apply', '--check', '-'], work, patch);
    hostGit(['apply', '-'], work, patch);
    const edited = fs.readFileSync(path.join(work, 'src', 'Vault.sol'), 'utf8');
    expect(edited).toBe(repo.VAULT_REPO['src/Vault.sol'].replace('amount + 1', 'amount + 2'));
    expect(edited).toContain(`    ${repo.DEPOSIT_RULE}\n`);
  });
});
