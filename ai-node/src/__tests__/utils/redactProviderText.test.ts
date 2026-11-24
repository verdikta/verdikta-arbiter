/**
 * @jest-environment node
 *
 * redactProviderText: what a model provider said, made fit for a public justification record.
 *
 * 1. redactLogText is the doctor's redact_log (installer/util/arbiter-doctor.sh). The cases
 *    are installer/tests/doctor-redact.test.sh's, with its expected lines, and the real shell
 *    function is run on every line here and compared: the two cannot drift apart unseen.
 * 2. redactProviderText on provider messages: the 401 of bounty 398's record, each provider's
 *    key shape, masked and cut-short keys, ids; what a reader needs stays; a second pass
 *    changes nothing; the length limit never leaves part of a secret behind.
 *
 * Every fake secret is built when the test runs, so none is a literal in this file.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PROVIDER_TEXT_MAX_CHARS, redactLogText, redactProviderText } from '../../utils/redactProviderText';

const DOCTOR = path.resolve(__dirname, '../../../../installer/util/arbiter-doctor.sh');

const rep = (text: string, times: number) => text.repeat(times);
// The doctor test's fakes: low-entropy repeats.
const K32 = rep('f00d', 8);                                                   // Infura-style project id
const K64 = rep('beef', 16);                                                  // blockpi-style path key
const PW = rep('pw9', 6);
const JWT = `eyJ${rep('aGVsbG8', 3)}.eyJ${rep('d29ybGQ', 3)}.${rep('c2ln', 4)}`;
const B64 = `${rep('QmFzZTY0', 3)}+/==`;

// Provider keys, by shape. The prefixes are joined here so that no line of this file is one.
const SK = ['s', 'k', '-'].join('');
const OPENAI_KEY = `${SK}${rep('Ab1', 16)}`;
const OPENAI_PROJECT_KEY = `${SK}proj-${rep('Cd2_', 10)}${rep('Ef3-', 10)}Gh4`;
const ANTHROPIC_KEY = `${SK}ant-api03-${rep('Ij5-', 12)}${rep('Kl6_', 11)}AA`;
const OPENROUTER_KEY = `${SK}or-v1-${rep('0a1b', 16)}`;
const XAI_KEY = `xai-${rep('Mn7', 26)}`;
// OpenAI's own masking, as bounty 398's public record has it.
const BOUNTY_398_KEY = `${SK}ut1et***...***Zd9U`;
const BOUNTY_398 = `401 Incorrect API key provided: ${BOUNTY_398_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`;
const REQUEST_ID = `req_${rep('01Cs', 6)}`;
const ORG_ID = `org-${rep('Qr8', 8)}`;
const UUID = `${rep('1a', 4)}-${rep('2b', 2)}-${rep('3c', 2)}-${rep('4d', 2)}-${rep('5e', 6)}`;

/** Every 5-character piece of a secret's body: none may survive. */
function pieces(secret: string, size = 5): string[] {
  const body = secret.replace(/^(?:sk-(?:proj-|ant-api03-|or-v1-)?|xai-|req_|org-)/, '');
  const out = new Set<string>();
  for (let i = 0; i + size <= body.length; i++) out.add(body.slice(i, i + size));
  return [...out];
}

function expectNoPieceOf(output: string, secret: string) {
  for (const piece of pieces(secret)) expect(output).not.toContain(piece);
}

