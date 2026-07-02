#!/usr/bin/env node
'use strict';

/**
 * Build, validate, predict-CID, and pin the canonical E2E evidence archive.
 *
 * The archive SOURCE lives in e2e/archives/<name>/ (manifest.json,
 * primary_query.json, evidence files). This script zips it deterministically,
 * validates it with the same @verdikta/common code the External Adapter uses,
 * optionally predicts its IPFS CID offline, and optionally pins it to IPFS
 * (Pinata) — writing the resulting CID to e2e/archives/<name>.cid so the
 * scenarios can reference it.
 *
 * Usage:
 *   node scripts/build-archive.js [--src <dir>] [--out <zip>] [--cid-out <file>]
 *                                 [--validate] [--predict-cid] [--pin]
 *
 * Common recipes:
 *   npm run build-archive -- --validate --predict-cid      # offline check
 *   IPFS_PINNING_KEY=<jwt> npm run build-archive -- --pin  # pin + record CID
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z'); // deterministic zip bytes

function parseArgs(argv) {
  const opts = { src: 'archives/contract-vuln', flags: new Set() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--validate' || a === '--predict-cid' || a === '--pin') opts.flags.add(a.slice(2));
    else if (a === '--src') opts.src = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--cid-out') opts.cidOut = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  const name = path.basename(opts.src);
  opts.srcDir = path.resolve(ROOT, opts.src);
  opts.out = path.resolve(ROOT, opts.out || `archives/${name}.zip`);
  opts.cidOut = path.resolve(ROOT, opts.cidOut || `archives/${name}.cid`);
  return opts;
}

/** Build a deterministic ZIP buffer from the source directory. */
function buildZip(srcDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`Archive source not found: ${srcDir}`);
  const files = fs.readdirSync(srcDir)
    .filter((f) => fs.statSync(path.join(srcDir, f)).isFile())
    .sort(); // stable order for reproducible bytes
  if (!files.includes('manifest.json')) throw new Error(`No manifest.json in ${srcDir}`);

  const zip = new AdmZip();
  for (const f of files) zip.addFile(f, fs.readFileSync(path.join(srcDir, f)));
  zip.getEntries().forEach((e) => { e.header.time = FIXED_MTIME; });
  return { buffer: zip.toBuffer(), files };
}

/** Validate the archive with the same code path the External Adapter uses. */
async function validateArchive(buffer) {
  const { createClient } = require('@verdikta/common');
  const client = createClient({ logging: { level: 'error', console: false, file: false } });
  const { archiveService, manifestParser } = client;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-archive-'));
  try {
    const extractedPath = await archiveService.extractArchive(buffer, 'archive.zip', tmp);
    await archiveService.validateManifest(extractedPath);
    const parsed = await manifestParser.parse(extractedPath);
    const summary = {
      prompt: (parsed.prompt || '').slice(0, 60) + '…',
      outcomes: parsed.outcomes,
      models: (parsed.models || []).map((m) => `${m.provider}:${m.model}:${m.weight}`),
      iterations: parsed.iterations,
      additional: (parsed.additional || []).map((a) => a.filename || a.name),
    };
    if (!parsed.prompt) throw new Error('parsed manifest has no prompt');
    if (!Array.isArray(parsed.outcomes) || parsed.outcomes.length < 2) throw new Error('manifest needs >=2 outcomes');
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) throw new Error('manifest needs >=1 model');
    return summary;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Predict the IPFS CIDv0 of the archive bytes without pinning. */
async function predictCid(buffer) {
  const Hash = require('ipfs-only-hash');
  return Hash.of(buffer); // CIDv0 (Qm…), matching a default single-file IPFS add
}

/** Pin the archive to IPFS via @verdikta/common (Pinata) and record the CID. */
async function pinArchive(buffer, cidOut) {
  if (!process.env.IPFS_PINNING_KEY) {
    throw new Error('IPFS_PINNING_KEY (Pinata JWT) is required to --pin.');
  }
  const { createClient } = require('@verdikta/common');
  const client = createClient({
    ipfs: {
      pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
      pinningKey: process.env.IPFS_PINNING_KEY,
      timeout: 30000,
    },
    logging: { level: 'error', console: false, file: false },
  });
  const tmpFile = path.join(os.tmpdir(), `e2e-pin-${Date.now()}.zip`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    const cid = await client.ipfsClient.uploadToIPFS(tmpFile);
    fs.writeFileSync(cidOut, `${cid}\n`);
    return cid;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

(async () => {
  const opts = parseArgs(process.argv);
  const { buffer, files } = buildZip(opts.srcDir);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, buffer);
  console.log(`Built ${opts.out} (${buffer.length} bytes) from [${files.join(', ')}]`);

  if (opts.flags.has('validate')) {
    const summary = await validateArchive(buffer);
    console.log('Validated via @verdikta/common:', JSON.stringify(summary, null, 2));
  }
  if (opts.flags.has('predict-cid')) {
    console.log(`Predicted CIDv0: ${await predictCid(buffer)}`);
  }
  if (opts.flags.has('pin')) {
    const cid = await pinArchive(buffer, opts.cidOut);
    console.log(`Pinned. CID=${cid}  →  recorded in ${opts.cidOut}`);
  }
})().catch((err) => {
  console.error(`build-archive failed: ${err.message}`);
  process.exit(1);
});
