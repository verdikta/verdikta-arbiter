#!/bin/bash
# The runner in the node's life (node A8; design §16): code-runner/start.sh and stop.sh,
# start-arbiter.sh, stop-arbiter.sh, arbiter-status.sh, rotate-logs.sh, the boot unit, and
# the deploy lists of install.sh and upgrade-arbiter.sh. start.sh is what keeps the runner
# off the arbiter's Docker and away from the node's keys.
# Run: bash installer/tests/code-runner-lifecycle.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
cleanup() { [ -f "$T/r/runner.pid" ] && kill "$(cat "$T/r/runner.pid")" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
R="$T/r"; mkdir -p "$R/src" "$T/bin"
cp "$REPO/code-runner/start.sh" "$REPO/code-runner/stop.sh" "$R/"
# A stand-in for the runner: records its environment, listens as the real one does,
# and leaves on SIGTERM. What start.sh hands it is what the real one would get.
cat > "$R/src/index.js" <<'E'
const fs = require('fs'), http = require('http');
fs.writeFileSync(process.env.TEST_ENV_FILE_FIXED || `${__dirname}/../env.seen`, JSON.stringify(process.env));
const s = http.createServer((q, a) => { a.statusCode = 401; a.end(); });
s.listen(Number(process.env.CODE_RUNNER_PORT), '127.0.0.1');
process.on('SIGTERM', () => { fs.writeFileSync(`${__dirname}/../stopped`, 'yes'); s.close(); process.exit(0); });
E
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
write_env() {
cat > "$R/.env" <<E
DOCKER_HOST=${1:-unix://$T/run/docker.sock}
CODE_RUNNER_RUNTIME=runsc
CODE_RUNNER_PORT=$PORT
CODE_RUNNER_HOST=127.0.0.1
CODE_RUNNER_TOKEN_FILE=$R/.state/token
E
}
# A socket the wait can see: start.sh waits, bounded, for the daemon's socket at boot.
mkdir -p "$T/run"; : > "$T/run/docker.sock"
start() { env PRIVATE_KEY=not-a-real-key INFURA_API_KEY=not-a-real-key IPFS_PINNING_KEY=not-a-real-key CODE_RUNNER_DAEMON_WAIT_SECS=1 CODE_RUNNER_START_TIMEOUT_SECS=15 bash "$R/start.sh" 2>&1; }

# --- no .env: nothing to start
out=$(start); rc=$?
[ "$rc" != 0 ] && ok || bad "start without .env: exit 0"
has "start without .env says so" "$out" ".env"

# --- the arbiter's Docker is refused, whichever way it is named
for host in unix:///var/run/docker.sock unix:///run/docker.sock tcp://127.0.0.1:2375 ""; do
    write_env "$host"; [ -n "$host" ] || sed -i.b '/^DOCKER_HOST=/d' "$R/.env"
    out=$(start); rc=$?
    [ "$rc" != 0 ] && ok || bad "start on [$host]: exit 0"
    has "start on [$host] says why" "$out" "DOCKER_HOST"
    [ ! -f "$R/runner.pid" ] && ok || bad "start on [$host] started something"
done

# --- a clean start: nothing of the caller's environment
write_env
out=$(start); rc=$?
[ "$rc" = 0 ] && ok || bad "start: exit $rc: $out"
[ -f "$R/runner.pid" ] && ok || bad "no runner.pid"
seen=$(cat "$R/env.seen" 2>/dev/null)
hasnt "no key reaches the runner"     "$seen" "PRIVATE_KEY"
hasnt "no provider key either"        "$seen" "INFURA_API_KEY"
hasnt "no pinning key either"         "$seen" "IPFS_PINNING_KEY"
has   "its own daemon"                "$seen" "\"DOCKER_HOST\":\"unix://$T/run/docker.sock\""
has   "its runtime"                   "$seen" '"CODE_RUNNER_RUNTIME":"runsc"'
ls "$R/logs/"runner_*.log >/dev/null 2>&1 && ok || bad "no log under logs/"
# A second start is a no-op, not a second process.
pid=$(cat "$R/runner.pid")
out=$(start); rc=$?
[ "$rc" = 0 ] && ok || bad "second start: exit $rc"
[ "$(cat "$R/runner.pid")" = "$pid" ] && ok || bad "second start replaced the process"
# Stop: SIGTERM, so the runner removes its sandboxes.
out=$(bash "$R/stop.sh" 2>&1); rc=$?
[ "$rc" = 0 ] && ok || bad "stop: exit $rc: $out"
[ -f "$R/stopped" ] && ok || bad "stop did not send SIGTERM"
[ ! -f "$R/runner.pid" ] && ok || bad "stop left runner.pid"
# A stale pid file names another program: it is not killed.
sleep 60 & other=$!
echo "$other" > "$R/runner.pid"
out=$(bash "$R/stop.sh" 2>&1)
kill -0 "$other" 2>/dev/null && ok || bad "stop killed a process that is not the runner"
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null
[ ! -f "$R/runner.pid" ] && ok || bad "stop kept a stale pid file"

# --- start-arbiter.sh / stop-arbiter.sh / status / rotate call it, and only when installed
S="$ROOT/util/start-arbiter.sh"; P="$ROOT/util/stop-arbiter.sh"; ST="$ROOT/util/arbiter-status.sh"; RL="$ROOT/util/rotate-logs.sh"
has "start-arbiter starts the runner" "$(cat "$S")" 'CODE_RUNNER_DIR/start.sh'
has "start-arbiter only when installed" "$(cat "$S")" 'CODE_RUNNER_DIR/.env'
has "stop-arbiter stops the runner"  "$(cat "$P")" 'CODE_RUNNER_DIR/stop.sh'
has "status shows the runner"        "$(cat "$ST")" 'Code Runner'
has "rotate-logs rotates its logs"   "$(cat "$RL")" 'rotate_dir "$INSTALL_DIR/code-runner/logs"'
# The real rotation over a real file.
mkdir -p "$T/inst/ai-node" "$T/inst/external-adapter" "$T/inst/code-runner/logs" "$T/inst/util"
cp "$RL" "$T/inst/util/rotate-logs.sh"
echo old > "$T/inst/code-runner/logs/runner_old.log"; touch -t "$(date -d '2 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-2d +%Y%m%d%H%M)" "$T/inst/code-runner/logs/runner_old.log"
HOME="$T/nohome" bash "$T/inst/util/rotate-logs.sh" >/dev/null 2>&1
[ -f "$T/inst/code-runner/logs/runner_old.log.gz" ] && ok || bad "rotate-logs did not compress the runner's finished log"

# --- the boot unit waits for the runner's daemon, and works without it
unit=$(cd "$ROOT/util" && bash ./arbiter-boot-service.sh print-unit --user arbiter 2>/dev/null)
has "boot: ordered after its daemon" "$unit" '^After=.*verdikta-code-runner-docker.service'
has "boot: wants its daemon"         "$unit" '^Wants=.*verdikta-code-runner-docker.service'
hasnt "boot: requires nothing more"  "$unit" '^Requires=.*code-runner'

# --- deployed by both
for tool in code-review-sandbox.sh code-review-check.js; do
    grep -qE "^ *${tool//./\\.}( \\\\|; do)\$" "$ROOT/bin/upgrade-arbiter.sh" && ok || bad "$tool is not in upgrade's copy loop"
    grep -q "$tool" "$ROOT/bin/install.sh" && ok || bad "$tool is not deployed by install.sh"
done
has "upgrade carries the component" "$(cat "$ROOT/bin/upgrade-arbiter.sh")" 'upgrade_component "$REPO_CODE_RUNNER" "$TARGET_CODE_RUNNER" "Code Runner" ".env .state logs node_modules \*.pid"'
has "install copies the component"  "$(cat "$ROOT/bin/install.sh")" 'CODE_RUNNER_SRC_DIR'
# The same-version check covers the runner on both paths.
has "install: same-version check" "$(cat "$ROOT/bin/install.sh")" 'common-pin.js" --agree'
has "upgrade: same-version check" "$(cat "$ROOT/bin/upgrade-arbiter.sh")" 'common-pin.js" --agree'
# The answers are known to the validator and documented.
for key in VA_INSTALL_CODE_REVIEW_SANDBOX VA_UPGRADE_CODE_REVIEW_SANDBOX; do
    grep -q "$key" "$ROOT/bin/validate-answers.sh" && ok || bad "$key not in validate-answers.sh"
    grep -q "$key" "$ROOT/config/unattended.env.example" && ok || bad "$key not in the answers example"
    grep -q "$key" "$ROOT/docs/installation/unattended.md" && ok || bad "$key not in unattended.md"
done
grep -q 'VA_CODE_REVIEW_DISK_GB' "$ROOT/bin/validate-answers.sh" && ok || bad "VA_CODE_REVIEW_DISK_GB not validated"
grep -q 'VA_CODE_RUNNER_SLOTS' "$ROOT/bin/validate-answers.sh" && ok || bad "VA_CODE_RUNNER_SLOTS not validated"
grep -q 'VA_REGISTER_JOB_IDS' "$ROOT/docs/installation/unattended.md" && ok || bad "VA_REGISTER_JOB_IDS not documented"

echo "code-runner-lifecycle: pass=$pass fail=$fail"; [ "$fail" = 0 ]
