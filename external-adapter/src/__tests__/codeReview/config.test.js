// Operator configuration of code-review mode: off unless enabled with a
// runner, production trust unless dev trust is asked for explicitly, and dev
// trust never on Base mainnet (or on a chain the adapter cannot name).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { codeReviewConfigFromEnv, describeCodeReviewConfig, readCommonVersions } = require('../../codeReview/config');

const PINNED = '1.9.0-attest.1';

const DEV_KEY = codeReview.createDevBuilderKey();
const TOKEN = 'runner-token-0123456789abcdef0123456789abcdef';
const READY = {
  CODE_REVIEW_ENABLED: 'true',
  CODE_RUNNER_URL: 'http://127.0.0.1:8090',
  CODE_RUNNER_TOKEN: TOKEN
};
const DEV = {
  ...READY,
  CODE_REVIEW_TRUST: 'dev',
  CODE_REVIEW_DEV_KEYS: DEV_KEY.publicKey,
  NETWORK_CHAIN_ID: '84532'
};

describe('code-review config', () => {
  it('is off by default and refuses code mode', () => {
    const config = codeReviewConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.ready).toBe(false);
    expect(config.trust.mode).toBe('production');
    expect(config.problems.join(' ')).toMatch(/CODE_REVIEW_ENABLED/);
  });

  it('only the exact value "true" enables it', () => {
    for (const value of ['1', 'yes', 'TRUE ', 'on', '']) {
      expect(codeReviewConfigFromEnv({ ...READY, CODE_REVIEW_ENABLED: value }).enabled).toBe(value.trim().toLowerCase() === 'true');
    }
    expect(codeReviewConfigFromEnv({ ...READY, CODE_REVIEW_ENABLED: 'yes' }).ready).toBe(false);
  });

  it('is ready with CODE_REVIEW_ENABLED=true and a configured runner, in production trust', () => {
    const config = codeReviewConfigFromEnv(READY);
    expect(config.ready).toBe(true);
    expect(config.runner.configured).toBe(true);
    expect(config.trust).toEqual({ mode: 'production', devKeys: [], refused: null });
    expect(config.problems).toEqual([]);
  });

  it.each([
    ['no runner URL', { CODE_RUNNER_URL: undefined }],
    ['a runner URL that is not http(s)', { CODE_RUNNER_URL: 'ftp://127.0.0.1:8090' }],
    ['an unparseable runner URL', { CODE_RUNNER_URL: 'not a url' }],
    ['no runner token', { CODE_RUNNER_TOKEN: undefined }]
  ])('enabled but %s → not ready', (_label, change) => {
    const config = codeReviewConfigFromEnv({ ...READY, ...change });
    expect(config.enabled).toBe(true);
    expect(config.runner.configured).toBe(false);
    expect(config.ready).toBe(false);
    expect(config.problems.join(' ')).toMatch(/CODE_RUNNER/);
  });

  describe('the runner token', () => {
    let dir;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-token-')); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const tokenFile = (name, contents) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, contents);
      return file;
    };
    const withFile = (file) => codeReviewConfigFromEnv({ ...READY, CODE_RUNNER_TOKEN: undefined, CODE_RUNNER_TOKEN_FILE: file });

    it('accepts CODE_RUNNER_TOKEN_FILE holding a token (a trailing newline is fine)', () => {
      expect(withFile(tokenFile('good', `${TOKEN}\n`)).runner.configured).toBe(true);
    });

    it.each([
      ['an empty file', ''],
      ['a whitespace-only file', '  \n\t\n'],
      ['a short token', 'tooshort\n'],
      ['a token with a space in it', `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`]
    ])('refuses CODE_RUNNER_TOKEN_FILE holding %s', (label, contents) => {
      const config = withFile(tokenFile(label.replace(/\W/g, '_'), contents));
      expect(config.runner.configured).toBe(false);
      expect(config.ready).toBe(false);
      expect(config.problems.join(' ')).toMatch(/CODE_RUNNER_TOKEN_FILE/);
      expect(config.problems.join(' ')).not.toContain(TOKEN);
    });

    it('refuses CODE_RUNNER_TOKEN_FILE naming a directory or nothing', () => {
      expect(withFile(dir).runner.configured).toBe(false);
      expect(withFile(path.join(dir, 'absent')).runner.configured).toBe(false);
    });

    it('refuses a short inline CODE_RUNNER_TOKEN', () => {
      const config = codeReviewConfigFromEnv({ ...READY, CODE_RUNNER_TOKEN: 'short' });
      expect(config.runner.configured).toBe(false);
      expect(config.problems.join(' ')).toMatch(/CODE_RUNNER_TOKEN/);
    });

    it('refuses both the token and the file', () => {
      expect(codeReviewConfigFromEnv({ ...READY, CODE_RUNNER_TOKEN_FILE: tokenFile('both', TOKEN) }).runner.configured).toBe(false);
    });
  });

  describe('the @verdikta/common release', () => {
    it('reads the pin, the installed copy and the AI Node\'s copy from this checkout', () => {
      expect(readCommonVersions()).toMatchObject({ pinned: PINNED, installed: PINNED });
    });

    it.each([
      ['the adapter runs another release than it pins (an install replaced it)', { pinned: PINNED, installed: '1.8.0', aiNode: '1.8.0' }, /adapter runs @verdikta\/common 1\.8\.0/],
      ['the AI Node beside it runs another release', { pinned: PINNED, installed: PINNED, aiNode: '1.8.0' }, /AI Node runs @verdikta\/common 1\.8\.0/],
      ['the installed release cannot be read', { pinned: PINNED, installed: null, aiNode: null }, /unknown/]
    ])('code mode is off when %s', (_label, versions, pattern) => {
      const config = codeReviewConfigFromEnv(READY, { versions });
      expect(config.ready).toBe(false);
      expect(config.problems.join(' ')).toMatch(pattern);
    });

    it('an AI Node that is not beside the adapter (split deployment) does not block it', () => {
      expect(codeReviewConfigFromEnv(READY, { versions: { pinned: PINNED, installed: PINNED, aiNode: null } }).ready).toBe(true);
    });

    it('a mismatch is not reported while code review is off', () => {
      const config = codeReviewConfigFromEnv({}, { versions: { pinned: PINNED, installed: '1.8.0', aiNode: null } });
      expect(config.problems).toEqual(['CODE_REVIEW_ENABLED is not true']);
    });
  });

  describe('trust mode', () => {
    it('CODE_REVIEW_TRUST=dev adds the caller-supplied dev keys on a test chain', () => {
      const config = codeReviewConfigFromEnv(DEV);
      expect(config.trust.mode).toBe('dev');
      expect(config.trust.refused).toBeNull();
      expect(config.trust.devKeys).toEqual([{ publicKey: DEV_KEY.publicKey }]);
      expect(config.ready).toBe(true);
    });

    it('accepts several comma-separated dev keys', () => {
      const other = codeReview.createDevBuilderKey();
      const config = codeReviewConfigFromEnv({ ...DEV, CODE_REVIEW_DEV_KEYS: ` ${DEV_KEY.publicKey} , ${other.publicKey}` });
      expect(config.trust.devKeys.map((k) => k.publicKey)).toEqual([DEV_KEY.publicKey, other.publicKey]);
    });

    it.each([
      ['Base mainnet by chain id', { NETWORK_CHAIN_ID: '8453' }],
      ['Base mainnet by network name', { DEPLOYMENT_NETWORK: 'base_mainnet' }],
      ['Base mainnet by name, whatever the chain id says', { DEPLOYMENT_NETWORK: 'base_mainnet', NETWORK_CHAIN_ID: '84532' }],
      ['an unknown chain (no NETWORK_CHAIN_ID)', { NETWORK_CHAIN_ID: undefined }],
      ['a chain id that is not a test chain', { NETWORK_CHAIN_ID: '1' }],
      ['an unparseable chain id', { NETWORK_CHAIN_ID: '84532abc' }]
    ])('dev trust is refused on %s: code mode is off', (_label, change) => {
      const config = codeReviewConfigFromEnv({ ...DEV, ...change });
      expect(config.trust.mode).toBe('dev');
      expect(config.trust.refused).toEqual(expect.any(String));
      expect(config.trust.devKeys).toEqual([]);
      expect(config.ready).toBe(false);
    });

    it('dev trust without keys is refused', () => {
      const config = codeReviewConfigFromEnv({ ...DEV, CODE_REVIEW_DEV_KEYS: '' });
      expect(config.trust.refused).toMatch(/CODE_REVIEW_DEV_KEYS/);
      expect(config.ready).toBe(false);
    });

    it('dev trust with a key common cannot read is refused', () => {
      const config = codeReviewConfigFromEnv({ ...DEV, CODE_REVIEW_DEV_KEYS: 'not-a-key' });
      expect(config.trust.refused).toMatch(/CODE_REVIEW_DEV_KEYS/);
      expect(config.ready).toBe(false);
    });

    it('dev keys without CODE_REVIEW_TRUST=dev are ignored (production trust never takes caller keys)', () => {
      const config = codeReviewConfigFromEnv({ ...READY, CODE_REVIEW_DEV_KEYS: DEV_KEY.publicKey });
      expect(config.trust).toEqual({ mode: 'production', devKeys: [], refused: null });
    });

    it('an unknown trust mode refuses code mode rather than guessing', () => {
      const config = codeReviewConfigFromEnv({ ...READY, CODE_REVIEW_TRUST: 'devel' });
      expect(config.trust.refused).toMatch(/CODE_REVIEW_TRUST/);
      expect(config.ready).toBe(false);
    });

    it('CODE_REVIEW_TRUST=production is the default spelled out', () => {
      expect(codeReviewConfigFromEnv({ ...READY, CODE_REVIEW_TRUST: 'production' }).trust.mode).toBe('production');
    });
  });

  describe('describeCodeReviewConfig (for /health)', () => {
    it('reports the trust mode, readiness and problems without secrets', () => {
      const description = describeCodeReviewConfig(codeReviewConfigFromEnv(DEV));
      expect(description).toEqual({
        enabled: true,
        ready: true,
        runnerConfigured: true,
        commonVersion: PINNED,
        trust: 'dev',
        devKeyCount: 1,
        chainId: 84532,
        network: null,
        problems: []
      });
      const text = JSON.stringify(description);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('127.0.0.1');
    });

    it('shows refused dev trust as "dev-refused"', () => {
      const description = describeCodeReviewConfig(codeReviewConfigFromEnv({ ...DEV, NETWORK_CHAIN_ID: '8453' }));
      expect(description.trust).toBe('dev-refused');
      expect(description.ready).toBe(false);
      expect(description.problems.join(' ')).toMatch(/mainnet/);
    });
  });
});
