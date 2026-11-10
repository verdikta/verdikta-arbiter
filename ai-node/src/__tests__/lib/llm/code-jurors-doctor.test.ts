/**
 * @jest-environment node
 *
 * The doctor's ai.code_jurors check (installer/util/code-review-check.js, `jurors`; node
 * A14) says which route the AI Gateway gives each juror of common's code-standard panels.
 * It cannot run this TypeScript or Next: it reads the AI Node's env files as Next's
 * loadEnvConfig does and decides as resolveProviderConfig does. This file holds it to both:
 * for each set of env files below, the real check, run as the doctor runs it on a
 * throwaway install, against Next's own loader (@next/env) on the same files and
 * provider-config.ts in this process. Nothing is sent anywhere.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvConfig } from '@next/env';
import { resolveProviderConfig } from '../../../lib/llm/provider-config';

const CHECK = path.resolve(__dirname, '../../../../../installer/util/code-review-check.js');

/** Every provider name a panel could carry: each class, with the display names and aliases the gateway takes. */
const PROVIDERS = ['openai', 'OpenAI', 'anthropic', 'Anthropic', 'xai', 'xAI', 'grok', 'hyperbolic', 'Hyperbolic API', 'openrouter', 'ollama', 'Open-source', 'google'];

const GATEWAY_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'HYPERBOLIC_API_KEY', 'OPENROUTER_API_KEY',
  'AI_GATEWAY', 'OPENAI_CLASS_PROVIDER', 'ANTHROPIC_CLASS_PROVIDER', 'XAI_CLASS_PROVIDER', 'HYPERBOLIC_CLASS_PROVIDER',
  'OPENAI_CLASS_MODEL', 'ANTHROPIC_CLASS_MODEL', 'OR_KEY',
];
const ENV_FILES = ['.env.production.local', '.env.local', '.env.production', '.env.development.local', '.env.development', '.env', '.run-mode'];

const lines = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

