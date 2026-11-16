#!/usr/bin/env node
// Is the Foundry build of ArbiterOperator the contract Hardhat builds? (issue #196)
//
// Compares the runtime bytecode of the Hardhat artifact and the forge artifact with solc's metadata
// trailer cut off each: the CBOR map whose length is the code's last two bytes, big-endian. The trailer
// holds the metadata hash, which differs by build tool (source paths, literal content), so only it goes.
// Then checks where each build came from: solc 0.8.19 with Hardhat's settings on both sides, the Hardhat
// build's sources byte for byte the repository's contract and the vendored files, and the forge build's
// source list exactly those files under their vendored paths.
//
//   node arbiter-operator/foundry/ci/compare-bytecode.js [--hardhat <artifact.json>] [--forge <artifact.json>]
//
// Run after `npx hardhat compile` in arbiter-operator/ (dependencies at the versions in vendored.json) and
// `forge build` at the repository root. Exit 0: identical but for the trailer, and both builds are what
// they should be. Exit 1: the runtime bytecode differs. Exit 2: anything else (an artifact missing, a
// malformed trailer, a build from other sources or settings).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const OPERATOR = path.join(ROOT, 'arbiter-operator');
const LIB = path.join(OPERATOR, 'foundry/lib');
const CONTRACT = 'contracts/ArbiterOperator.sol';
const SOLC = '0.8.19';
const OPTIMIZER = { enabled: true, runs: 200 };
const EVM = 'paris';
// Import prefix (Hardhat's source names) -> vendored directory (foundry.toml's remappings).
const PACKAGES = { '@chainlink/contracts/': 'chainlink-contracts/', '@openzeppelin/contracts/': 'openzeppelin-contracts/' };
const NPM_NAMES = { 'chainlink-contracts/': '@chainlink/contracts', 'openzeppelin-contracts/': '@openzeppelin/contracts' };

function args(argv) {
  const out = {
    hardhat: path.join(OPERATOR, 'artifacts/contracts/ArbiterOperator.sol/ArbiterOperator.json'),
    forge: path.join(OPERATOR, 'foundry/out/ArbiterOperator.sol/ArbiterOperator.json')
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in out) || argv[i + 1] === undefined) throw new Error(`usage: compare-bytecode.js [--hardhat <file>] [--forge <file>] (got ${argv[i]})`);
    out[key] = path.resolve(argv[i + 1]);
  }
  return out;
}

