/**
 * Node A6c, decision D9: the canary fault switch on the AI Node, as a unit. It acts only on a
 * directive the External Adapter minted (the EA measures the class; this process has no chain
 * access), and what it can do is wait: a hold takes a signal and gives nothing back.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CANARY_FAULT_KEY_ENV,
  NO_HOLDS,
  canaryFaultState,
  directiveMac,
  holdsFor,
  readCanaryDirective,
} from '../../../lib/code-review/canary-fault';

const env = process.env as Record<string, string | undefined>;
const KEY = 'k'.repeat(48);
const BINDING = { bcid: 'QmClaim', reportSha256: 'a'.repeat(64) };
const mac = (action: string, key = KEY, binding = BINDING) => directiveMac(key, action, binding.bcid, binding.reportSha256);

let saved: string | undefined;

beforeEach(() => {
  saved = env[CANARY_FAULT_KEY_ENV];
  delete env[CANARY_FAULT_KEY_ENV];
});

afterEach(() => {
  if (saved === undefined) delete env[CANARY_FAULT_KEY_ENV];
  else env[CANARY_FAULT_KEY_ENV] = saved;
});

describe('the state', () => {
  test('off with no key', () => {
    expect(canaryFaultState()).toBe('off');
  });

  test.each([['blank', ''], ['spaces', '   ']])('off with a %s key', (_name, value) => {
    env[CANARY_FAULT_KEY_ENV] = value;
    expect(canaryFaultState()).toBe('off');
  });

  test('armed with a usable key', () => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    expect(canaryFaultState()).toBe('armed');
  });

  test.each([['short', 'short'], ['with a space', `${KEY} x`]])('refused with a %s key: it never acts', (_name, value) => {
    env[CANARY_FAULT_KEY_ENV] = value;
    expect(canaryFaultState()).toBe('refused');
    expect(readCanaryDirective({ action: 'late-juror', mac: directiveMac(value, 'late-juror', BINDING.bcid, BINDING.reportSha256) }, BINDING)).toBeNull();
  });
});

describe('a directive', () => {
  test('with no key, even a well-formed one is nothing', () => {
    expect(readCanaryDirective({ action: 'late-juror', mac: mac('late-juror') }, BINDING)).toBeNull();
  });

  test.each(['hold-juror-answer', 'late-juror', 'hold-justifier-answer'])('%s verifies with the key', (action) => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    expect(readCanaryDirective({ action, mac: mac(action) }, BINDING)).toBe(action);
  });

  test.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'late-juror'],
    ['an array', ['late-juror']],
    ['no MAC', { action: 'late-juror' }],
    ['no action', { mac: 'a'.repeat(64) }],
    ['a MAC under another key', { action: 'late-juror', mac: directiveMac(`${KEY}x`, 'late-juror', BINDING.bcid, BINDING.reportSha256) }],
    ['a MAC for another action', { action: 'late-juror', mac: mac('hold-juror-answer') }],
    ['a MAC for another claim', { action: 'late-juror', mac: mac('late-juror', KEY, { ...BINDING, bcid: 'QmOther' }) }],
    ['a MAC for another report', { action: 'late-juror', mac: mac('late-juror', KEY, { ...BINDING, reportSha256: 'b'.repeat(64) }) }],
    ['a MAC that is not hex', { action: 'late-juror', mac: 'z'.repeat(64) }],
    ['a short MAC', { action: 'late-juror', mac: 'a' }],
    ['a number for a MAC', { action: 'late-juror', mac: 5 }],
    ['an action nobody defined, signed', { action: 'drop-the-score', mac: mac('drop-the-score') }],
    ['an action from Object.prototype, signed', { action: 'constructor', mac: mac('constructor') }],
    ['a field beside them', { action: 'late-juror', mac: mac('late-juror'), scores: [1, 0] }],
  ])('%s is refused', (_name, raw) => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    expect(readCanaryDirective(raw, BINDING)).toBeNull();
  });

  test('the shared vector: the EA holds the same value (external-adapter/src/__tests__/canaryFault/switch.test.js)', () => {
    expect(directiveMac('k'.repeat(32), 'late-juror', 'QmVector', 'd'.repeat(64))).toBe('fc348eff335597039bd6199da408b303e74090ef9a140030648314dd1b893b41');
  });
});

describe('holds', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  const times = { juryDeadlineAt: 240000 };
  const settled = async (promise: Promise<void>) => {
    let state = 'pending';
    promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
    await jest.advanceTimersByTimeAsync(0);
    return state;
  };

  beforeEach(() => jest.setSystemTime(0));

  test('no directive: every point resolves at once', async () => {
    const { signal } = new AbortController();
    await NO_HOLDS.beforeFirstJuror(signal);
    await NO_HOLDS.afterFirstJuror(signal);
    await NO_HOLDS.afterJustifier(signal, 45000);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('hold-juror-answer waits until five seconds before the jury deadline, and only there', async () => {
    const holds = holdsFor('hold-juror-answer', times);
    const { signal } = new AbortController();
    await holds.beforeFirstJuror(signal);
    const held = holds.afterFirstJuror(signal);
    await jest.advanceTimersByTimeAsync(234999);
    expect(await settled(held)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(held)).toBe('resolved');
    await holds.afterJustifier(signal, 300000);
  });

  test('late-juror starts the call three seconds before the jury deadline, then holds any answer to the abort', async () => {
    const holds = holdsFor('late-juror', times);
    const controller = new AbortController();
    const start = holds.beforeFirstJuror(controller.signal);
    await jest.advanceTimersByTimeAsync(236999);
    expect(await settled(start)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(start)).toBe('resolved');
    const after = holds.afterFirstJuror(controller.signal);
    await jest.advanceTimersByTimeAsync(600000);
    expect(await settled(after)).toBe('pending');
    controller.abort();
    expect(await settled(after)).toBe('rejected');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('hold-justifier-answer waits until five seconds before the justifier\'s end', async () => {
    const holds = holdsFor('hold-justifier-answer', times);
    const { signal } = new AbortController();
    await holds.beforeFirstJuror(signal);
    await holds.afterFirstJuror(signal);
    const held = holds.afterJustifier(signal, 45000);
    await jest.advanceTimersByTimeAsync(39999);
    expect(await settled(held)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(held)).toBe('resolved');
  });

  test('a time already past: nothing to wait for', async () => {
    jest.setSystemTime(300000);
    const holds = holdsFor('hold-juror-answer', times);
    await holds.afterFirstJuror(new AbortController().signal);
  });

  test('an abort ends a hold at once and clears its timer, and a hold on a signal already aborted never starts one', async () => {
    const holds = holdsFor('hold-juror-answer', times);
    const controller = new AbortController();
    const held = holds.afterFirstJuror(controller.signal);
    controller.abort();
    expect(await settled(held)).toBe('rejected');
    expect(jest.getTimerCount()).toBe(0);
    await expect(holds.afterFirstJuror(controller.signal)).rejects.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a hold takes a signal and gives back nothing it could change', async () => {
    const holds = holdsFor('hold-juror-answer', times);
    expect(holds.beforeFirstJuror.length).toBe(1);
    expect(holds.afterFirstJuror.length).toBe(1);
    expect(holds.afterJustifier.length).toBe(2);
    const { signal } = new AbortController();
    jest.setSystemTime(300000);
    await expect(holds.afterFirstJuror(signal)).resolves.toBeUndefined();
  });
});

describe('from the sources: where it sits and who reads it', () => {
  const SRC = path.join(__dirname, '..', '..', '..');
  const MODULE = path.join(SRC, 'lib', 'code-review', 'canary-fault.ts');

  function filesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
      return entry.isDirectory() ? filesUnder(file) : [file];
    });
  }

  test('the key is named in one file under src/', () => {
    const naming = filesUnder(SRC).filter(file => fs.readFileSync(file, 'latin1').includes('VERDIKTA_CANARY_FAULT'));
    expect(naming.map(file => path.relative(SRC, file))).toEqual(['lib/code-review/canary-fault.ts']);
  });

  test('it is read through a computed name, which next build cannot inline', () => {
    const text = fs.readFileSync(MODULE, 'utf8');
    expect(text).toContain('process.env[CANARY_FAULT_KEY_ENV]');
    expect(text).not.toMatch(/process\.env\.VERDIKTA/);
  });

  test('next.config does not put it in the build', () => {
    const config = fs.readFileSync(path.join(SRC, '..', 'next.config.mjs'), 'utf8');
    expect(config).not.toMatch(/VERDIKTA_CANARY/);
  });

  test('the module imports crypto and nothing else', () => {
    const imports = [...fs.readFileSync(MODULE, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports).toEqual(['crypto']);
  });

  test('what builds the prompt and the vector does not import it', () => {
    for (const name of ['claim-prompt.ts', 'deadline.ts']) {
      expect(fs.readFileSync(path.join(SRC, 'lib', 'code-review', name), 'utf8')).not.toMatch(/canary/i);
    }
  });

  test('the jury calls a hold with the signal and no value', () => {
    const jury = fs.readFileSync(path.join(SRC, 'lib', 'code-review', 'jury.ts'), 'utf8');
    const calls = [...jury.matchAll(/holds\.(\w+)\(([^)]*)\)/g)].map(m => [m[1], m[2]]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const [point, args] of calls) {
      if (point === 'afterJustifier') expect(args).toMatch(/^controller\.signal, endsAt$/);
      else expect(args).toBe('signal');
    }
  });

  test('the text-mode route never reads it', () => {
    const route = fs.readFileSync(path.join(SRC, 'app', 'api', 'rank-and-justify', 'route.ts'), 'utf8');
    expect(route).not.toMatch(/canary/i);
  });
});

test('the MAC is HMAC-SHA256 over a fixed form', () => {
  const expected = crypto.createHmac('sha256', KEY).update('verdikta-canary-fault/1\nlate-juror\nQmClaim\n' + 'a'.repeat(64)).digest('hex');
  expect(mac('late-juror')).toBe(expected);
});
