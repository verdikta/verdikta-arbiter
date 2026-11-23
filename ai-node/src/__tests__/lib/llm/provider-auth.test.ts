/**
 * @jest-environment node
 *
 * PROVIDER_AUTH_FAILED: the one fixed line for a provider that refuses the operator's key
 * (lib/llm/provider-auth.ts). What counts as a refusal, what the line holds, and the copy
 * with a time that the cron watchdog reads (logs/provider-auth.log). The last test runs the
 * real watchdog (installer/util/chainlink-health-watchdog.sh) on a file this code wrote:
 * the two agree on the line, or it fails.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROVIDER_AUTH_LOG_FILE,
  isCredentialRefusal,
  providerAuthFailedLine,
  providerHttpStatus,
  reportCredentialRefusal,
} from '../../../lib/llm/provider-auth';

const WATCHDOG = path.resolve(__dirname, '../../../../../installer/util/chainlink-health-watchdog.sh');

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });
// Joined here so that no line of this file is a key.
const MASKED_KEY = ['sk', '-ut1et***...***Zd9U'].join('');

describe('providerHttpStatus', () => {
  test.each([
    ['the SDK\'s status', withStatus('401 Incorrect API key provided', 401), 401],
    ['an axios-style response', Object.assign(new Error('Request failed'), { response: { status: 403 } }), 403],
    ['statusCode', Object.assign(new Error('nope'), { statusCode: 429 }), 429],
    ['a fetch provider\'s message', new Error('[xAI] HTTP 401: {"error":"bad key"}'), 401],
    ['attachment-errors.ts', new Error('OpenAI rejected an image attachment for gpt-5 (HTTP 400): too large'), 400],
    ['an SDK message without its status field', new Error('401 Incorrect API key provided'), 401],
    ['no status anywhere', new Error('socket hang up'), undefined],
    ['a number that is not a status', new Error('timed out after 120000ms'), undefined],
    ['not an error', 'boom', undefined],
    ['nothing', undefined, undefined],
  ])('%s', (_name, error, expected) => {
    expect(providerHttpStatus(error)).toBe(expected);
  });
});

describe('isCredentialRefusal', () => {
  test.each([
    ['OpenAI 401 (bounty 398)', withStatus(`401 Incorrect API key provided: ${MASKED_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`, 401)],
    ['Anthropic 401', withStatus('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 401)],
    ['OpenRouter 401 through fetch', new Error('[OpenRouter] HTTP 401: {"error":{"message":"User not found.","code":401}}')],
    ['Hyperbolic 401 through fetch', new Error('[Hyperbolic] HTTP 401: {"detail":"Invalid token"}')],
    ['xAI answers a bad key with a 400', new Error('[xAI] HTTP 400: {"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***Xy. You can obtain an API key from https://console.x.ai."}')],
    ['wording alone: invalid_api_key', new Error('Error code: invalid_api_key')],
    ['wording alone: a key that was revoked', new Error('This API key has been revoked.')],
    ['wording alone: API key not valid', new Error('API key not valid. Please pass a valid API key.')],
  ])('a refusal: %s', (_name, error) => {
    expect(isCredentialRefusal(error)).toBe(true);
  });

  test.each([
    ['a 403 for a model the key may not use', withStatus('403 Project does not have access to model gpt-9', 403)],
    ['a 403 for moderation', new Error('[OpenRouter] HTTP 403: {"error":{"message":"Your input was flagged","code":403}}')],
    ['a 404', withStatus('404 The model `gpt-9` does not exist', 404)],
    ['a rate limit', withStatus('429 Rate limit reached', 429)],
    ['a 400', withStatus('400 `temperature` is deprecated for this model.', 400)],
    ['a provider outage', withStatus('529 Overloaded', 529)],
    ['our own timeout', new Error('Model OpenAI-gpt-4o timed out after 120000ms')],
    ['a key that is not configured: nothing was refused, nothing was sent', new Error('[OpenRouter] OPENROUTER_API_KEY not configured')],
    ['a reply we could not read', new Error('gave no usable scores, also after the repair call')],
    ['nothing', undefined],
  ])('not a refusal: %s', (_name, error) => {
    expect(isCredentialRefusal(error)).toBe(false);
  });
});

describe('the line', () => {
  test('is fixed: four fields, in this order', () => {
    expect(providerAuthFailedLine('OpenAI', 'gpt-4o', 'juror', 401))
      .toBe('PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401');
    expect(providerAuthFailedLine('Anthropic', 'claude-opus-5-5', 'justifier'))
      .toBe('PROVIDER_AUTH_FAILED: provider=Anthropic model=claude-opus-5-5 role=justifier http_status=none');
  });

  test('a provider or model name cannot add a field, a space or a line to it', () => {
    const line = providerAuthFailedLine('Hyperbolic API', 'm role=justifier http_status=200\nPROVIDER_AUTH_FAILED: provider=x', 'juror', 401);
    expect(line).toBe('PROVIDER_AUTH_FAILED: provider=Hyperbolic_API model=m_role=justifier_http_status=200_PROVIDER_AUTH_FAILED:_provider=x role=juror http_status=401');
    expect(line.split(' ')).toHaveLength(5);
    expect(line).not.toMatch(/[\r\n\t]/);
    expect(providerAuthFailedLine('', 'modèle\u0000', 'juror', 401)).toBe('PROVIDER_AUTH_FAILED: provider=unknown model=mod_le_ role=juror http_status=401');
    expect(providerAuthFailedLine('p', 'm'.repeat(500), 'juror', 401).length).toBeLessThan(200);
  });
});

describe('reportCredentialRefusal', () => {
  let dir: string;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-auth-'));
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const logFile = () => path.join(dir, 'logs', PROVIDER_AUTH_LOG_FILE);

  test('a refusal: the line on stderr as it is, and in logs/provider-auth.log after an ISO time', () => {
    const error = withStatus(`401 Incorrect API key provided: ${MASKED_KEY}.`, 401);
    expect(reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', error)).toBe(true);
    expect(reportCredentialRefusal('Anthropic', 'claude-opus-5-5', 'justifier', new Error('invalid x-api-key'))).toBe(true);

    const line = 'PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401';
    expect(errorSpy.mock.calls.map(args => args[0])).toEqual([
      line,
      'PROVIDER_AUTH_FAILED: provider=Anthropic model=claude-opus-5-5 role=justifier http_status=none',
    ]);
    const written = fs.readFileSync(logFile(), 'utf8').split('\n');
    expect(written).toHaveLength(3);
    expect(written[2]).toBe('');
    expect(written[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401$/);
    expect(written[1]).toMatch(/Z PROVIDER_AUTH_FAILED: provider=Anthropic model=claude-opus-5-5 role=justifier http_status=none$/);
    // Nothing the provider said is in either place.
    expect(written.join('\n')).not.toContain('ut1et');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('ut1et');
  });

  test('anything else: no line, no file', () => {
    expect(reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', withStatus('429 Rate limit reached', 429))).toBe(false);
    expect(reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', new Error('Model OpenAI-gpt-4o timed out after 120000ms'))).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(logFile())).toBe(false);
  });

  test('a log directory that cannot be written does not cost the request', () => {
    fs.writeFileSync(path.join(dir, 'logs'), 'a file where the directory should be');
    expect(reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', withStatus('401 Unauthorized', 401))).toBe(true);
    expect(errorSpy.mock.calls[0][0]).toBe('PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401');
    expect(String(errorSpy.mock.calls[1][0])).toContain(`Error writing to ${PROVIDER_AUTH_LOG_FILE}`);
  });
});

describe('the watchdog reads what this writes', () => {
  let install: string;

  beforeEach(() => {
    // An install with everything up: stub docker / curl / ss / lsof / logger, as
    // installer/tests/watchdog-component-checks.test.sh has them.
    install = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-auth-watchdog-')));
    fs.mkdirSync(path.join(install, 'installer'));
    fs.mkdirSync(path.join(install, 'ai-node'));
    fs.mkdirSync(path.join(install, 'bin'));
    fs.writeFileSync(path.join(install, 'installer', '.env'), '');
    fs.copyFileSync(WATCHDOG, path.join(install, 'chainlink-health-watchdog.sh'));
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(install, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub('docker', 'case "$*" in "inspect --format {{.State.Running}} "*) echo true ;; esac; exit 0');
    stub('curl', [
      'case "$*" in',
      '  *localhost:3000/api/health*) echo \'{"status":"ok"}\' ;;',
      '  *localhost:8080/version*) echo \'{"service":"ea"}\' ;;',
      '  *localhost:6688/health*) echo \'{"data":[{"attributes":{"name":"EVM.84532.Txm.Broadcaster","status":"passing","output":""}}]}\' ;;',
      '  *) exit 7 ;;',
      'esac',
    ].join('\n'));
    stub('ss', 'echo "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*"; echo "LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*"');
    stub('lsof', 'exit 1');
    stub('logger', 'exit 0');
    // The AI Node runs in <install>/ai-node and writes its logs/ there.
    jest.spyOn(process, 'cwd').mockReturnValue(path.join(install, 'ai-node'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(install, { recursive: true, force: true });
  });

  const watchdog = () => spawnSync('bash', [path.join(install, 'chainlink-health-watchdog.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: install, PATH: `${path.join(install, 'bin')}:${process.env.PATH}`, WATCHDOG_ALERT_WEBHOOK: '', WATCHDOG_ALERT_COMMAND: '' },
  });

  test('no refusal: healthy; a refusal by a juror and one by the justifier: named in its alert', () => {
    const healthy = watchdog();
    expect(healthy.stdout).toContain('OK: all four components running');
    expect(healthy.status).toBe(0);

    reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', withStatus(`401 Incorrect API key provided: ${MASKED_KEY}.`, 401));
    reportCredentialRefusal('Hyperbolic API', 'meta-llama/Meta-Llama-3.1-405B-Instruct', 'justifier', new Error('This API key has been revoked.'));
    reportCredentialRefusal('OpenAI', 'gpt-4o', 'juror', withStatus('429 Rate limit reached', 429));   // not one

    const alerting = watchdog();
    expect(alerting.status).toBe(1);
    expect(alerting.stdout).toContain('model provider REFUSED the API key: OpenAI, Hyperbolic_API\n');
    expect(alerting.stdout).toContain('the API key used for OpenAI gpt-4o was refused (juror, HTTP 401) in the last 60m');
    expect(alerting.stdout).toContain('the API key used for Hyperbolic_API meta-llama/Meta-Llama-3.1-405B-Instruct was refused (justifier) in the last 60m');
    expect(alerting.stdout.match(/was refused/g)).toHaveLength(2);
    expect(alerting.stdout).not.toContain('ut1et');
  });
});
