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

  it('the installer reads each component\'s exact pin (installer/util/common-pin.js)', () => {
    const { exactCommonPin } = require(path.join(REPO, 'installer', 'util', 'common-pin.js'));
    for (const pkg of PACKAGES) expect(exactCommonPin(path.join(REPO, pkg))).toBe(PINNED);
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-pin-'));
    try {
      for (const spec of ['^1.7.0', '~1.8.0', 'latest', 'attest', '1.x']) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@verdikta/common': spec } }));
        expect(exactCommonPin(dir)).toBeNull();
      }
      fs.rmSync(path.join(dir, 'package.json'));
      expect(exactCommonPin(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['latest', 'beta', 'next'])('the installer\'s update (VERDIKTA_COMMON_VERSION=%s) never replaces the pinned prerelease', async (tag) => {
    const Updater = require(path.join(REPO, 'installer', 'util', 'update-verdikta-common.js'));
    const updater = new Updater(path.join(REPO, 'ai-node'), path.join(REPO, 'external-adapter'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const latest = jest.spyOn(Updater.prototype, 'getLatestVersion').mockRejectedValue(new Error('must not ask npm'));
    const install = jest.spyOn(Updater.prototype, 'installOrUpdate').mockRejectedValue(new Error('must not install'));
    try {
      const result = await updater.updateIfNeeded(tag, true);
      expect(result).toMatchObject({ updated: false, action: 'pinned', pins: { aiNode: PINNED, externalAdapter: PINNED } });
      expect(latest).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      latest.mockRestore();
      install.mockRestore();
    }
  });

  it('a component pinned to a range is still updated as before', () => {
    const Updater = require(path.join(REPO, 'installer', 'util', 'update-verdikta-common.js'));
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-pin-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@verdikta/common': '^1.7.0' } }));
      expect(new Updater(dir, dir).pinnedVersions()).toEqual({});
      // and the version comparison never downgrades the prerelease to an older latest
      expect(new Updater(dir).compareVersions(PINNED, '1.8.0')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
