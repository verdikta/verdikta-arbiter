'use strict';

/**
 * forge's JUnit, read strictly (design §9.1: JUnit XML is parsed with entity
 * expansion off).
 *
 * The JUnit is tier-B evidence: forge writes it from the process that runs
 * the claim's code (§9.5). This parser accepts only the subset of XML forge
 * writes, and anything outside it makes the JUnit unreadable, which the
 * reproduces gate counts as an error on that run, never as a test result:
 *
 * - UTF-8 only, no byte-order mark; an XML declaration only at the start;
 * - no DOCTYPE, so no entity can be declared, internal or external: entity
 *   expansion is off by construction. The five predefined entities and
 *   character references to legal XML characters are decoded; any other
 *   `&name;` is a well-formedness error;
 * - no comments, CDATA sections or other processing instructions;
 * - exactly one root element and nothing but whitespace around it, so bytes
 *   a test wrote straight to forge's stdout (a second document, text before
 *   or after) never become records;
 * - caps on the input size, nesting depth, element count and attributes per
 *   element; one linear pass, no backtracking, no recursion.
 *
 * A test that prints XML through console.log cannot add records either:
 * forge escapes it into a <system-out>, whose text is never read as markup.
 */

/** forge's JUnit for one PoC run must fit in this; a longer one is unreadable. */
const JUNIT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_ELEMENTS = 100000;
const MAX_ATTRIBUTES = 32;
const MAX_NAME = 256;
/** Text kept per element (system-out), for later integrity checks; the rest is checked and dropped. */
const MAX_TEXT_KEPT = 4096;

const PREDEFINED = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' });
/** Characters XML 1.0 forbids in a document (C0 controls other than tab, LF and CR; U+FFFE, U+FFFF). */
const ILLEGAL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

class XmlError extends Error {}

function legalCodePoint(cp) {
  return cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 58;
}

function isSpace(c) {
  return c === 0x20 || c === 0x9 || c === 0xA || c === 0xD;
}

/**
 * Parse the XML subset above.
 * @param {Buffer} bytes
 * @param {{maxBytes?:number}} [o]
 * @returns {{ok:true, root:object} | {ok:false, reason:string}}
 *   an element is { name, attrs (null-prototype object), children: element[], text (at most 4 KiB kept),
 *   nonBlank (it holds text other than whitespace) }
 */
function parseXml(bytes, { maxBytes = JUNIT_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'no bytes' };
  if (bytes.length > maxBytes) return { ok: false, reason: `the JUnit exceeds ${maxBytes} bytes` };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, reason: 'the JUnit starts with a byte-order mark' };
  }
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (_) {
    return { ok: false, reason: 'the JUnit is not valid UTF-8' };
  }
  if (ILLEGAL_CHAR.test(s)) return { ok: false, reason: 'the JUnit contains a character XML does not allow' };
  try {
    return { ok: true, root: new Parser(s).document() };
  } catch (err) {
    if (err instanceof XmlError) return { ok: false, reason: err.message };
    throw err;
  }
}

class Parser {
  constructor(s) {
    this.s = s;
    this.i = 0;
    this.elements = 0;
  }

  fail(what) {
    throw new XmlError(`${what} at offset ${this.i}`);
  }

  skipSpace() {
    const s = this.s;
    while (this.i < s.length && isSpace(s.charCodeAt(this.i))) this.i += 1;
  }

  document() {
    if (this.s.startsWith('<?xml')) this.declaration();
    this.skipSpace();
    if (this.i >= this.s.length) this.fail('no root element');
    const root = this.elementTree();
    this.skipSpace();
    if (this.i !== this.s.length) this.fail('content after the root element');
    return root;
  }

  declaration() {
    this.i = 5;
    const attrs = this.attributes('?>');
    if (!this.s.startsWith('?>', this.i)) this.fail('an unterminated XML declaration');
    this.i += 2;
    if (attrs.version !== '1.0') this.fail('an XML declaration without version 1.0');
    for (const k of Object.keys(attrs)) {
      if (!['version', 'encoding', 'standalone'].includes(k)) this.fail(`an XML declaration with ${k}`);
    }
    if (attrs.encoding !== undefined && attrs.encoding.toLowerCase() !== 'utf-8') this.fail(`encoding ${attrs.encoding} (only UTF-8)`);
  }

  name() {
    const s = this.s;
    const start = this.i;
    if (start >= s.length || !isNameStart(s.charCodeAt(start))) this.fail('a missing or invalid name');
    let j = start + 1;
    while (j < s.length && isNameChar(s.charCodeAt(j))) j += 1;
    if (j - start > MAX_NAME) this.fail('a name longer than 256 characters');
    this.i = j;
    return s.slice(start, j);
  }

