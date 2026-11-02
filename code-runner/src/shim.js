'use strict';

/**
 * The runner's forge (node A3a attempt 2, R11-F1; owner decision Q29): the
 * maker's commands run forge with the configuration the runner probed, or
 * not at all.
 *
 * The rule for makers (README, "The forge configuration rule"): the
 * commands run forge from /work with the default configuration the runner
 * probes: no `--profile`, `--config-path` or `--root`, no flag that sets a
 * path forge reads or writes, no `FOUNDRY_CONFIG`, and no `FOUNDRY_*`
 * variable (`FOUNDRY_PROFILE` included) that changes a setting the
 * checksum check watches.
 *
 * How it is held, in the sandbox, without changing the image:
 *
 * - The shim lives on a tmpfs of the runner's own (SHIM_DIR), owned by a
 *   second unprivileged user (SHIM_USER), mode 0755: the sandbox user that
 *   runs claim code can neither write it nor add to it, and the read-only
 *   root holds the image's forge. It is written once per sandbox by one exec
 *   as that user, after the integrity reference and before the build.
 * - The maker's commands get SHIM_DIR first on PATH, so `forge` by name
 *   (from the command, a script it runs, or `env`) is the shim; and
 *   FOUNDRY_CONFIG naming a directory (POISON), so the image's forge called
 *   any other way (by its absolute path, or with a PATH of the command's
 *   own) fails at once, every subcommand that reads a configuration
 *   included: "Is a directory". Only the shim removes it.
 * - On each call the shim refuses a call outside /work, a FOUNDRY_CONFIG
 *   other than the poison, `--profile`, `--config-path`, `--root` and the
 *   flags that set a watched path (read, never reinterpreted: a short-option
 *   cluster holding o, C or R is refused whole), then asks the real forge
 *   for the call's effective configuration (`forge config --json`, the
 *   call's own environment, from /work) and compares its watched fields
 *   (WATCHED_KEYS) with the probed configuration's, by SHA-256. A refused
 *   call prints one record (`vcr-forge-config refused <reason>`, a code,
 *   never a value) and exits SHIM_STATUS; forge never runs with another
 *   configuration. An accepted call is `exec "$real" "$@"`: forge's own
 *   behaviour, unchanged.
 *
 * What is left (README): a command that both reaches the image's forge
 * without the shim and replaces FOUNDRY_CONFIG itself (`env -i`, `env -u`)
 * escapes both. That is the command's text or a script it runs, the
 * listing's, which the listing check (A2c) runs under the same shim before
 * any claim exists.
 */

const crypto = require('node:crypto');
const { hermetic, BASE_ENV } = require('./git');

const WORK = '/work';
/** The runner's tmpfs for the shim (sandbox.js mounts it, owned by SHIM_USER). */
const SHIM_DIR = '/vcr';
const SHIM_PATH = `${SHIM_DIR}/forge`;
/** FOUNDRY_CONFIG for the maker's commands: a directory, so the image's forge reached without the shim cannot read a configuration. */
const POISON = `${SHIM_DIR}/no-forge-config`;
/** The user that writes the shim: not the sandbox user, which runs claim code. */
const SHIM_USER = '10002:10002';
const SHIM_UID = 10002;
/** The shim's exit status for a refused call. */
const SHIM_STATUS = 86;

/** The top-level fields of `forge config --json` the checks depend on: what forge reads and where it writes. */
const WATCHED_KEYS = Object.freeze([
  'src', 'test', 'script', 'out', 'libs', 'remappings', 'cache_path', 'broadcast', 'snapshots', 'allow_paths', 'include_paths', 'solc'
]);

/** Flags that set a watched path (forge 1.8.5's names and aliases; no long option is inferred from a prefix). */
const PATH_FLAGS = Object.freeze([
  '--out', '--contracts', '--remappings', '--remappings-env', '--cache-path', '--lib-paths', '--hardhat', '--hh', '--build-info-path', '--use'
]);
/** Flags the rule refuses outright. */
const CONFIG_FLAGS = Object.freeze(['--profile', '--config-path', '--root']);

/** The shim's filter of `forge config --json` (serde's pretty JSON: a top-level field starts a line indented by two spaces). */
const AWK = `/^  "[^"]*": /{ keep = ($1 ~ /^"(${WATCHED_KEYS.join('|')})":$/) } /^}/{ keep = 0 } keep`;

/**
 * The watched fields of a `forge config --json` text, exactly as the shim's
 * awk filter prints them: every line from a watched top-level field to the
 * next top-level field.
 * @param {string} text
 * @returns {string}
 */
function watchedConfigText(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const keep = new Set(WATCHED_KEYS.map((k) => `"${k}":`));
  let on = false;
  let out = '';
  for (const line of lines) {
    if (/^ {2}"[^"]*": /.test(line)) on = keep.has(line.trim().split(/[ \t]+/)[0]);
    if (line.startsWith('}')) on = false;
    if (on) out += `${line}\n`;
  }
  return out;
}

/** The digest the shim compares: SHA-256 of the watched fields' text. */
function watchedConfigDigest(text) {
  return crypto.createHash('sha256').update(watchedConfigText(text), 'utf8').digest('hex');
}