// [name, input, redact_log's output], from doctor-redact.test.sh.
const DOCTOR_CASES: Array<[string, string, string]> = [
  ['infura https', `https://base-sepolia.infura.io/v3/${K32}`, 'https://base-sepolia.infura.io/<redacted>'],
  ['infura wss', `wss://base-sepolia.infura.io/ws/v3/${K32}`, 'wss://base-sepolia.infura.io/<redacted>'],
  ['blockpi path key', `https://base-sepolia.blockpi.network/v1/rpc/${K64}`, 'https://base-sepolia.blockpi.network/<redacted>'],
  ['ws with a port', `ws://rpc.example.net:8546/${K32}`, 'ws://rpc.example.net:8546/<redacted>'],
  ['query key', `https://rpc.example.net?apikey=${K32}#frag`, 'https://rpc.example.net/<redacted>'],
  ['upper-case scheme', `HTTPS://RPC.EXAMPLE.NET/v3/${K32}`, 'HTTPS://RPC.EXAMPLE.NET/<redacted>'],
  ['userinfo', `url=https://user:${PW}@rpc.example.net:8545/path end`, 'url=https://rpc.example.net:8545/<redacted> end'],
  ['userinfo with @, no path', `wss://user:p@${PW}@rpc.example.net`, 'wss://rpc.example.net/<redacted>'],
  ['another scheme\'s userinfo', `postgresql://postgres:${PW}@cl-postgres:5432/postgres?sslmode=disable`, 'postgresql://<redacted>@cl-postgres:5432/postgres?sslmode=disable'],
  [
    'a Chainlink line',
    `2026-11-07T01:02:03.000Z [ERROR] RPC failed {"node":"(primary)primary-0:wss://base-sepolia.infura.io/ws/v3/${K32}:https://base-sepolia.infura.io/v3/${K32}","err":"Post \\"https://base-sepolia.blockpi.network/v1/rpc/${K64}\\": dial tcp"}`,
    '2026-11-07T01:02:03.000Z [ERROR] RPC failed {"node":"(primary)primary-0:wss://base-sepolia.infura.io/<redacted>","err":"Post \\"https://base-sepolia.blockpi.network/<redacted>\\": dial tcp"}',
  ],
  ['a psql row', `1|0|fatal_error|Post https://rpc.example.net/v3/${K32}|2026-11-07 12:00:00+00`, '1|0|fatal_error|Post https://rpc.example.net/<redacted>|2026-11-07 12:00:00+00'],
  ['a psql row, userinfo', `x|https://user:${PW}@rpc.example.net|y`, 'x|https://rpc.example.net/<redacted>|y'],
  ['single-quoted url', `{ url: 'https://gw.example.net/ipfs/Qm1?pinataGatewayToken=${K32}', x: 1 }`, '{ url: \'https://gw.example.net/<redacted>\', x: 1 }'],
  [
    'key= and token=',
    `apikey=${K32} token="${K64}" api_key='${B64}' IPFS_PINNING_KEY=${JWT} access_token=${K32}`,
    'apikey=<redacted> token="<redacted>" api_key=\'<redacted>\' IPFS_PINNING_KEY=<redacted> access_token=<redacted>',
  ],
  ['quoted key', `{"apiKey":"${K64}","x":1} { authToken: '${B64}' }`, '{"apiKey":"<redacted>","x":1} { authToken: \'<redacted>\' }'],
  ['bearer', `Authorization: Bearer ${JWT}`, 'Authorization: Bearer <redacted>'],
  ['a bare JWT', `headers {x-auth: ${JWT}}`, 'headers {x-auth: <redacted-jwt>}'],
];

// What redact_log keeps, from the same test.
const DOCTOR_KEEPS = [
  'https://mainnet.base.org is up',
  'key=short token=abc',
  'node key: 0x1111111111111111111111111111111111111111',
  '2026-11-07T01:02:03.000Z [CRIT] No live RPC nodes available',
  'RPC endpoint detected out of sync; Invalid params',
];

// More lines for the comparison with the shell function: provider messages and the edges of each expression.
const MORE_LINES = [
  BOUNTY_398,
  `[OpenRouter] HTTP 401: {"error":{"message":"No auth credentials found","code":401}} see https://openrouter.ai/docs/errors#401`,
  `Post "https://api.example.net/v1/chat?api_key=${K32}&x=1": context deadline exceeded`,
  `GET https://user@host.example/a b https://host.example:8443?x=${K32} c`,
  `ftp://anonymous:${PW}@files.example.net/pub and redis://:${PW}@cache:6379/0`,
  `WSS://U:${PW}@RPC.EXAMPLE.NET/ws`,
  `token=${K32}== key='${K32}' KEY=${K32} Token=${K32}`,
  `"private_key" : "${K64}" 'secretToken':'${K64}' token: ${K64}`,
  `bearer ${K32} BEARER\t${K32} Bearer short`,
  `two ${JWT} and ${JWT}.`,
  `https://a.example/x,https://b.example/y;https://c.example#z`,
  `<https://a.example/in/brackets> "https://b.example/in/quotes" (https://c.example/in/parens)`,
  'https://[::1]:8545/path and http://127.0.0.1:6688/health',
  'no secrets here: Model timed out after 120000ms (HTTP 504)',
  // The two expressions written out rather than ported: a scheme before "://...@", and a JWT.
  '1a2://u:p@h x 123://u:p@h a+b.c-d://user@host/path ://u@h x ://v@h',
  'a://u@b://v@h foo://bar scheme://u@ mailto:user@example.com -x://u@h .y://u@h',
  'eyJaaaaaaaa.b.eyJcccccccc.dddddddd.eeeeeeee xxeyJaaaaaaaa.bbbbbbbb.cccccccc.dddddddd',
  'eyJshort.bbbbbbbb.cccccccc eyJaaaaaaaa.bbbbbbbb.cccccccc. eyJaaaaaaa.bbbbbbbb.cccccccc eyJaaaaaaaa.bbbbbbbb.ccccccc',
  'a.eyJaaaaaaaa.bbbbbbbb.cccccccc.eyJdddddddd.eeeeeeee.ffffffff eyJaaaaaaaaeyJbbbbbbbb.cccccccc.dddddddd',
  'eyJ.eyJaaaaaaaa.bbbbbbbb ..eyJaaaaaaaa..bbbbbbbb.cccccccc eyJaaaaaaaa.bbbb_bb-b.cccccccc/eyJaaaaaaaa.bbbbbbbb.cccccccc',
];