  /** Attributes up to `>`, `/>` or (for the declaration) `?>`. */
  attributes(endDecl) {
    const s = this.s;
    const attrs = Object.create(null);
    let count = 0;
    for (;;) {
      const before = this.i;
      this.skipSpace();
      const c = s.charCodeAt(this.i);
      if (c === 62 /* > */ || (c === 47 /* / */ && s.charCodeAt(this.i + 1) === 62)) return attrs;
      if (endDecl && s.startsWith(endDecl, this.i)) return attrs;
      if (this.i === before) this.fail('attributes without whitespace between them');
      const key = this.name();
      this.skipSpace();
      if (s.charCodeAt(this.i) !== 61 /* = */) this.fail(`attribute ${key} without a value`);
      this.i += 1;
      this.skipSpace();
      const q = s.charCodeAt(this.i);
      if (q !== 34 && q !== 39) this.fail(`attribute ${key} whose value is not quoted`);
      const close = s.indexOf(q === 34 ? '"' : '\'', this.i + 1);
      if (close < 0) this.fail(`attribute ${key} whose value is not terminated`);
      const raw = s.slice(this.i + 1, close);
      if (raw.includes('<')) this.fail(`attribute ${key} whose value contains <`);
      if (key in attrs) this.fail(`a repeated attribute ${key}`);
      count += 1;
      if (count > MAX_ATTRIBUTES) this.fail(`more than ${MAX_ATTRIBUTES} attributes on one element`);
      // XML 1.0 §3.3.3: literal whitespace in an attribute value reads as a space.
      attrs[key] = this.decode(raw, this.i + 1).replace(/[\t\n\r]/g, ' ');
      this.i = close + 1;
    }
  }

  /** Decode the references in a run of character data. */
  decode(raw, offset) {
    if (!raw.includes('&')) return raw;
    const out = [];
    let k = 0;
    while (k < raw.length) {
      const amp = raw.indexOf('&', k);
      if (amp < 0) { out.push(raw.slice(k)); break; }
      out.push(raw.slice(k, amp));
      const semi = raw.indexOf(';', amp + 1);
      if (semi < 0 || semi - amp > 12) { this.i = offset + amp; this.fail('an unterminated or overlong reference'); }
      const ref = raw.slice(amp + 1, semi);
      if (ref.startsWith('#')) {
        const hex = ref[1] === 'x';
        const digits = ref.slice(hex ? 2 : 1);
        if (!(hex ? /^[0-9A-Fa-f]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) { this.i = offset + amp; this.fail('an invalid character reference'); }
        const cp = parseInt(digits, hex ? 16 : 10);
        if (!legalCodePoint(cp)) { this.i = offset + amp; this.fail('a reference to a character XML does not allow'); }
        out.push(String.fromCodePoint(cp));
      } else if (Object.prototype.hasOwnProperty.call(PREDEFINED, ref)) {
        out.push(PREDEFINED[ref]);
      } else {
        this.i = offset + amp;
        this.fail(`the entity &${ref.slice(0, 40)}; (entity expansion is off; only the five predefined entities are read)`);
      }
      k = semi + 1;
    }
    return out.join('');
  }

  /** Markup that is not an element, at `<`. */
  markup() {
    const s = this.s;
    if (s.startsWith('<!DOCTYPE', this.i)) this.fail('a DOCTYPE (entity declarations are refused: entity expansion is off)');
    if (s.startsWith('<!--', this.i)) this.fail('a comment');
    if (s.startsWith('<![CDATA[', this.i)) this.fail('a CDATA section');
    if (s.startsWith('<!', this.i)) this.fail('a markup declaration');
    if (s.startsWith('<?', this.i)) this.fail('a processing instruction');
  }

  openTag(depth) {
    this.markup();
    this.i += 1; // <
    const el = { name: this.name(), attrs: null, children: [], text: '', nonBlank: false };
    this.elements += 1;
    if (this.elements > MAX_ELEMENTS) this.fail(`more than ${MAX_ELEMENTS} elements`);
    if (depth > MAX_DEPTH) this.fail(`elements nested deeper than ${MAX_DEPTH}`);
    el.attrs = this.attributes(null);
    if (this.s.startsWith('/>', this.i)) {
      this.i += 2;
      return { el, closed: true };
    }
    this.i += 1; // >
    return { el, closed: false };
  }

  /** The root element and everything in it, with an explicit stack. */
  elementTree() {
    const s = this.s;
    if (s.charCodeAt(this.i) !== 60) this.fail('content before the root element');
    const first = this.openTag(1);
    if (first.closed) return first.el;
    const stack = [first.el];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const lt = s.indexOf('<', this.i);
      if (lt < 0) this.fail(`an unclosed <${top.name}>`);
      if (lt > this.i) this.text(top, this.i, lt);
      this.i = lt;
      if (s.charCodeAt(lt + 1) === 47 /* / */) {
        this.i = lt + 2;
        const name = this.name();
        this.skipSpace();
        if (s.charCodeAt(this.i) !== 62) this.fail(`a malformed </${name}>`);
        this.i += 1;
        if (name !== top.name) this.fail(`</${name}> closing <${top.name}>`);
        stack.pop();
        continue;
      }
      const { el, closed } = this.openTag(stack.length + 1);
      top.children.push(el);
      if (!closed) stack.push(el);
    }
    return first.el;
  }

