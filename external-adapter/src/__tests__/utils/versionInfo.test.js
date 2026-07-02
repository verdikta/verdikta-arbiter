const path = require('path');
const { versionInfo, collectVersionInfo } = require('../../utils/versionInfo');

describe('versionInfo', () => {
  it('reports the adapter version from package.json', () => {
    const expected = require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
    expect(versionInfo.adapter).toBe(expected);
  });

  it('reports the installed @verdikta/common version', () => {
    const expected = require('@verdikta/common/package.json').version;
    expect(versionInfo.verdiktaCommon).toBe(expected);
  });

  it('has all expected keys, using null (not throwing) for missing sources', () => {
    const info = collectVersionInfo();
    expect(Object.keys(info).sort()).toEqual(['adapter', 'aiNode', 'release', 'verdiktaCommon']);
    for (const value of Object.values(info)) {
      expect(value === null || typeof value === 'string').toBe(true);
    }
  });

  it('is JSON-serializable (goes into every justification upload)', () => {
    expect(() => JSON.stringify(versionInfo)).not.toThrow();
  });
});
