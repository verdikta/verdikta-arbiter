// Node A6c: where the switch sits and who can set it, read from the sources. The modules
// that decide a verdict do not import it, the flag is read in one file, and no install or
// upgrade path names it.

const fs = require('fs');
const path = require('path');

const EA = path.join(__dirname, '..', '..', '..');
const REPO = path.join(EA, '..');
const NAMES = ['VERDIKTA_CANARY_FAULTS', 'VERDIKTA_CANARY_FAULT_KEY', 'VERDIKTA_CANARY_RPC_URL'];

function filesUnder(dir, skip = () => false) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git' || skip(file)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(file, skip));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

const naming = (files, names = NAMES) => files.filter((f) => {
  const text = fs.readFileSync(f, 'latin1');
  return names.some((n) => text.includes(n));
}).map((f) => path.relative(REPO, f));

describe('the flag is read in one place', () => {
  it('external-adapter/src names it only in canaryFault/config.js', () => {
    const src = filesUnder(path.join(EA, 'src'), (f) => f.includes('__tests__'));
    expect(naming(src)).toEqual(['external-adapter/src/canaryFault/config.js']);
  });

  it('that file reads process.env nowhere else in the module', () => {
    const others = ['index.js', 'measure.js', 'constants.js'].map((f) => fs.readFileSync(path.join(EA, 'src', 'canaryFault', f), 'utf8'));
    for (const text of others) expect(text).not.toMatch(/process\.env/);
  });
});

describe('no install or upgrade path sets it', () => {
  it('nothing under installer/ names the flag, the key or the RPC URL', () => {
    expect(naming(filesUnder(path.join(REPO, 'installer')))).toEqual([]);
  });

  it('no env example names them', () => {
    const examples = [
      ...filesUnder(EA).filter((f) => /\.env/.test(path.basename(f))),
      ...filesUnder(path.join(REPO, 'ai-node'), (f) => f.includes('.next')).filter((f) => /\.env/.test(path.basename(f)))
    ];
    expect(naming(examples)).toEqual([]);
  });

  it('no workflow sets them', () => {
    expect(naming(filesUnder(path.join(REPO, '.github')))).toEqual([]);
  });

  it('the Chainlink node\'s job and config do not name them', () => {
    expect(naming(filesUnder(path.join(REPO, 'chainlink-node')))).toEqual([]);
  });
});

describe('it cannot reach what decides a claim', () => {
  const noImport = ['settlement', 'verdict', 'evidence', 'frontGates', 'runnerClient', 'sharedRuns', 'aiRequest', 'addendum', 'archiveMembers', 'time', 'errors', 'config'];

  it.each(noImport)('codeReview/%s.js does not import the switch', (name) => {
    expect(fs.readFileSync(path.join(EA, 'src', 'codeReview', `${name}.js`), 'utf8')).not.toMatch(/canaryFault/i);
  });

  it('the switch imports nothing of the code-review path', () => {
    for (const file of filesUnder(path.join(EA, 'src', 'canaryFault'))) {
      const requires = [...fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
      for (const name of requires) expect(['axios', 'crypto', 'ethers', './config', './constants', './measure']).toContain(name);
    }
  });

  it('the only code-review module that reads the switch is claimRun.js, and index.js only passes the request\'s ids', () => {
    const src = filesUnder(path.join(EA, 'src', 'codeReview'));
    const readers = src.filter((f) => /canaryFault/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f)).sort();
    expect(readers).toEqual(['claimRun.js']);
  });
});