  text(el, from, to) {
    const raw = this.s.slice(from, to);
    if (raw.includes(']]>')) { this.i = from; this.fail('the sequence ]]> in text'); }
    const text = this.decode(raw, from);
    if (!el.nonBlank && !blank(text)) el.nonBlank = true;
    if (el.text.length < MAX_TEXT_KEPT) el.text = (el.text + text).slice(0, MAX_TEXT_KEPT);
  }
}

const SUITE_CHILDREN = new Set(['testcase', 'system-out', 'system-err']);
const CASE_CHILDREN = new Set(['failure', 'error', 'skipped', 'system-out', 'system-err']);
const RESULT_ELEMENTS = new Set(['failure', 'error', 'skipped']);
const CONTRACT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function blank(text) {
  return !/[^ \t\n\r]/.test(text);
}

/**
 * Read forge's JUnit (`forge test --junit`, forge 1.x): <testsuites> holding
 * <testsuite name="<file>:<Contract>">, each holding <testcase name="<signature>">
 * with at most one <failure>, <error> or <skipped>. Any other shape is
 * unreadable.
 *
 * @param {Buffer} bytes - the JUnit as captured from forge's stdout
 * @param {{truncated?:boolean}} [o] - the capture was cut at its cap
 * @returns {{ok:true, suites:Array<{file:string, contract:string, cases:Array<{name:string, outcome:'pass'|'failure'|'error'|'skipped', message:string|null, out:string}>}>} | {ok:false, reason:string}}
 *   `out`: the start (4 KiB) of the record's <system-out>, forge's `<status> <signature> (gas: N)` line
 */
function readForgeJUnit(bytes, { truncated = false } = {}) {
  if (truncated) return { ok: false, reason: `the JUnit exceeds ${JUNIT_MAX_BYTES} bytes` };
  const parsed = parseXml(bytes);
  if (!parsed.ok) return parsed;
  const root = parsed.root;
  const bad = (reason) => ({ ok: false, reason });
  if (root.name !== 'testsuites') return bad(`the root element is <${root.name}>, not <testsuites>`);
  if (root.nonBlank) return bad('text inside <testsuites>');
  const suites = [];
  for (const suite of root.children) {
    if (suite.name !== 'testsuite') return bad(`<${suite.name}> inside <testsuites>`);
    if (suite.nonBlank) return bad('text inside a <testsuite>');
    const full = suite.attrs.name;
    const colon = typeof full === 'string' ? full.lastIndexOf(':') : -1;
    if (colon <= 0) return bad(`a <testsuite> whose name is not <file>:<Contract>: ${JSON.stringify(String(full)).slice(0, 120)}`);
    const file = full.slice(0, colon);
    const contract = full.slice(colon + 1);
    if (CONTROL.test(file) || !CONTRACT.test(contract)) return bad(`a <testsuite> whose name is not <file>:<Contract>: ${JSON.stringify(full).slice(0, 120)}`);
    const cases = [];
    for (const tc of suite.children) {
      if (!SUITE_CHILDREN.has(tc.name)) return bad(`<${tc.name}> inside a <testsuite>`);
      if (tc.name !== 'testcase') continue;
      const name = tc.attrs.name;
      if (typeof name !== 'string' || name === '' || name.length > 1024 || CONTROL.test(name)) return bad('a <testcase> without a usable name');
      if (tc.nonBlank) return bad('text inside a <testcase>');
      let result = null;
      let out = '';
      for (const child of tc.children) {
        if (!CASE_CHILDREN.has(child.name)) return bad(`<${child.name}> inside a <testcase>`);
        if (child.children.length > 0) return bad(`elements inside <${child.name}>`);
        if (RESULT_ELEMENTS.has(child.name)) {
          if (result) return bad(`a <testcase> with both <${result.name}> and <${child.name}>`);
          result = child;
        } else if (child.name === 'system-out' && out.length < MAX_TEXT_KEPT) {
          out = (out + child.text).slice(0, MAX_TEXT_KEPT);
        }
      }
      const outcome = !result ? 'pass' : result.name === 'skipped' ? 'skipped' : result.name;
      const message = result && typeof result.attrs.message === 'string' ? result.attrs.message : null;
      cases.push({ name, outcome, message, out });
    }
    suites.push({ file, contract, cases });
  }
  return { ok: true, suites };
}

module.exports = { parseXml, readForgeJUnit, JUNIT_MAX_BYTES, MAX_DEPTH, MAX_ELEMENTS, MAX_ATTRIBUTES };
