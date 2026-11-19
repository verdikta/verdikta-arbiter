// node --test installer/tests/service-auth.test.cjs
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { configure, renderJob } = require('../util/configure-service-auth.cjs');
let root, aiFile, eaFile;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdikta-auth-test-'));
  fs.mkdirSync(path.join(root, 'ai-node'));
  fs.mkdirSync(path.join(root, 'external-adapter'));
  aiFile = path.join(root, 'ai-node', '.env.local');
  eaFile = path.join(root, 'external-adapter', '.env');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const read = file => fs.readFileSync(file, 'utf8');
const key = (file, name) => read(file).split('\n').find(line => line.startsWith(name + '=')).split('=')[1];
test('generates independent secrets, synchronizes AI credentials and preserves other configuration', () => {
  fs.writeFileSync(aiFile, '# settings\nJUSTIFIER_MODEL=example:model\n');
  fs.writeFileSync(eaFile, 'PORT=8080\n');
  configure(root);
  assert.match(key(aiFile, 'AI_NODE_API_TOKEN'), /^[0-9a-f]{64}$/);
  assert.equal(key(aiFile, 'AI_NODE_API_TOKEN'), key(eaFile, 'AI_NODE_API_TOKEN'));
  assert.notEqual(key(eaFile, 'EA_API_TOKEN'), key(aiFile, 'AI_NODE_API_TOKEN'));
  assert.match(read(aiFile), /# settings\nJUSTIFIER_MODEL=example:model/);
  assert.match(read(eaFile), /PORT=8080/);
  for (const file of [aiFile, eaFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const before = [read(aiFile), read(eaFile)];
  configure(root);
  assert.deepEqual([read(aiFile), read(eaFile)], before);
});
test('reuses a configured quoted key without rotating it', () => {
  fs.writeFileSync(aiFile, `export AI_NODE_API_TOKEN="${'a'.repeat(64)}"\n`);
  configure(root);
  assert.equal(key(eaFile, 'AI_NODE_API_TOKEN'), 'a'.repeat(64));
});
for (const [name, ai, ea] of [
  ['invalid', 'AI_NODE_API_TOKEN=short', ''],
  ['mismatch', `AI_NODE_API_TOKEN=${'a'.repeat(64)}`, `AI_NODE_API_TOKEN=${'b'.repeat(64)}`],
  ['shared role', `AI_NODE_API_TOKEN=${'a'.repeat(64)}`, `EA_API_TOKEN=${'a'.repeat(64)}`],
  ['duplicate', `AI_NODE_API_TOKEN=${'a'.repeat(64)}\nAI_NODE_API_TOKEN=${'b'.repeat(64)}`, ''],
]) test(`refuses ${name} configuration without modifying either file`, () => {
  fs.writeFileSync(aiFile, ai); fs.writeFileSync(eaFile, ea);
  assert.throws(() => configure(root));
  assert.deepEqual([read(aiFile), read(eaFile)], [ai, ea]);
});
test('refuses symlink configuration', () => {
  const target = path.join(root, 'target'); fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, aiFile);
  assert.throws(() => configure(root), /regular file/);
  assert.equal(read(target), 'untouched');
  assert.equal(fs.existsSync(eaFile), false);
});
test('renders a private job whose TOML/DOT header decodes to the exact EA credential', () => {
  configure(root);
  const filename = path.join(root, 'job.toml');
  fs.copyFileSync(path.join(__dirname, '../../chainlink-node/basicJobSpec'), filename);
  renderJob(root, filename);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(read(filename).includes('{EA_API_TOKEN}'), false);
  // Parse both layers instead of merely checking that the token is in the text.
  // Python 3.11+ supplies tomllib; neither parsing step contacts Chainlink.
  const headers = JSON.parse(execFileSync('python3', ['-c',
    'import tomllib,json,re,sys; s=tomllib.load(open(sys.argv[1],"rb"))["observationSource"]; h=re.search(r\'headers=("(?:\\\\.|[^"\\\\])*")\',s).group(1); print(json.dumps(json.loads(json.loads(h))))', filename], { encoding: 'utf8' }));
  assert.deepEqual(headers, ['Authorization', `Bearer ${key(eaFile, 'EA_API_TOKEN')}`]);
});
test('refuses a job template without an authentication placeholder', () => {
  configure(root);
  const filename = path.join(root, 'job.toml'); fs.writeFileSync(filename, 'type = "directrequest"');
  assert.throws(() => renderJob(root, filename), /missing authentication/);
});

test('the actual upgrade gate refuses unauthenticated jobs when regeneration is declined', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/upgrade-arbiter.sh'), 'utf8');
  const gate = source.slice(source.indexOf('job_template_without_timeouts() {'), source.indexOf('# Function to regenerate job specs'));
  assert.ok(gate.includes('VA_UPGRADE_REGENERATE_JOBS'));
  const repo = path.join(root, 'repo'), target = path.join(root, 'target');
  fs.mkdirSync(repo); fs.mkdirSync(target);
  const template = fs.readFileSync(path.join(__dirname, '../../chainlink-node/basicJobSpec'), 'utf8');
  fs.writeFileSync(path.join(repo, 'basicJobSpec'), template);
  fs.writeFileSync(path.join(target, 'basicJobSpec'), template.split('\n').filter(line => !line.includes('headers=')).join('\n'));
  const run = accept => spawnSync('bash', ['-c', `
    set -e
    ask_yes_no() { test "$ACCEPT" = yes; }
    regenerate_job_specs() { echo REGENERATED; }
    ${gate}
    check_job_spec_template
  `], { encoding: 'utf8', env: { ...process.env, REPO_CHAINLINK_NODE: repo, TARGET_CHAINLINK_NODE: target, ACCEPT: accept } });
  const denied = run('no');
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /requires authenticated bridge jobs/);
  assert.doesNotMatch(denied.stdout, /REGENERATED/);
  const accepted = run('yes');
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /REGENERATED/);
  fs.copyFileSync(path.join(repo, 'basicJobSpec'), path.join(target, 'basicJobSpec'));
  assert.equal(run('no').status, 0);
  fs.rmSync(path.join(target, 'basicJobSpec'));
  assert.equal(run('yes').status, 1);
});