/** A shell word for `s`, single-quoted. */
function shq(s) {
  return `'${String(s).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * The shim, for the probed forge (its real path) and the probed
 * configuration's digest.
 * @param {{real:string, want:string}} o
 * @returns {string}
 */
function shimScript({ real, want }) {
  if (typeof real !== 'string' || !real.startsWith('/') || real.includes('\0')) throw new TypeError('the probed forge must be an absolute path');
  if (!/^[0-9a-f]{64}$/.test(want)) throw new TypeError('want must be a SHA-256 digest');
  const pathFlags = PATH_FLAGS.flatMap((f) => [f, `${f}=*`]).join('|');
  const configFlags = CONFIG_FLAGS.flatMap((f) => [f, `${f}=*`]).join('|');
  return [
    '#!/bin/sh',
    '# The Verdikta code runner\'s forge (code-runner/src/shim.js): the image\'s forge, run only with the configuration the runner watches.',
    `real=${shq(real)}`,
    `want=${want}`,
    `refuse() { printf 'vcr-forge-config refused %s\\n' "$1" >&2; exit ${SHIM_STATUS}; }`,
    `case \${FOUNDRY_CONFIG-} in ''|${POISON}) ;; *) refuse FOUNDRY_CONFIG ;; esac`,
    'unset FOUNDRY_CONFIG',
    `[ "$(pwd -P)" = ${WORK} ] || refuse directory`,
    'for a do',
    '  case $a in',
    '    --) break ;;',
    `    ${configFlags}) refuse "\${a%%=*}" ;;`,
    `    ${pathFlags}) refuse "\${a%%=*}" ;;`,
    '    --*) ;;',
    '    -*[oCR]*) refuse cluster ;;',
    '  esac',
    'done',
    'got=$("$real" config --json </dev/null 2>/dev/null) || refuse config',
    // The shim's own tools from the read-only root, never from the command's PATH (which may hold work-tree directories).
    `got=$(printf '%s\\n' "$got" | PATH=${BASE_ENV.PATH} awk '${AWK}' | PATH=${BASE_ENV.PATH} sha256sum) || refuse config`,
    '[ "${got%% *}" = "$want" ] || refuse watched-paths',
    'exec "$real" "$@"',
    ''
  ].join('\n');
}

/**
 * The install, run as SHIM_USER with the shim on stdin: the poison
 * directory, then the shim written aside and moved into place, mode 0555.
 * Exit 4: the image has no awk or sha256sum (on the read-only root's PATH).
 */
const INSTALL_SCRIPT = [
  'command -v awk >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 || exit 4',
  'set -e',
  'umask 022',
  `mkdir -p ${POISON}`,
  `cat > ${SHIM_PATH}.new`,
  `chmod 0555 ${SHIM_PATH}.new`,
  `mv -f ${SHIM_PATH}.new ${SHIM_PATH}`
].join('\n');

function installArgv() {
  return hermetic(INSTALL_SCRIPT, 'vcr-shim');
}

/**
 * The environment the maker's commands get on top of forge's (forge.forgeEnv):
 * the shim first on PATH (the image's PATH as the reference probed it) and
 * the poisoned FOUNDRY_CONFIG.
 * @param {string} path - the probed PATH
 */
function commandEnv(path) {
  return { PATH: path ? `${SHIM_DIR}:${path}` : SHIM_DIR, FOUNDRY_CONFIG: POISON };
}

/** What each refusal code means, for a gate or check detail. */
const REASONS = Object.freeze({
  directory: 'forge ran outside /work',
  FOUNDRY_CONFIG: 'FOUNDRY_CONFIG named a configuration file',
  '--profile': 'forge was given --profile',
  '--config-path': 'forge was given --config-path',
  '--root': 'forge was given --root',
  cluster: 'forge was given short options that include -o, -C or -R',
  config: '`forge config` failed in the call\'s environment',
  'watched-paths': 'the call\'s environment (FOUNDRY_PROFILE or another FOUNDRY_* variable) changes a setting the checks watch'
});

/**
 * Why a maker's step ran forge with a configuration the runner does not
 * watch, from its stderr: the shim's first refusal record, or forge's own
 * error on the poisoned FOUNDRY_CONFIG (the image's forge reached without
 * the shim). null when neither is there.
 * @param {string} stderr
 * @returns {string|null}
 */
function refusalOf(stderr) {
  const text = String(stderr || '');
  const m = /^vcr-forge-config refused (\S+)$/m.exec(text);
  if (m) {
    if (REASONS[m[1]]) return `the runner's forge refused the call: ${REASONS[m[1]]}`;
    if (PATH_FLAGS.includes(m[1])) return `the runner's forge refused the call: forge was given ${m[1]}, which sets a path the checks watch`;
    return 'the runner\'s forge refused the call';
  }
  if (text.includes(POISON)) return 'forge ran without the runner\'s forge (by an absolute path, or a PATH of the command\'s own): its configuration was the runner\'s poison';
  return null;
}

module.exports = {
  SHIM_DIR, SHIM_PATH, SHIM_USER, SHIM_UID, SHIM_STATUS, POISON, WATCHED_KEYS, PATH_FLAGS, CONFIG_FLAGS, AWK, INSTALL_SCRIPT,
  watchedConfigText, watchedConfigDigest, shimScript, installArgv, commandEnv, refusalOf
};