/** Lines made of the pieces the expressions look at, from a fixed seed. */
function generatedLines(count: number): string[] {
  const pieces = [
    'http', 'https', 'HTTPS', 'ws', 'wss', 'ftp', 'postgresql', 'a', 'b2', '1', '+', '-', '.', '://', ':', '/', '//', '?', '#', '@', '@@',
    'user', 'pass', 'host.example', 'h', ':8545', ' ', ' ', '\t', '"', '\'', '\\', '<', '>', '|', '=', '==', ',', ';', '(', ')', '{', '}',
    'key', 'Key', 'KEY', 'token', 'Token', 'apikey', 'api_key', 'Bearer', 'bearer', 'BEARER',
    'eyJ', 'eyJaaaaaaaa', 'bbbbbbbb', 'ccccccc', 'dddddddddddddddd', K32.slice(0, 16), 'abc', 'x', '0123456789abcdef0123', '_', '~', '*', '<redacted>', 'é', '…',
  ];
  let seed = 20261123;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(next() * 14);
    return Array.from({ length }, () => pieces[Math.floor(next() * pieces.length)]).join('');
  });
}

describe('redactLogText is the doctor\'s redact_log', () => {
  test.each(DOCTOR_CASES)('%s', (_name, input, expected) => {
    expect(redactLogText(input)).toBe(expected);
  });

  test('a comma-separated list, as installer/.env keeps them', () => {
    const out = redactLogText(`BASE_SEPOLIA_RPC_HTTP_URLS="https://a.example/v3/${K32},https://b.example/rpc/${K64}"`);
    expect(out).not.toContain(K32);
    expect(out).not.toContain(K64);
    expect(out).toContain('https://a.example/<redacted>');
  });

  test.each(DOCTOR_KEEPS)('keeps: %s', line => {
    expect(redactLogText(line)).toBe(line);
  });

  test('the Chainlink line is still JSON afterwards', () => {
    const out = redactLogText(DOCTOR_CASES.find(([name]) => name === 'a Chainlink line')![1]);
    expect(() => JSON.parse(out.split(' RPC failed ', 2)[1])).not.toThrow();
  });

  test('line for line, the same output as the shell function in arbiter-doctor.sh', () => {
    const source = fs.readFileSync(DOCTOR, 'utf8');
    const fn = /^redact_log\(\) \{\n[\s\S]*?\n\}$/m.exec(source);
    expect(fn).not.toBeNull();
    const lines = [...DOCTOR_CASES.map(([, input]) => input), ...DOCTOR_KEEPS, ...MORE_LINES, ...generatedLines(4000)];
    lines.forEach(line => expect(line).not.toContain('\n'));
    const out = execFileSync('bash', ['-c', `${fn![0]}\nredact_log`], { input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 26 });
    const shell = out.split('\n').slice(0, -1);
    expect(shell).toHaveLength(lines.length);
    lines.forEach((line, i) => expect(redactLogText(line)).toBe(shell[i]));
    // sed reads a line at a time: a text of many lines is each of its lines, redacted.
    expect(redactLogText(lines.join('\n'))).toBe(shell.join('\n'));
  });
});

