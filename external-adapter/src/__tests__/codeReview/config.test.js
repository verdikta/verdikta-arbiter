// Operator configuration of code-review mode: off unless enabled with a
// runner, production trust unless dev trust is asked for explicitly, and dev
// trust never on Base mainnet (or on a chain the adapter cannot name).

const { codeReview } = require('@verdikta/common');
const { codeReviewConfigFromEnv, describeCodeReviewConfig } = require('../../codeReview/config');

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

  it('accepts CODE_RUNNER_TOKEN_FILE instead of the token', () => {
    const config = codeReviewConfigFromEnv({ ...READY, CODE_RUNNER_TOKEN: undefined, CODE_RUNNER_TOKEN_FILE: __filename });
    expect(config.runner.configured).toBe(true);
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