function shown(file) {
  const rel = path.relative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hexBytes(hex, what) {
  if (typeof hex !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(hex)) throw new Error(`${what}: not hex bytecode`);
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

// A CBOR head: major type and argument (RFC 8949 section 3), for the small items solc writes.
function head(buf, at) {
  const major = buf[at] >> 5;
  const info = buf[at] & 0x1f;
  if (info < 24) return { major, arg: info, next: at + 1 };
  if (info === 24) return { major, arg: buf[at + 1], next: at + 2 };
  if (info === 25) return { major, arg: buf.readUInt16BE(at + 1), next: at + 3 };
  throw new Error(`unexpected CBOR head 0x${buf[at].toString(16)}`);
}

/** The code before solc's metadata trailer, and the trailer's entries (a map of text keys to byte or text strings). */
function splitTrailer(code, what) {
  if (code.length < 2) throw new Error(`${what}: too short for a metadata trailer`);
  const length = code.readUInt16BE(code.length - 2);
  const start = code.length - 2 - length;
  if (length === 0 || start < 0) throw new Error(`${what}: no metadata trailer (length ${length} of ${code.length} bytes)`);
  const cbor = code.subarray(start, code.length - 2);
  const map = head(cbor, 0);
  if (map.major !== 5) throw new Error(`${what}: the trailer is not a CBOR map`);
  const entries = {};
  let at = map.next;
  for (let i = 0; i < map.arg; i++) {
    const key = head(cbor, at);
    if (key.major !== 3) throw new Error(`${what}: a trailer key is not text`);
    const name = cbor.subarray(key.next, key.next + key.arg).toString('utf8');
    const value = head(cbor, key.next + key.arg);
    if (value.major !== 2 && value.major !== 3) throw new Error(`${what}: trailer entry ${name} is not a string`);
    entries[name] = cbor.subarray(value.next, value.next + value.arg);
    at = value.next + value.arg;
  }
  if (at !== cbor.length) throw new Error(`${what}: ${cbor.length - at} bytes after the trailer's map`);
  return { code: code.subarray(0, start), trailerBytes: length + 2, entries };
}

function solcOfTrailer(entries) {
  const v = entries.solc;
  return v && v.length === 3 ? `${v[0]}.${v[1]}.${v[2]}` : null;
}

function sameOptimizer(o) {
  return o && o.enabled === OPTIMIZER.enabled && o.runs === OPTIMIZER.runs;
}

/** The vendored file a Hardhat source name stands for, or null. */
function vendoredPath(sourceName) {
  for (const [prefix, dir] of Object.entries(PACKAGES)) {
    if (sourceName.startsWith(prefix)) return dir + sourceName.slice(prefix.length);
  }
  return null;
}

function provenance(o, forge) {
  const problems = [];
  const manifest = readJson(path.join(LIB, 'vendored.json'));
  const vendoredSol = manifest.files.map((f) => f.path).filter((p) => p.endsWith('.sol') && !p.startsWith('forge-std/')).sort();

  // Hardhat: the build info its artifact points to.
  const dbg = readJson(o.hardhat.replace(/\.json$/, '.dbg.json'));
  const info = readJson(path.resolve(path.dirname(o.hardhat), dbg.buildInfo));
  const settings = info.input.settings;
  if (info.solcVersion !== SOLC) problems.push(`hardhat: solc ${info.solcVersion}, not ${SOLC}`);
  if (!sameOptimizer(settings.optimizer)) problems.push(`hardhat: optimizer ${JSON.stringify(settings.optimizer)}`);
  if (settings.viaIR) problems.push('hardhat: viaIR is on');
  if (settings.evmVersion !== undefined && settings.evmVersion !== EVM) problems.push(`hardhat: evmVersion ${settings.evmVersion}`);
  const compiled = [];
  for (const [name, source] of Object.entries(info.input.sources)) {
    let local;
    if (name === CONTRACT) local = path.join(OPERATOR, CONTRACT);
    else if (vendoredPath(name)) local = path.join(LIB, vendoredPath(name));
    else { problems.push(`hardhat compiled ${name}, which is neither the contract nor vendored`); continue; }
    if (name !== CONTRACT) compiled.push(vendoredPath(name));
    if (!fs.existsSync(local)) problems.push(`hardhat compiled ${name}, which is not vendored`);
    else if (!fs.readFileSync(local).equals(Buffer.from(source.content, 'utf8'))) problems.push(`hardhat's ${name} differs from ${shown(local)}`);
  }
  if (JSON.stringify(compiled.sort()) !== JSON.stringify(vendoredSol)) problems.push(`hardhat compiled [${compiled}], vendored.json lists [${vendoredSol}]`);
  for (const [dir, name] of Object.entries(NPM_NAMES)) {
    const want = manifest.sources.find((s) => s.package === name);
    const pkg = path.join(OPERATOR, 'node_modules', name, 'package.json');
    const got = fs.existsSync(pkg) ? readJson(pkg).version : '(not installed)';
    if (!want || got !== want.version) problems.push(`hardhat: ${name} ${got} installed, vendored.json has ${want && want.version} (${dir})`);
  }

  // forge: the metadata in its artifact.
  const meta = typeof forge.metadata === 'string' ? JSON.parse(forge.metadata) : forge.metadata;
  if (!meta) problems.push('forge: the artifact has no metadata');
  else {
    if (!String(meta.compiler && meta.compiler.version).startsWith(`${SOLC}+`)) problems.push(`forge: solc ${meta.compiler && meta.compiler.version}`);
    if (!sameOptimizer(meta.settings.optimizer)) problems.push(`forge: optimizer ${JSON.stringify(meta.settings.optimizer)}`);
    if (meta.settings.viaIR) problems.push('forge: viaIR is on');
    if (meta.settings.evmVersion !== EVM) problems.push(`forge: evmVersion ${meta.settings.evmVersion}`);
    const want = ['arbiter-operator/' + CONTRACT, ...vendoredSol.map((p) => 'arbiter-operator/foundry/lib/' + p)].sort();
    const got = Object.keys(meta.sources).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`forge compiled [${got}], expected [${want}]`);
  }
  return problems;
}

function main() {
  const o = args(process.argv.slice(2));
  const hardhat = readJson(o.hardhat);
  const forge = readJson(o.forge);
  const h = splitTrailer(hexBytes(hardhat.deployedBytecode, 'hardhat'), 'hardhat');
  const f = splitTrailer(hexBytes(forge.deployedBytecode && forge.deployedBytecode.object, 'forge'), 'forge');

  const problems = provenance(o, forge);
  for (const [side, t] of [['hardhat', h], ['forge', f]]) {
    if (solcOfTrailer(t.entries) !== SOLC) problems.push(`${side}: the trailer names solc ${solcOfTrailer(t.entries)}`);
  }

  console.log(`hardhat: ${h.code.length} bytes of runtime code + ${h.trailerBytes} of trailer (${shown(o.hardhat)})`);
  console.log(`forge:   ${f.code.length} bytes of runtime code + ${f.trailerBytes} of trailer (${shown(o.forge)})`);
  const differs = !h.code.equals(f.code);
  if (differs) {
    let at = 0;
    while (at < Math.min(h.code.length, f.code.length) && h.code[at] === f.code[at]) at++;
    console.log(`DIFFERENT: the runtime bytecode differs from byte ${at} (hardhat ${h.code.length} bytes, forge ${f.code.length})`);
  } else {
    console.log('SAME: the runtime bytecode is identical but for the metadata trailer');
  }
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  process.exit(differs ? 1 : problems.length ? 2 : 0);
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
}