/** Gateway settings, written to .env.local one per line. */
const ENVS: Array<[string, Record<string, string>]> = [
  ['no keys', {}],
  ['every native key', { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', XAI_API_KEY: 'k', HYPERBOLIC_API_KEY: 'k' }],
  ['OpenRouter only', { OPENROUTER_API_KEY: 'k' }],
  ['every key', { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', XAI_API_KEY: 'k', HYPERBOLIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['GROK_API_KEY for xAI', { GROK_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['some native keys and OpenRouter', { OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['AI_GATEWAY=openrouter', { AI_GATEWAY: 'openrouter', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }],
  ['AI_GATEWAY=native', { AI_GATEWAY: 'native', OPENROUTER_API_KEY: 'k' }],
  ['AI_GATEWAY with case and spaces', { AI_GATEWAY: '"  OpenRouter "', OPENAI_API_KEY: 'k' }],
  ['AI_GATEWAY not a backend', { AI_GATEWAY: 'auto', OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }],
  ['a class sent to OpenRouter', { ANTHROPIC_CLASS_PROVIDER: 'openrouter', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }],
  ['a class kept native without its key', { OPENAI_CLASS_PROVIDER: 'native', OPENROUTER_API_KEY: 'k' }],
  ['a class override beats AI_GATEWAY', { AI_GATEWAY: 'openrouter', OPENAI_CLASS_PROVIDER: 'native', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }],
  ['a class override that is not a backend', { OPENAI_CLASS_PROVIDER: 'yes', OPENROUTER_API_KEY: 'k' }],
  ['a class model override', { ANTHROPIC_CLASS_MODEL: 'anthropic/claude-opus-5.5', OPENROUTER_API_KEY: 'k' }],
];

/** The files as an operator may write them: dotenv's comments, quotes, syntax, expansion, and Next's file order. */
const FILES: Array<[string, Record<string, string>]> = [
  ['an empty key with a comment after it', { '.env.local': 'OPENAI_API_KEY=k\nANTHROPIC_API_KEY=k\nOPENROUTER_API_KEY= # disabled\n' }],
  ['a commented-out key', { '.env.local': 'OPENAI_API_KEY=k\n# OPENROUTER_API_KEY=k\n#ANTHROPIC_API_KEY=k\n' }],
  ['an override with a comment after it', { '.env.local': 'OPENAI_API_KEY=k\nAI_GATEWAY=openrouter # route everything\n' }],
  ['a commented-out override', { '.env.local': 'OPENAI_API_KEY=k\nOPENROUTER_API_KEY=k\n# AI_GATEWAY=openrouter\n' }],
  ['whitespace, export and a colon', { '.env.local': '  export OPENAI_API_KEY = k  \nANTHROPIC_API_KEY: k\n\tOPENROUTER_API_KEY=\t\n' }],
  ['a quoted value keeps its #', { '.env.local': 'OPENROUTER_API_KEY="k # not a comment"\nAI_GATEWAY=\'native\' # a comment\n' }],
  ['CRLF line ends', { '.env.local': 'OPENAI_API_KEY=k\r\nAI_GATEWAY=openrouter\r\nOPENROUTER_API_KEY=\r\n' }],
  ['an expanded key', { '.env.local': 'OR_KEY=k\nOPENROUTER_API_KEY=${OR_KEY}\nOPENAI_API_KEY=$OR_KEY\n' }],
  ['a key expanded from nothing', { '.env.local': 'OPENROUTER_API_KEY=${MISSING}\nANTHROPIC_API_KEY=k\n' }],
  ['a key expanded with a default', { '.env.local': 'OPENROUTER_API_KEY=${MISSING:-k}\n' }],
  ['an escaped dollar', { '.env.local': 'OPENROUTER_API_KEY=k\\$v\nAI_GATEWAY=\\$native\n' }],
  ['a file that refers to itself fails to load whole', { '.env.local': 'OPENAI_API_KEY=k\nOPENROUTER_API_KEY=$OPENROUTER_API_KEY\n', '.env': 'ANTHROPIC_API_KEY=k\n' }],
  ['a key only in .env', { '.env.local': 'OPENAI_API_KEY=k\n', '.env': 'OPENROUTER_API_KEY=k\n' }],
  ['.env.local before .env', { '.env.local': 'AI_GATEWAY=native\nOPENROUTER_API_KEY=\n', '.env': 'AI_GATEWAY=openrouter\nOPENROUTER_API_KEY=k\n' }],
  ['.env.production.local before .env.local', { '.env.production.local': 'AI_GATEWAY=openrouter\n', '.env.local': 'AI_GATEWAY=native\nOPENAI_API_KEY=k\nOPENROUTER_API_KEY=k\n' }],
  ['.env.production in production', { '.env.production': 'OPENROUTER_API_KEY=k\n', '.env.development': 'OPENAI_API_KEY=k\n' }],
  ['next dev reads the development files', { '.run-mode': 'dev\n', '.env.development.local': 'OPENROUTER_API_KEY=k\n', '.env.production.local': 'AI_GATEWAY=native\n' }],
  ['the dev fallback reads them too', { '.run-mode': 'dev-fallback\n', '.env.development': 'AI_GATEWAY=openrouter\n', '.env.local': 'OPENAI_API_KEY=k\n' }],
  ['a later file expands from an earlier one', { '.env.local': 'OR_KEY=k\n', '.env': 'OPENROUTER_API_KEY=$OR_KEY\n' }],
  ['no env file at all', {}],
];

let install: string;
let aiNode: string;
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
const quiet = { info: () => {}, error: () => {} };

beforeAll(() => {
  install = fs.mkdtempSync(path.join(os.tmpdir(), 'code-jurors-'));
  aiNode = path.join(install, 'ai-node');
  const common = path.join(aiNode, 'node_modules', '@verdikta', 'common');
  fs.mkdirSync(common, { recursive: true });
  fs.writeFileSync(path.join(common, 'package.json'), JSON.stringify({ name: '@verdikta/common', version: '9.9.9-test', main: 'index.js' }));
  // A made-up panel with one juror per provider name: the check reads whatever the release has.
  const nodes = PROVIDERS.map((provider, i) => ({ AI_PROVIDER: provider, AI_MODEL: `model-${i}`, NO_COUNTS: 1, WEIGHT: 1 }));
  fs.writeFileSync(path.join(common, 'index.js'), `module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], CODE_STANDARD_PANEL: { AI_NODES: ${JSON.stringify(nodes)} } } };\n`);
  // Next's loader keeps the environment it first saw and starts each load from it: no gateway
  // setting of this process, and NODE_ENV as `next start` has it (jest's "test" reads other files).
  [...GATEWAY_KEYS, 'NODE_ENV', '__NEXT_PROCESSED_ENV'].forEach(key => { saved[key] = env[key]; delete env[key]; });
  env.NODE_ENV = 'production';
});

afterAll(() => {
  fs.rmSync(install, { recursive: true, force: true });
  Object.entries(saved).forEach(([key, value]) => {
    if (value === undefined) delete env[key];
    else env[key] = value;
  });
});

function writeFiles(files: Record<string, string>) {
  for (const name of ENV_FILES) fs.rmSync(path.join(aiNode, name), { force: true });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(aiNode, name), contents);
}

/** The doctor's answer for these files. It exits 1 when a juror has no route, and still prints them. */
function doctorRoutes(): any[] {
  let out: string;
  try {
    out = execFileSync(process.execPath, [CHECK, 'jurors', '--install-dir', install], { encoding: 'utf8', env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
  } catch (error: any) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  }
  return JSON.parse(out).jurors;
}

/** Next's environment for these files, as the AI Node would start with it, and the gateway's answer over it. */
function gatewayRoutes(files: Record<string, string>) {
  const runMode = (files['.run-mode'] || '').trim();
  loadEnvConfig(aiNode, runMode === 'dev' || runMode === 'dev-fallback', quiet, true);
  const has = (...keys: string[]) => keys.some(key => !!env[key]);
  const nativeKeys: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], xai: ['XAI_API_KEY', 'GROK_API_KEY'], hyperbolic: ['HYPERBOLIC_API_KEY'],
  };
  return PROVIDERS.map(provider => {
    try {
      const { providerClass, backend, reason } = resolveProviderConfig(provider);
      let served: boolean;
      if (providerClass === 'ollama') served = true;
      else if (backend === 'openrouter') served = has('OPENROUTER_API_KEY');
      else served = has(...nativeKeys[providerClass]);
      return { provider, providerClass, backend, reason, served };
    } catch {
      return { provider, providerClass: null, backend: null, reason: null, served: false };
    }
  });
}

const routeOf = (j: any) => ({ provider: j.provider, providerClass: j.providerClass, backend: j.backend, reason: j.reason, served: j.served });

describe('the doctor routes each juror as the AI Gateway does', () => {
  test.each(ENVS)('%s', (_name, settings) => {
    const files = { '.env.local': lines(settings) };
    writeFiles(files);
    const doctor = doctorRoutes();
    expect(doctor.map(j => j.provider)).toEqual(PROVIDERS);
    expect(doctor.map(routeOf)).toEqual(gatewayRoutes(files));
  });

  test('a juror on OpenRouter is served only with an OpenRouter key, a native one only with its own', () => {
    writeFiles({ '.env.local': lines({ OPENAI_API_KEY: 'k', AI_GATEWAY: 'openrouter' }) });
    const byProvider = Object.fromEntries(doctorRoutes().map(j => [j.provider, j]));
    expect(byProvider.openai).toMatchObject({ backend: 'openrouter', served: false });
    expect(byProvider.openrouter).toMatchObject({ backend: 'openrouter', served: false });
    expect(byProvider.google).toMatchObject({ providerClass: null, served: false });
    writeFiles({ '.env.local': lines({ OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }) });
    const native = Object.fromEntries(doctorRoutes().map(j => [j.provider, j]));
    expect(native.openai).toMatchObject({ backend: 'native', served: true, key: 'OPENAI_API_KEY' });
    expect(native.anthropic).toMatchObject({ backend: 'openrouter', served: true, key: 'OPENROUTER_API_KEY' });
    expect(native.openrouter).toMatchObject({ backend: 'openrouter', served: true, key: 'OPENROUTER_API_KEY' });
  });
});

describe('the doctor reads the AI Node\'s env files as Next does', () => {
  test.each(FILES)('%s', (_name, files) => {
    writeFiles(files);
    expect(doctorRoutes().map(routeOf)).toEqual(gatewayRoutes(files));
  });

  test('the cases above tell routes apart: an empty key with a comment after it leaves Gemini unserved', () => {
    writeFiles(FILES[0][1]);
    const gemini = doctorRoutes().find(j => j.provider === 'openrouter');
    expect(gemini).toMatchObject({ backend: 'openrouter', served: false });
  });
});
