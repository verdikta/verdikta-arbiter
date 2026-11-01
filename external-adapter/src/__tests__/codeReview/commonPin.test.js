// The External Adapter, the AI Node and the e2e harness must read the same
// @verdikta/common release: the code-review gates, schemas and classes are in
// it, and an EA and AI Node on different versions could judge one claim by
// two rule sets. They pin the stake-attestation prerelease exactly.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const PINNED = '1.9.0-attest.1';
const PACKAGES = ['external-adapter', 'ai-node', 'e2e'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('@verdikta/common pin', () => {
  it.each(PACKAGES)('%s/package.json pins @verdikta/common exactly to the prerelease', (pkg) => {
    const manifest = readJson(path.join(REPO, pkg, 'package.json'));
    expect(manifest.dependencies['@verdikta/common']).toBe(PINNED);
  });

  it.each(PACKAGES)('%s/package-lock.json resolves that exact version', (pkg) => {
    const lock = readJson(path.join(REPO, pkg, 'package-lock.json'));
    expect(lock.packages[''].dependencies['@verdikta/common']).toBe(PINNED);
    expect(lock.packages['node_modules/@verdikta/common'].version).toBe(PINNED);
  });

  it('the three packages agree with each other', () => {
    const versions = PACKAGES.map((pkg) => readJson(path.join(REPO, pkg, 'package.json')).dependencies['@verdikta/common']);
    expect(new Set(versions).size).toBe(1);
  });

  it('the adapter runs the pinned version', () => {
    expect(require('@verdikta/common/package.json').version).toBe(PINNED);
  });

  it('the installer\'s same-version check sees one version in the AI Node and the adapter', async () => {
    const Updater = require(path.join(REPO, 'installer', 'util', 'update-verdikta-common.js'));
    const updater = new Updater(path.join(REPO, 'ai-node'), path.join(REPO, 'external-adapter'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const versions = await updater.checkAllCurrentVersions();
      expect(versions).toEqual({ aiNode: PINNED, externalAdapter: PINNED });
    } finally {
      log.mockRestore();
    }
  });

  it('the installer\'s "latest" update does not replace the prerelease with an older release', () => {
    const Updater = require(path.join(REPO, 'installer', 'util', 'update-verdikta-common.js'));
    const updater = new Updater(path.join(REPO, 'ai-node'));
    // latest on npm is 1.8.x while the prerelease is in use; an update must not downgrade it
    expect(updater.compareVersions(PINNED, '1.8.0')).toBe(false);
    expect(updater.compareVersions(PINNED, PINNED)).toBe(false);
  });
});