describe('redactProviderText: a provider\'s message in a public record', () => {
  test('bounty 398: the 401 that quoted the key', () => {
    const out = redactProviderText(BOUNTY_398);
    expect(out).toBe('401 Incorrect API key provided: <redacted>. You can find your API key at https://platform.openai.com/<redacted>');
    expect(out).not.toContain(SK);
    expect(out).not.toContain('ut1et');
    expect(out).not.toContain('Zd9U');
    expect(out).not.toContain('api-keys');
  });

  test.each([
    ['an OpenAI key', OPENAI_KEY],
    ['an OpenAI project key', OPENAI_PROJECT_KEY],
    ['an Anthropic key', ANTHROPIC_KEY],
    ['an OpenRouter key', OPENROUTER_KEY],
    ['an xAI key', XAI_KEY],
  ])('%s, whole, wherever it stands', (_name, key) => {
    for (const text of [
      `Incorrect API key provided: ${key}.`,
      `{"error":{"message":"invalid key ${key}","code":"invalid_api_key"}}`,
      `x-api-key:${key}`,
      `(${key})`,
      `key ${key}, retry`,
      key,
    ]) {
      const out = redactProviderText(text);
      expectNoPieceOf(out, key);
      expect(out).toContain('<redacted>');
      expect(out).not.toContain(SK);
      expect(out).not.toContain('xai-');
    }
  });

  test('a key the provider masked is still part of the key', () => {
    expect(redactProviderText(`Incorrect API key provided: xa***Xy. You can obtain an API key from https://console.x.ai.`))
      .toBe('Incorrect API key provided: <redacted>. You can obtain an API key from https://console.x.ai.');
    expect(redactProviderText(`key ${SK}abcde${rep('*', 40)}wxyz rejected`)).toBe('key <redacted> rejected');
    expect(redactProviderText(`key ${rep('*', 28)}wxyz rejected`)).toBe('key <redacted> rejected');
    expect(redactProviderText(`key ${SK}...wxyz rejected`)).toBe('key <redacted> rejected');
    expect(redactProviderText(`key xai-...wxyz rejected`)).toBe('key <redacted> rejected');
  });

  test('a Bearer value, a JWT, and a URL with the key in its query or userinfo', () => {
    expect(redactProviderText(`sent Authorization: Bearer ${K64}`)).toBe('sent Authorization: Bearer <redacted>');
    expect(redactProviderText(`token ${JWT} expired`)).toBe('token <redacted-jwt> expired');
    expect(redactProviderText(`GET https://api.example.net/v1/models?key=${K32} failed`)).toBe('GET https://api.example.net/<redacted> failed');
    expect(redactProviderText(`GET https://user:${PW}@api.example.net failed`)).toBe('GET https://api.example.net/<redacted> failed');
  });

  test('request and organization ids, hashes', () => {
    expect(redactProviderText(`{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"${REQUEST_ID}"}`))
      .toBe('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"<redacted>"}');
    expect(redactProviderText(`Rate limit reached for gpt-4o in organization ${ORG_ID} on tokens per min (TPM): Limit 30000, Used 29000`))
      .toBe('Rate limit reached for gpt-4o in organization <redacted> on tokens per min (TPM): Limit 30000, Used 29000');
    expect(redactProviderText(`request ${UUID} failed`)).toBe('request <redacted> failed');
    expect(redactProviderText(`sha256 ${rep('0a1b', 16)} differs`)).toBe('sha256 <redacted> differs');
    expect(redactProviderText(`opaque ${K64} and ${rep('Zy', 20)}.`)).toBe('opaque <redacted> and <redacted>.');
  });

  test.each([
    'Model xAI-grok-4 timed out after 120000ms',
    'Model OpenAI-gpt-5.6-terra timed out after 120000ms',
    '400 `temperature` is deprecated for this model.',
    'The model `gpt-4o-mini-search-preview-2025-03-11` does not exist or you do not have access to it.',
    'model: claude-3-5-sonnet-20241022 (anthropic/claude-sonnet-4-5-20250929) is overloaded',
    'meta-llama/Meta-Llama-3.1-405B-Instruct is not available',
    '[OpenRouter] OPENROUTER_API_KEY not configured',
    'JUSTIFIER_MODEL is not set as provider:model',
    'unsupported_country_region_territory: request not allowed (context_length_exceeded)',
    'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 301245 tokens.',
    'OpenAI rejected an image attachment for gpt-5 (HTTP 400): image exceeding the limit of 30000 patches',
    'gave no usable scores, also after the repair call',
    'no answer within the 255000 ms the deadline leaves the jury; the call was cancelled',
    'Unable to parse response: **Verdict**: the submission meets 3 of 4 criteria...',
    'You can obtain an API key from https://console.x.ai.',
    'key=short token=abc',
    '',
  ])('keeps: %s', text => {
    expect(redactProviderText(text)).toBe(text);
  });

  test('a second pass changes nothing', () => {
    const texts = [
      ...DOCTOR_CASES.map(([, input]) => input), ...DOCTOR_KEEPS, ...MORE_LINES,
      `a ${OPENAI_KEY} b ${ANTHROPIC_KEY} c ${XAI_KEY} d ${REQUEST_ID}`,
      rep(`x ${OPENROUTER_KEY} https://h.example/p/${K32} `, 40),      // cut at the limit
      rep('long text without a secret ', 60),
      rep('long text without a secret ', 2000),                       // cut where reading stops
    ];
    for (const text of texts) {
      const once = redactProviderText(text);
      expect(redactProviderText(once)).toBe(once);
    }
  });

  test(`at most ${PROVIDER_TEXT_MAX_CHARS} characters, and the cut never leaves part of a secret`, () => {
    const plain = redactProviderText(rep('word ', 400));
    expect(plain.length).toBeLessThanOrEqual(PROVIDER_TEXT_MAX_CHARS);
    expect(plain.length).toBeGreaterThan(PROVIDER_TEXT_MAX_CHARS - 10);
    expect(plain).toMatch(/^(?:word )+… \[truncated\]$/);     // cut between words
    const exact = rep('word ', 100).trimEnd();                 // 499 characters: nothing to cut
    expect(redactProviderText(exact)).toBe(exact);
    expect(redactProviderText(rep('{"a":1,', 200))).toHaveLength(PROVIDER_TEXT_MAX_CHARS);   // no space to cut at
    expect(redactProviderText(`a https://h.example/${rep('p/', 400)} b`, 30)).toBe('a … [truncated]');  // not half a mark
    // A key at every offset around the limit: redaction comes before the cut.
    for (let lead = PROVIDER_TEXT_MAX_CHARS - 80; lead <= PROVIDER_TEXT_MAX_CHARS + 5; lead += 3) {
      const out = redactProviderText(`${rep('z', lead - 1)} ${ANTHROPIC_KEY} tail https://h.example/p?key=${K32}`);
      expect(out.length).toBeLessThanOrEqual(PROVIDER_TEXT_MAX_CHARS);
      expectNoPieceOf(out, ANTHROPIC_KEY);
      expect(out).not.toContain(SK);
      expect(out).not.toContain(K32.slice(0, 8));
    }
    expect(redactProviderText(`a ${OPENAI_KEY} b`, 4000)).toBe('a <redacted> b');
  });

  test('megabytes take no time: every step is linear, and only the start of a message is read', () => {
    // Each of these made a regex engine rescan the token from every letter (a direct port of
    // the doctor's expressions took minutes on the first).
    const hostile = [
      `echo: ${rep('QmFzZTY0', 150000)} end`,
      `echo: ${rep('eyJ', 400000)} end`,
      `echo: ${rep('eyJ', 3000)}.${rep('eyJ', 3000)} end`,
      `echo: ${rep('*', 1200000)} end`,
      `echo: ${rep('a.', 600000)} end`,
      `echo: ${rep('http://', 200000)} end`,
      `echo: ${rep('key', 400000)} end`,
      rep(' ', 1200000),
    ];
    const started = Date.now();
    const outs = hostile.map(text => redactProviderText(text));
    expect(Date.now() - started).toBeLessThan(2000);
    outs.forEach(out => expect(out.length).toBeLessThanOrEqual(PROVIDER_TEXT_MAX_CHARS));
    // A token the input limit falls in is dropped whole.
    expect(outs[0]).toBe('echo: … [truncated]');
    // The same shapes, short enough to be read whole.
    expect(redactProviderText(`echo: ${rep('QmFzZTY0', 1500)} end`)).toBe('echo: <redacted> end');
    expect(redactProviderText(`echo: ${rep('*', 9000)} end`)).toBe('echo: <redacted> end');
    const startedLog = Date.now();
    hostile.forEach(text => redactLogText(text));
    expect(Date.now() - startedLog).toBeLessThan(4000);
  });

  test('a message longer than what is read never leaves half a key at the cut', () => {
    for (let lead = 19990; lead <= 20002; lead++) {
      const out = redactProviderText(`${rep('a ', lead / 2)}${lead % 2 ? ' ' : ''}${ANTHROPIC_KEY} tail`, 100000);
      expectNoPieceOf(out, ANTHROPIC_KEY);
      expect(out).not.toContain(SK);
      expect(out.endsWith('… [truncated]')).toBe(true);
    }
  });

  test('what is not a string', () => {
    expect(redactProviderText(undefined)).toBe('');
    expect(redactProviderText(null)).toBe('');
    expect(redactProviderText(429)).toBe('429');
    expect(redactProviderText(new Error(`refused ${OPENAI_KEY}`))).toBe('Error: refused <redacted>');
    expect(redactProviderText({ toString: () => `obj ${XAI_KEY}` })).toBe('obj <redacted>');
  });
});
