'use strict';

/**
 * The step launcher and its start nonce.
 *
 * "Did the step's process start?" is never read from Docker's error text,
 * whose wording varies by Docker version and runtime. Every command the
 * runner runs in a sandbox goes through a launcher the runner controls:
 *
 *   /bin/sh -c 'printf "vcr-start %s\n" "$1" && shift && exec "$@"' vcr-launch <nonce> <argv...>
 *
 * The runner generates a fresh 128-bit nonce for every exec and passes it only
 * on this command line. The launcher writes `vcr-start <nonce>` as the first
 * line of stdout, then `exec`s the step's argv unchanged, so the exit code,
 * the files and everything after that line are the program's own. The runner
 * strips the line (StartGate). A result counts only if the line arrived first:
 * without it the command did not start, whatever Docker printed.
 *
 * Why claim code cannot fake a start: the nonce is new for each exec and
 * exists only in the runner and in the docker exec request until the launcher
 * process exists in the container; a process that never started was never
 * visible to anything in the sandbox. Once the launcher runs, the line is
 * already on its way; after `exec` the nonce is gone from the process's argv,
 * and it was never in its environment. The launcher's interpreter is checked
 * at launch, before any claim code runs, to be unwritable by the sandbox user
 * (LAUNCHER_CHECK), so claim code cannot become the launcher of a later step.
 */

const crypto = require('node:crypto');

const LAUNCHER_PATH = '/bin/sh';
const LAUNCHER_ARG0 = 'vcr-launch';
const MARKER = 'vcr-start';
const LAUNCHER_SCRIPT = `printf "${MARKER} %s\\n" "$1" && shift && exec "$@"`;
const NONCE = /^[0-9a-f]{32}$/;

/**
 * The launch-time check of the launcher's interpreter ($1, /bin/sh). It
 * resolves the path the way the kernel does, one component at a time from /,
 * following every symlink wherever it sits (a directory link in the middle
 * included), and checks every directory entered and every entry looked up:
 * none may be owned by the sandbox user (an owner can chmod, so read-only
 * modes do not help) or writable by it. Exits 1 when one is, 2 when the check
 * cannot be made (a test the shell does not support, a missing component, a
 * link it cannot read, more than 40 links), 0 when the interpreter is safe.
 */
const LAUNCHER_CHECK = [
  'own() { [ -O "$1" ]; r=$?; [ "$r" -eq 0 ] && exit 1; [ "$r" -eq 1 ] || exit 2; }',
  'wr() { [ -w "$1" ]; r=$?; [ "$r" -eq 0 ] && exit 1; [ "$r" -eq 1 ] || exit 2; }',
  'chk() { own "$1"; wr "$1"; }',
  'chk /',
  'cur=/; rest=$1; n=0',
  'while :; do',
  '  while case $rest in /*) true ;; *) false ;; esac; do rest=${rest#/}; done',
  '  [ -n "$rest" ] || exit 0',
  '  case $rest in */*) comp=${rest%%/*}; rest=${rest#*/} ;; *) comp=$rest; rest= ;; esac',
  '  case $comp in .) continue ;; ..) cur=${cur%/*}; [ -n "$cur" ] || cur=/; continue ;; esac',
  '  next=${cur%/}/$comp',
  '  [ -e "$next" ] || [ -L "$next" ] || exit 2',
  '  chk "$next"',
  '  if [ -L "$next" ]; then',
  '    n=$((n+1)); [ "$n" -le 40 ] || exit 2',
  '    t=$(readlink "$next") || exit 2',
  '    case $t in /*) cur=/ ;; esac',
  '    if [ -n "$rest" ]; then rest=$t/$rest; else rest=$t; fi',
  '  else',
  '    cur=$next',
  '  fi',
  'done'
].join('\n');

/**
 * The cgroup counters probe: shell builtins only, so it still runs when the
 * pid table is full, once its own process could start. A counter file that
 * is absent is skipped (gVisor, or the other cgroup version); one that exists
 * but cannot be read fails the probe (exit 4), since that limit would go
 * unchecked.
 */
const PROBE_SCRIPT = [
  'for f in "$@"; do',
  '  if [ -e "$f" ]; then',
  '    [ -r "$f" ] || exit 4',
  '    printf "==> %s <==\\n" "$f"',
  '    while IFS= read -r l || [ -n "$l" ]; do printf "%s\\n" "$l"; done < "$f" || exit 3',
  '  fi',
  'done',
  'exit 0'
].join('\n');

function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/** The argv docker exec runs: the launcher, the nonce, then the step's argv. */
function launcherArgv(nonce, argv) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError('the start nonce must be 32 hex characters');
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0] === '' || argv[0].startsWith('-')) {
    throw new TypeError('the step argv must start with a program name that does not begin with "-"');
  }
  return [LAUNCHER_PATH, '-c', LAUNCHER_SCRIPT, LAUNCHER_ARG0, nonce, ...argv];
}

/**
 * A stdout sink that expects `vcr-start <nonce>\n` as the first bytes. Once
 * it has them it drops them and forwards the rest to `sink`; if the stream
 * starts with anything else (Docker's own report that the command did not
 * start, say) it forwards everything, so the diagnostic is kept, and `seen`
 * stays false.
 */
class StartGate {
  constructor(nonce, sink) {
    this.expected = Buffer.from(`${MARKER} ${nonce}\n`);
    this.sink = sink;
    this.pending = [];
    this.state = 'waiting';
  }

  get seen() {
    return this.state === 'seen';
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.state !== 'waiting') return this.sink.write(buf);
    this.pending.push(buf);
    const got = Buffer.concat(this.pending);
    const n = Math.min(got.length, this.expected.length);
    if (!got.subarray(0, n).equals(this.expected.subarray(0, n))) {
      this.state = 'missing';
      this.pending = [];
      return this.sink.write(got);
    }
    if (got.length < this.expected.length) return true;
    this.state = 'seen';
    this.pending = [];
    const rest = got.subarray(this.expected.length);
    return rest.length ? this.sink.write(rest) : true;
  }

  /** At the end of the stream: a partial marker is no marker. */
  finish() {
    if (this.state !== 'waiting') return;
    this.state = 'missing';
    const got = Buffer.concat(this.pending);
    this.pending = [];
    if (got.length) this.sink.write(got);
  }
}

module.exports = {
  LAUNCHER_PATH,
  LAUNCHER_ARG0,
  LAUNCHER_SCRIPT,
  LAUNCHER_CHECK,
  PROBE_SCRIPT,
  MARKER,
  newNonce,
  launcherArgv,
  StartGate
};
