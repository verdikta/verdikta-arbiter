/**
 * @jest-environment node
 *
 * The doctor's ai.code_jurors check (installer/util/code-review-check.js, `jurors`; node
 * A14) says which route the AI Gateway gives each juror of common's code-standard panels.
 * It cannot run this TypeScript: it reads ai-node/.env.local and decides as
 * resolveProviderConfig does. This file holds the two to the same answer: for each
 * environment below, the real check, run as the doctor runs it on a throwaway install,
 * against provider-config.ts in this process. Nothing is sent anywhere.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProviderConfig } from '../../../lib/llm/provider-config';

const CHECK = path.resolve(__dirname, '../../../../../installer/util/code-review-check.js');

/** Every provider name a panel could carry: each class, with the display names and aliases the gateway takes. */
const PROVIDERS = ['openai', 'OpenAI', 'anthropic', 'Anthropic', 'xai', 'xAI', 'grok', 'hyperbolic', 'Hyperbolic API', 'openrouter', 'ollama', 'Open-source', 'google'];

const GATEWAY_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'HYPERBOLIC_API_KEY', 'OPENROUTER_API_KEY',
  'AI_GATEWAY', 'OPENAI_CLASS_PROVIDER', 'ANTHROPIC_CLASS_PROVIDER', 'XAI_CLASS_PROVIDER', 'HYPERBOLIC_CLASS_PROVIDER',
  'OPENAI_CLASS_MODEL', 'ANTHROPIC_CLASS_MODEL',
];

const ENVS: Array<[string, Record<string, string>]> = [
  ['no keys', {}],
  ['every native key', { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', XAI_API_KEY: 'k', HYPERBOLIC_API_KEY: 'k' }],
  ['OpenRouter only', { OPENROUTER_API_KEY: 'k' }],
  ['every key', { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', XAI_API_KEY: 'k', HYPERBOLIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['GROK_API_KEY for xAI', { GROK_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['some native keys and OpenRouter', { OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['AI_GATEWAY=openrouter', { AI_GATEWAY: 'openrouter', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }],
  ['AI_GATEWAY=native', { AI_GATEWAY: 'native', OPENROUTER_API_KEY: 'k' }],
  ['AI_GATEWAY with case and spaces', { AI_GATEWAY: '  OpenRouter ', OPENAI_API_KEY: 'k' }],
  ['AI_GATEWAY not a backend', { AI_GATEWAY: 'auto', OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }],
  ['a class sent to OpenRouter', { ANTHROPIC_CLASS_PROVIDER: 'openrouter', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }],
  ['a class kept native without its key', { OPENAI_CLASS_PROVIDER: 'native', OPENROUTER_API_KEY: 'k' }],
  ['a class override beats AI_GATEWAY', { AI_GATEWAY: 'openrouter', OPENAI_CLASS_PROVIDER: 'native', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['a class override that is not a backend', { OPENAI_CLASS_PROVIDER: 'yes', OPENROUTER_API_KEY: 'k' }],
  ['a class model override', { ANTHROPIC_CLASS_MODEL: 'anthropic/claude-opus-5.5', OPENROUTER_API_KEY: 'k' }],
];

let install: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  install = fs.mkdtempSync(path.join(os.tmpdir(), 'code-jurors-'));
  const common = path.join(install, 'ai-node', 'node_modules', '@verdikta', 'common');
  fs.mkdirSync(common, { recursive: true });
  fs.writeFileSync(path.join(common, 'package.json'), JSON.stringify({ name: '@verdikta/common', version: '9.9.9-test', main: 'index.js' }));
  // A made-up panel with one juror per provider name: the check reads whatever the release has.
  const nodes = PROVIDERS.map((provider, i) => ({ AI_PROVIDER: provider, AI_MODEL: `model-${i}`, NO_COUNTS: 1, WEIGHT: 1 }));
  fs.writeFileSync(path.join(common, 'index.js'), `module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], CODE_STANDARD_PANEL: { AI_NODES: ${JSON.stringify(nodes)} } } };\n`);
  GATEWAY_KEYS.forEach(key => { saved[key] = process.env[key]; });
});

afterAll(() => {
  fs.rmSync(install, { recursive: true, force: true });
  GATEWAY_KEYS.forEach(key => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
});

/** The doctor's answer for this .env.local. It exits 1 when a juror has no route, and still prints them. */
function doctorRoutes(env: Record<string, string>): any[] {
  fs.writeFileSync(path.join(install, 'ai-node', '.env.local'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  let out: string;
  try {
    out = execFileSync(process.execPath, [CHECK, 'jurors', '--install-dir', install], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  } catch (error: any) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  }
  return JSON.parse(out).jurors;
}

/** The gateway's answer for the same environment, in this process. */
function gatewayRoute(provider: string, env: Record<string, string>) {
  GATEWAY_KEYS.forEach(key => { delete process.env[key]; });
  Object.assign(process.env, env);
  try {
    const { providerClass, backend, reason } = resolveProviderConfig(provider);
    return { providerClass, backend, reason };
  } catch {
    return { providerClass: null, backend: null, reason: null };
  }
}

describe('the doctor routes each juror as the AI Gateway does', () => {
  test.each(ENVS)('%s', (_name, env) => {
    const jurors = doctorRoutes(env);
    expect(jurors.map(j => j.provider)).toEqual(PROVIDERS);
    for (const juror of jurors) {
      expect({ provider: juror.provider, providerClass: juror.providerClass, backend: juror.backend, reason: juror.reason })
        .toEqual({ provider: juror.provider, ...gatewayRoute(juror.provider, env) });
    }
  });

  test('a juror on OpenRouter is served only with an OpenRouter key, a native one only with its own', () => {
    const jurors = doctorRoutes({ OPENAI_API_KEY: 'k', AI_GATEWAY: 'openrouter' });
    const byProvider = Object.fromEntries(jurors.map(j => [j.provider, j]));
    expect(byProvider.openai).toMatchObject({ backend: 'openrouter', served: false });
    expect(byProvider.openrouter).toMatchObject({ backend: 'openrouter', served: false });
    expect(byProvider.google).toMatchObject({ providerClass: null, served: false });
    const native = Object.fromEntries(doctorRoutes({ OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }).map(j => [j.provider, j]));
    expect(native.openai).toMatchObject({ backend: 'native', served: true, key: 'OPENAI_API_KEY' });
    expect(native.anthropic).toMatchObject({ backend: 'openrouter', served: true, key: 'OPENROUTER_API_KEY' });
    expect(native.openrouter).toMatchObject({ backend: 'openrouter', served: true, key: 'OPENROUTER_API_KEY' });
  });
});
