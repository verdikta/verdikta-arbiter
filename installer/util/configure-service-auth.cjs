#!/usr/bin/env node
// Local-only configuration. Never prints tokens or contacts a running node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const valid = token => typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Configuration must be a regular file');
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
function get(text, name) {
  const matches = text.split(/\r?\n/).filter(line => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
  if (matches.length > 1) throw new Error(`Duplicate ${name} configuration`);
  if (!matches.length) return '';
  return matches[0].slice(matches[0].indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}
function set(text, name, value) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  return text.split(/\r?\n/).filter(line => !pattern.test(line)).join('\n').trimEnd() + `\n${name}=${value}\n`;
}
function write(file, text) {
  // Read/check before replacing, so a symlink is never silently followed.
  read(file);
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function configure(root) {
  const aiFile = path.join(root, 'ai-node', '.env.local');
  const eaFile = path.join(root, 'external-adapter', '.env');
  let ai = read(aiFile), ea = read(eaFile);
  const aiToken = get(ai, 'AI_NODE_API_TOKEN'), eaAiToken = get(ea, 'AI_NODE_API_TOKEN');
  const eaToken = get(ea, 'EA_API_TOKEN');
  for (const token of [aiToken, eaAiToken, eaToken]) {
    if (token && !valid(token)) throw new Error('Existing service token is invalid; correct it explicitly before proceeding');
  }
  if (aiToken && eaAiToken && aiToken !== eaAiToken) throw new Error('AI_NODE_API_TOKEN differs between services');
  const shared = aiToken || eaAiToken || crypto.randomBytes(32).toString('hex');
  const inbound = eaToken || crypto.randomBytes(32).toString('hex');
  if (shared === inbound) throw new Error('EA and AI Node must use separate service tokens');
  ai = set(ai, 'AI_NODE_API_TOKEN', shared);
  ea = set(set(ea, 'AI_NODE_API_TOKEN', shared), 'EA_API_TOKEN', inbound);
  write(aiFile, ai);
  write(eaFile, ea);
}
function renderJob(root, filename) {
  const token = get(read(path.join(root, 'external-adapter', '.env')), 'EA_API_TOKEN');
  if (!valid(token)) throw new Error('Configure service authentication before rendering jobs');
  const spec = read(filename);
  if (!spec.includes('{EA_API_TOKEN}')) throw new Error('Job template is missing authentication');
  write(filename, spec.replaceAll('{EA_API_TOKEN}', token));
}
if (require.main === module) {
  try {
    const [command, root, filename] = process.argv.slice(2);
    if (!root || !['configure', 'render-job'].includes(command) || (command === 'render-job' && !filename)) {
      throw new Error('Usage: configure-service-auth.cjs configure ROOT | render-job ROOT JOB_FILE');
    }
    if (command === 'configure') configure(path.resolve(root));
    else renderJob(path.resolve(root), path.resolve(filename));
    console.log('Service authentication configuration ready.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { configure, renderJob };
