const path = require('path');
const fs = require('fs');
const os = require('os');
const { collectVersionInfo } = require('../../utils/versionInfo');

describe('versionInfo', () => {
  it('reports the adapter version from package.json', () => {
    const expected = require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
    expect(collectVersionInfo().adapter).toBe(expected);
  });

  it('reports the installed @verdikta/common version', () => {
    const expected = require('@verdikta/common/package.json').version;
    expect(collectVersionInfo().verdiktaCommon).toBe(expected);
  });

  it('has all expected keys, using null (not throwing) for missing sources', () => {
    const info = collectVersionInfo();
    expect(Object.keys(info).sort()).toEqual(['adapter', 'aiNode', 'release', 'verdiktaCommon']);
    for (const value of Object.values(info)) {
      expect(value === null || typeof value === 'string').toBe(true);
    }
  });

  it('is JSON-serializable (goes into every justification upload)', () => {
    expect(() => JSON.stringify(collectVersionInfo())).not.toThrow();
  });

  it('picks up a release stamp written AFTER startup (upgrade writes VERSION last)', () => {
    const stampFile = path.join(__dirname, '..', '..', '..', 'VERSION');
    const existed = fs.existsSync(stampFile);
    const original = existed ? fs.readFileSync(stampFile, 'utf8') : null;
    try {
      fs.writeFileSync(stampFile, 'testrelease-abc123 2026-01-01T00:00:00Z\n');
      expect(collectVersionInfo().release).toBe('testrelease-abc123 2026-01-01T00:00:00Z');
    } finally {
      if (existed) fs.writeFileSync(stampFile, original);
      else fs.rmSync(stampFile, { force: true });
    }
  });
});
