#!/bin/bash
# arbiter-doctor.sh's code-review checks (node A8; design §16): svc.code_runner,
# sandbox.runsc, sandbox.disk, sandbox.conformance, sandbox.trust and sandbox.registry; and
# ai.code_jurors (node A14): can the AI Node serve every juror of common's code-standard
# panels, read from its installed common at run time, with no paid call.
# Runs the doctor's REAL check_code_review and the REAL code-review-check.js against a
# fake runner and adapter (HTTP on loopback, from /health bodies this test writes) and
# stub mountpoint, findmnt and docker.
# Run: bash installer/tests/code-review-doctor.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^check_code_review\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract check_code_review from $DOCTOR"
grep -q '^check_code_review$' "$DOCTOR" && ok || bad "the doctor does not call check_code_review"

T=$(cd "$(mktemp -d)" && pwd -P); SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
HASH=$(printf 'cafe%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)
TOKEN=$(printf 'tok1%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)
I="$T/i"; M="$T/mnt"; mkdir -p "$I/code-runner-state" "$I/code-runner/node_modules/@verdikta/common" "$I/external-adapter" "$I/installer" "$T/bin" "$M"
cp "$ROOT/util/code-review-check.js" "$I/"
printf '%s\n' "$TOKEN" > "$I/code-runner-state/token"; chmod 600 "$I/code-runner-state/token"
# The AI Node's common, with the Q63 panels written out here (owner decision, 2026-11-09): the
# check reads whatever panels the installed release has, so this test does not depend on any.
AIC="$I/ai-node/node_modules/@verdikta/common"; mkdir -p "$AIC"
echo '{ "name": "@verdikta/common", "version": "9.9.9-test", "main": "index.js" }' > "$AIC/package.json"
q63_panels() {
cat > "$AIC/index.js" <<'J'
const juror = (AI_PROVIDER, AI_MODEL) => ({ AI_PROVIDER, AI_MODEL, NO_COUNTS: 1, WEIGHT: 0.5 });
module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134],
  CODE_STANDARD_PANEL: { NUMBER_OF_OUTCOMES: 6, ITERATIONS: 1, AI_NODES: [juror('openrouter', 'google/gemini-4-argon'), juror('openai', 'gpt-6-luna')] },
  CODE_STANDARD_DISPUTE_PANEL: { NUMBER_OF_OUTCOMES: 6, ITERATIONS: 1, AI_NODES: [juror('anthropic', 'claude-opus-5-5'), juror('openrouter', 'google/gemini-4-argon')] } } };
J
}
q63_panels
OAK=$(printf 'oa%.0s' 1 2 3 4 5 6 7 8); ANK=$(printf 'an%.0s' 1 2 3 4 5 6 7 8); ORK=$(printf 'or%.0s' 1 2 3 4 5 6 7 8)
keys() { # keys LINE... -> ai-node/.env.local holds exactly these lines
    printf '%s\n' "$@" > "$I/ai-node/.env.local"
}
all_keys() { keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK" "OPENROUTER_API_KEY=$ORK" "JUSTIFIER_MODEL=openai:gpt-6-luna"; }
all_keys
cat > "$I/code-runner/package.json" <<'J'
{ "name": "verdikta-code-runner", "version": "0.1.0", "dependencies": { "@verdikta/common": "9.9.9-test" } }
J
cat > "$I/code-runner/node_modules/@verdikta/common/package.json" <<'J'
{ "name": "@verdikta/common", "version": "9.9.9-test", "main": "index.js" }
J
cat > "$I/code-runner/node_modules/@verdikta/common/index.js" <<J
module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], GVISOR_RELEASE: 'release-20260921.0',
  CONFORMANCE_CANARY: { reportSha256: '$HASH', runner: '0.1.0' } } };
J
# The rule is real; what it compares with comes from this fake's pins.
mkdir -p "$I/code-runner/src"
cp "$ROOT/../code-runner/src/conformance.js" "$ROOT/../code-runner/src/version.js" "$I/code-runner/src/"
cat > "$I/code-runner/src/common.js" <<J
module.exports = { GVISOR_RELEASE: 'release-20260921.0', COMMON_VERSION: '9.9.9-test', CONFORMANCE_CANARY: { reportSha256: '$HASH' } };
J
echo '{"lock":1}' > "$I/code-runner/package-lock.json"
cat > "$T/bin/mountpoint" <<'E'
#!/bin/bash
[ "${STUB_UNMOUNTED:-0}" != 1 ]
E
cat > "$T/bin/findmnt" <<'E'
#!/bin/bash
case "$*" in *FSTYPE*) echo "${STUB_FSTYPE:-ext4}" ;; *SOURCE*) echo "${STUB_SOURCE:-/dev/loop7}" ;; *) echo "42949672960" ;; esac
E
cat > "$T/bin/docker" <<'E'
#!/bin/bash
[ -n "${STUB_DOCKER_LOG:-}" ] && echo "$*" >> "$STUB_DOCKER_LOG"
echo "${STUB_ROOTDIR:-$STUB_MOUNT/docker}"
E
chmod +x "$T/bin/"*
# The fake services: a request's token decides 401, bodies come from files.
cat > "$T/srv.js" <<'E'
const http = require('http'), fs = require('fs');
const [,, dir, token, runnerPort, adapterPort] = process.argv;
function serve(port, file, auth) {
  http.createServer((req, res) => {
    if (auth && req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end('{}'); }
    let body; try { body = fs.readFileSync(`${dir}/${file}`, 'utf8'); } catch (_) { req.socket.destroy(); return; }
    let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
    res.statusCode = auth && parsed.ok === false ? 503 : 200;
    res.end(body);
  }).listen(Number(port), '127.0.0.1');
}
serve(runnerPort, 'runner.json', true);
serve(adapterPort, 'adapter.json', false);
E
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
RP=$(free_port); AP=$(free_port)
node "$T/srv.js" "$T" "$TOKEN" "$RP" "$AP" & SRV=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    (node -e "require('net').connect($RP,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))") && break; sleep 0.3
done
cat > "$I/code-runner/.env" <<E
DOCKER_HOST=unix://$T/run/docker.sock
CODE_RUNNER_DATA_ROOT=$M
CODE_RUNNER_TOKEN_FILE=$I/code-runner-state/token
CODE_RUNNER_STATE_DIR=$I/code-runner-state
CODE_RUNNER_HOST=127.0.0.1
CODE_RUNNER_PORT=$RP
E
good_runner() {
cat > "$T/runner.json" <<E
{ "ok": true, "reasons": [], "service": "verdikta-code-runner", "version": "0.1.0", "runtime": "runsc", "runtimeAvailable": true,
  "runtimeArgs": ["--platform=systrap", "--overlay2=root:dir=$M/scratch,size=4g"], "gvisor": "release-20260921.0", "gvisorPinned": "release-20260921.0",
  "docker": { "reachable": true, "endpoint": "unix://$T/run/docker.sock" }, "dataRoot": { "path": "$M", "freeBytes": 38000000000, "error": null },
  "maintenance": false, "images": { "allowlist": [{ "entry": "ghcr.io/verdikta", "dev": false }] },
  "conformance": { "required": true, "problem": null } }
E
}
good_adapter() { echo '{ "status": "ok", "codeReview": { "enabled": true, "ready": true, "trust": "production", "problems": [] } }' > "$T/adapter.json"; }
good_pass() { node -e 'const c=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],JSON.stringify({pass:true,...c.expectedPass(),at:"2026-11-04T00:00:00Z"}))' "$I/code-runner/src/conformance.js" "$I/code-runner-state/conformance.json"; }
good() { good_runner; good_adapter; good_pass; }
edit() { # edit FILE 'js expression over d'
    node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f));eval(process.argv[2]);fs.writeFileSync(f,JSON.stringify(d));' "$1" "$2"
}
run() { # prints the findings as SEV id msg
    PATH="$T/bin:$PATH" INSTALL_DIR="$I" CODE_RUNNER_ADAPTER_URL="http://127.0.0.1:$AP" STUB_MOUNT="$M" bash -c '
        emit() { printf "%s %s %s | %s\n" "$1" "$2" "$3" "${4:-}"; }
        section_header() { :; }
        eval "$1"
        check_code_review
    ' _ "$fn" 2>&1
}
sev() { printf '%s\n' "$1" | awk -v id="$2" '$2==id{print $1; exit}'; }
is_sev() { # is_sev NAME OUT ID SEV
    local got; got=$(sev "$2" "$3")
    [ "$got" = "$4" ] && ok || bad "$1: $3 is [$got], expected [$4] in: $2"
}

# --- every check passes
good; out=$(run)
for id in svc.code_runner sandbox.runsc sandbox.disk sandbox.conformance sandbox.trust sandbox.registry; do is_sev "healthy" "$out" $id PASS; done
hasnt "the token never appears" "$out" "$TOKEN"

# --- svc.code_runner
good; edit "$T/runner.json" 'd.ok=false;d.reasons=["the maintenance lock is held"];d.maintenance=true'; out=$(run)
is_sev "503" "$out" svc.code_runner FAIL; has "503 names the reason" "$out" "maintenance lock"
good; rm -f "$T/runner.json"; out=$(run); is_sev "no answer" "$out" svc.code_runner FAIL
good; edit "$T/runner.json" 'd.docker.endpoint="unix:///var/run/docker.sock"'; out=$(run)
is_sev "the arbiter's Docker" "$out" svc.code_runner FAIL; has "the arbiter's Docker named" "$out" "not its own"
good; printf 'not-the-token\n' > "$I/code-runner-state/token"; out=$(run); is_sev "wrong token" "$out" svc.code_runner FAIL; printf '%s\n' "$TOKEN" > "$I/code-runner-state/token"

# --- the maintenance lock (#126, node A8d): the post-upgrade doctor ran while the upgrade held it, so
# svc.code_runner FAILed after every upgrade. The upgrade's own lock (its pid in the file, the same pid
# exported as CODE_REVIEW_LOCK_PARENT, still alive) is INFO when it is the runner's only reason;
# a lock anyone else holds still FAILs.
LOCKF="$I/code-runner-state/maintenance"
locked() { good; edit "$T/runner.json" "d.ok=false;d.maintenance=true;d.reasons=$1"; }
holds() { echo "code-review-sandbox $1 2026-11-07T00:00:00Z" > "$LOCKF"; }
sleep 300 & OTHER=$!                     # a live process that is not the upgrade
sleep 0 & GONE=$!; wait "$GONE"          # one that is gone
locked '["the maintenance lock is held"]'; holds $$
out=$(CODE_REVIEW_LOCK_PARENT=$$ run)
is_sev "the upgrade's own lock" "$out" svc.code_runner INFO; has "own lock: says whose" "$out" "this upgrade's own maintenance lock (pid $$)"
hasnt "own lock: no FAIL" "$out" "^FAIL"
out=$(run); is_sev "the same lock, no upgrade running the doctor" "$out" svc.code_runner FAIL; has "no upgrade: names the file" "$out" "stale: remove $LOCKF"
holds "$OTHER"; out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "another process's lock" "$out" svc.code_runner FAIL
hasnt "another's lock: not called the upgrade's" "$out" "this upgrade's own"
echo "operator" > "$LOCKF"; out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "an operator's lock (no pid)" "$out" svc.code_runner FAIL
: > "$LOCKF"; out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "a touched lock (empty)" "$out" svc.code_runner FAIL
holds "$GONE"; out=$(CODE_REVIEW_LOCK_PARENT=$GONE run); is_sev "a killed upgrade's lock" "$out" svc.code_runner FAIL
holds $$; out=$(CODE_REVIEW_LOCK_PARENT="$$x" run); is_sev "a malformed parent" "$out" svc.code_runner FAIL
rm -f "$LOCKF"; out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "no lock file" "$out" svc.code_runner FAIL
# The upgrade's lock and another reason: FAIL, with the other reason, and the lock not called stale.
locked '["the maintenance lock is held","no conformance pass for this release"]'; holds $$
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "own lock and another reason" "$out" svc.code_runner FAIL
has "own lock and another reason: the reason" "$out" "no conformance pass for this release"
has "own lock and another reason: whose lock" "$out" "this upgrade's own, pid $$"
hasnt "own lock and another reason: not stale" "$out" "stale"
# Another reason and no lock: FAIL even with the variable set.
good; edit "$T/runner.json" 'd.ok=false;d.reasons=["Docker unreachable"]'; holds $$
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "no maintenance, the variable set" "$out" svc.code_runner FAIL
# The lock must be the file the runner reads (code-runner/src/config.js: CODE_RUNNER_MAINTENANCE_FILE, else
# CODE_RUNNER_STATE_DIR/maintenance, else code-runner/.state/maintenance). The upgrade locks
# code-runner-state/maintenance; when the runner reads another file, the lock it reports is not the upgrade's.
cp "$I/code-runner/.env" "$T/env.keep"
renv() { cp "$T/env.keep" "$I/code-runner/.env"; [ -n "${1:-}" ] && printf '%s\n' "$1" >> "$I/code-runner/.env"; return 0; }
locked '["the maintenance lock is held"]'; holds $$
renv "CODE_RUNNER_MAINTENANCE_FILE=$T/operator-maintenance"; echo operator > "$T/operator-maintenance"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "the runner reads an operator's file elsewhere" "$out" svc.code_runner FAIL
has "elsewhere: names the runner's file" "$out" "stale: remove $T/operator-maintenance"
mkdir -p "$T/state-elsewhere"; renv "CODE_RUNNER_STATE_DIR=$T/state-elsewhere"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "the runner's state dir is elsewhere" "$out" svc.code_runner FAIL
grep -v '^CODE_RUNNER_STATE_DIR=' "$T/env.keep" > "$I/code-runner/.env"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "no state dir: the runner reads code-runner/.state" "$out" svc.code_runner FAIL
renv "CODE_RUNNER_MAINTENANCE_FILE=$LOCKF"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "the runner names the upgrade's file" "$out" svc.code_runner INFO
ln -s "$I/code-runner-state" "$T/state-link"; renv "CODE_RUNNER_STATE_DIR=$T/state-link"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "the same file through a link" "$out" svc.code_runner INFO
renv "CODE_RUNNER_MAINTENANCE_FILE=code-runner-state/maintenance"
out=$(CODE_REVIEW_LOCK_PARENT=$$ run); is_sev "a relative file" "$out" svc.code_runner FAIL
renv; rm -f "$T/operator-maintenance" "$T/state-link"
kill "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null; rm -f "$LOCKF"

# The same through the REAL lock block of upgrade-arbiter.sh, as the upgrade runs it: it takes the lock
# and exports its pid, its post-upgrade doctor is a child process, and its EXIT trap lets the lock go.
UPG="$ROOT/bin/upgrade-arbiter.sh"
lockblk=$(awk '/^# Hold the code runner.s maintenance lock/{p=1} /^# If arbiter is running, stop it/{p=0} p{print}' "$UPG")
[ -n "$lockblk" ] && ok || bad "could not extract the lock block from $UPG"
locked '["the maintenance lock is held"]'
out=$(PATH="$T/bin:$PATH" TARGET_DIR="$I" UTIL_DIR="$ROOT/util" INSTALL_DIR="$I" CODE_RUNNER_ADAPTER_URL="http://127.0.0.1:$AP" STUB_MOUNT="$M" bash -c '
    set -e
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    echo "HOLDER=$(cat "$TARGET_DIR/code-runner-state/maintenance")"
    bash -c '\''emit() { printf "%s %s %s | %s\n" "$1" "$2" "$3" "${4:-}"; }; section_header() { :; }; eval "$1"; check_code_review'\'' _ "$2"
' _ "$lockblk" "$fn" 2>&1)
has "the upgrade block took the lock" "$out" "HOLDER=code-review-sandbox [0-9]"
is_sev "the post-upgrade doctor, under the upgrade's lock" "$out" svc.code_runner INFO
hasnt "the post-upgrade doctor: no FAIL" "$out" "^FAIL"
[ ! -f "$LOCKF" ] && ok || bad "the upgrade's EXIT trap left the lock: $(cat "$LOCKF")"
# The upgrade exports its pid before the post-upgrade doctor runs.
l_export=$(grep -n '^export CODE_REVIEW_LOCK_PARENT=\$\$$' "$UPG" | cut -d: -f1)
l_doctor=$(grep -n '"\$TARGET_DIR/arbiter-doctor.sh" --quiet; then' "$UPG" | cut -d: -f1)
[ -n "$l_export" ] && [ -n "$l_doctor" ] && [ "$l_export" -lt "$l_doctor" ] && ok || bad "CODE_REVIEW_LOCK_PARENT is not exported before the post-upgrade doctor ($l_export, $l_doctor)"

# --- sandbox.runsc
good; edit "$T/runner.json" 'd.runtime="runc"'; out=$(run); is_sev "runc" "$out" sandbox.runsc FAIL
good; edit "$T/runner.json" 'd.runtimeAvailable=false'; out=$(run); is_sev "no runtime" "$out" sandbox.runsc FAIL
good; edit "$T/runner.json" 'd.gvisor="release-20200101.0"'; out=$(run); is_sev "another release" "$out" sandbox.runsc FAIL
good; edit "$T/runner.json" 'd.gvisor=null'; out=$(run); is_sev "unmeasured release" "$out" sandbox.runsc FAIL
good; edit "$T/runner.json" 'd.runtimeArgs=["--platform=systrap","--overlay2=root:dir=/var/lib/code-runner-scratch,size=4g"]'; out=$(run)
is_sev "scratch on the root filesystem" "$out" sandbox.runsc FAIL; has "scratch named" "$out" "scratch"
good; rm -f "$T/runner.json"; out=$(run); is_sev "unknown when the runner is down" "$out" sandbox.runsc FAIL

# --- sandbox.disk
good; out=$(STUB_UNMOUNTED=1 run); is_sev "not mounted" "$out" sandbox.disk FAIL
good; out=$(STUB_FSTYPE=xfs run); is_sev "not ext4" "$out" sandbox.disk FAIL
good; out=$(STUB_SOURCE=/dev/sda1 run); is_sev "not a loop device" "$out" sandbox.disk FAIL
good; out=$(STUB_ROOTDIR=/var/lib/docker run); is_sev "the daemon stores elsewhere" "$out" sandbox.disk FAIL
good; edit "$T/runner.json" 'd.dataRoot.freeBytes=1000000000'; out=$(run); is_sev "low space" "$out" sandbox.disk WARN

# A sparse image, as fstrim would leave one: its writes spend the root filesystem.
good; python3 -c 'import sys; f=open(sys.argv[1],"wb"); f.truncate(40*1024**3); f.close()' "$M.img" 2>/dev/null || truncate -s 40G "$M.img"
out=$(run); is_sev "a sparse image" "$out" sandbox.disk WARN; has "a sparse image says what to run" "$out" "fallocate"; rm -f "$M.img"

# --- sandbox.conformance
good; rm -f "$I/code-runner-state/conformance.json"; out=$(run); is_sev "no pass" "$out" sandbox.conformance FAIL
good; sed -i.b 's/"reportSha256":"cafe/"reportSha256":"beef/' "$I/code-runner-state/conformance.json"; out=$(run); is_sev "another hash" "$out" sandbox.conformance FAIL
good; sed -i.b 's/"runner":"0.1.0"/"runner":"0.0.9"/' "$I/code-runner-state/conformance.json"; out=$(run); is_sev "another runner" "$out" sandbox.conformance FAIL

good; sed -i.b 's/"commonVersion":"9.9.9-test"/"commonVersion":"1.0.0"/' "$I/code-runner-state/conformance.json"; out=$(run); is_sev "another common" "$out" sandbox.conformance FAIL
good; cp "$I/code-runner/src/version.js" "$T/v.keep"; echo '// a change' >> "$I/code-runner/src/version.js"; out=$(run); is_sev "other source" "$out" sandbox.conformance FAIL; cp "$T/v.keep" "$I/code-runner/src/version.js"
# A runner that isn't asked to check would run claims on anything: code-runner/.env lost the setting.
good; edit "$T/runner.json" 'd.conformance.required=false'; out=$(run); is_sev "the runner does not check" "$out" sandbox.conformance FAIL; has "the runner does not check: names the setting" "$out" "CODE_RUNNER_CONFORMANCE_FILE"
good; edit "$T/runner.json" 'delete d.conformance'; out=$(run); is_sev "a runner with no such block" "$out" sandbox.conformance FAIL
# What the runner itself says of the pass counts: it holds the source it started with.
good; edit "$T/runner.json" 'd.ok=false;d.reasons=["no pass"];d.conformance.problem="the pass is for other source"'; out=$(run); is_sev "the runner disagrees" "$out" sandbox.conformance FAIL; has "the runner disagrees: says why" "$out" "other source"

# --- sandbox.trust: anything but production fails
for t in dev dev-refused refused unknown; do
    good; edit "$T/adapter.json" "d.codeReview.trust='$t'"; out=$(run); is_sev "trust $t" "$out" sandbox.trust FAIL
done
good; edit "$T/adapter.json" 'd.codeReview.ready=false;d.codeReview.problems=["the adapter runs another common"]'; out=$(run)
is_sev "not ready" "$out" sandbox.trust FAIL; has "not ready says why" "$out" "another common"
good; edit "$T/adapter.json" 'd.codeReview.enabled=false;d.codeReview.ready=false;d.codeReview.problems=["CODE_REVIEW_ENABLED is not true"]'; out=$(run); is_sev "off" "$out" sandbox.trust WARN
good; rm -f "$T/adapter.json"; out=$(run); is_sev "adapter down" "$out" sandbox.trust FAIL
good; edit "$T/adapter.json" 'delete d.codeReview'; out=$(run); is_sev "an adapter without the block" "$out" sandbox.trust FAIL

# --- sandbox.registry: a loopback (dev) entry on a production arbiter
good; edit "$T/runner.json" 'd.images.allowlist.push({entry:"127.0.0.1:5000",dev:true})'; out=$(run)
is_sev "dev entry" "$out" sandbox.registry FAIL; has "dev entry named" "$out" "127.0.0.1:5000"

# --- ai.code_jurors: every juror of the installed common's code-standard panels has a route (node A14)
msg() { printf '%s\n' "$1" | awk -v id="$2" '$2==id{print; exit}'; }
good; out=$(run); is_sev "every key" "$out" ai.code_jurors PASS
line=$(msg "$out" ai.code_jurors)
has "every key: names the release" "$line" "@verdikta/common 9.9.9-test"
has "every key: Gemini by OpenRouter" "$line" "openrouter google/gemini-4-argon: OpenRouter"
has "every key: Luna natively" "$line" "openai gpt-6-luna: native"
has "every key: Opus natively" "$line" "anthropic claude-opus-5-5: native"
for k in "$OAK" "$ANK" "$ORK"; do hasnt "no key value is printed" "$out" "$k"; done
# The fallback the gateway uses with no native key: the same jurors, by OpenRouter.
keys "OPENROUTER_API_KEY=$ORK"; out=$(run); is_sev "OpenRouter only" "$out" ai.code_jurors PASS
line=$(msg "$out" ai.code_jurors)
has "OpenRouter only: Luna by OpenRouter" "$line" "openai gpt-6-luna: OpenRouter"
has "OpenRouter only: Opus by OpenRouter" "$line" "anthropic claude-opus-5-5: OpenRouter"
keys "OPENAI_API_KEY=$OAK" "OPENROUTER_API_KEY=\"$ORK\""; out=$(run); is_sev "a quoted OpenRouter key, no Anthropic key" "$out" ai.code_jurors PASS
# Gemini has no native class: without the OpenRouter key every claim abstains.
keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK"; out=$(run); is_sev "no OpenRouter key" "$out" ai.code_jurors FAIL
line=$(msg "$out" ai.code_jurors)
has "no OpenRouter key: Gemini named" "$line" "google/gemini-4-argon"
has "no OpenRouter key: the key named" "$line" "OPENROUTER_API_KEY"
has "no OpenRouter key: says what follows" "$line" "abstain"
hasnt "no OpenRouter key: Luna is served" "$line" "gpt-6-luna needs"
has "no OpenRouter key: says where keys go" "$out" "installer/.api_keys"
keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK" "OPENROUTER_API_KEY="; out=$(run); is_sev "an empty OpenRouter key" "$out" ai.code_jurors FAIL
keys; out=$(run); is_sev "no keys at all" "$out" ai.code_jurors FAIL
line=$(msg "$out" ai.code_jurors)
for j in google/gemini-4-argon gpt-6-luna claude-opus-5-5; do has "no keys: $j named" "$line" "$j"; done
rm -f "$I/ai-node/.env.local"; out=$(run); is_sev "no .env.local" "$out" ai.code_jurors FAIL; has "no .env.local: named" "$out" "ai-node/.env.local"
# The gateway's own overrides decide the route, as provider-config.ts does.
keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK" "AI_GATEWAY=openrouter"; out=$(run); is_sev "AI_GATEWAY=openrouter with no OpenRouter key" "$out" ai.code_jurors FAIL
has "AI_GATEWAY=openrouter: the override named" "$(msg "$out" ai.code_jurors)" "AI_GATEWAY"
keys "ANTHROPIC_API_KEY=$ANK" "OPENROUTER_API_KEY=$ORK" "OPENAI_CLASS_PROVIDER=native"; out=$(run); is_sev "OPENAI_CLASS_PROVIDER=native with no OpenAI key" "$out" ai.code_jurors FAIL
line=$(msg "$out" ai.code_jurors)
has "class override: Luna named" "$line" "gpt-6-luna"; has "class override: the override named" "$line" "OPENAI_CLASS_PROVIDER"
hasnt "class override: Gemini is served" "$line" "gemini-4-argon needs"
keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK" "OPENROUTER_API_KEY=$ORK" "ANTHROPIC_CLASS_PROVIDER= OpenRouter "; out=$(run)
is_sev "an override with case and spaces" "$out" ai.code_jurors PASS; has "an override: Opus by OpenRouter" "$(msg "$out" ai.code_jurors)" "anthropic claude-opus-5-5: OpenRouter"
# The panels come from the installed common at run time: another release, other jurors.
cat > "$AIC/index.js" <<'J'
module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134],
  CODE_STANDARD_PANEL: { AI_NODES: [{ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5' }, { AI_PROVIDER: 'openrouter', AI_MODEL: 'deepseek/deepseek-v4-pro-0813' }] },
  CODE_STANDARD_DISPUTE_PANEL: { AI_NODES: [{ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5' }, { AI_PROVIDER: 'openai', AI_MODEL: 'gpt-6-sol' }] } } };
J
keys "OPENROUTER_API_KEY=$ORK"; out=$(run); is_sev "another release's panels" "$out" ai.code_jurors PASS
line=$(msg "$out" ai.code_jurors)
has "another release: its juror" "$line" "anthropic claude-sonnet-5-5: OpenRouter"; hasnt "another release: not the Q63 jurors" "$line" "gemini"
echo 'module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134] } };' > "$AIC/index.js"; out=$(run)
is_sev "a release with no panels" "$out" ai.code_jurors WARN
echo 'module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], CODE_STANDARD_PANEL: { AI_NODES: [{ AI_PROVIDER: "google", AI_MODEL: "gemini-4-argon" }] } } };' > "$AIC/index.js"; out=$(run)
is_sev "a provider the gateway has no class for" "$out" ai.code_jurors FAIL; has "an unknown provider: named" "$(msg "$out" ai.code_jurors)" "google"
mv "$AIC" "$T/aic.off"; out=$(run); is_sev "no AI Node common" "$out" ai.code_jurors WARN; mv "$T/aic.off" "$AIC"
q63_panels; all_keys
# No paid call, and no call at all: the check reads two files. Any connection or lookup is refused here.
cat > "$T/no-net.js" <<'E'
const net = require('net'), dns = require('dns'), fs = require('fs');
const refuse = (what) => { fs.appendFileSync(process.env.NO_NET_LOG, `${what}\n`); throw new Error(`no network here: ${what}`); };
net.Socket.prototype.connect = function () { refuse('connect'); };
dns.lookup = () => refuse('dns.lookup');
globalThis.fetch = () => refuse('fetch');
E
: > "$T/net.log"
jout=$(NO_NET_LOG="$T/net.log" node -r "$T/no-net.js" "$I/code-review-check.js" jurors --install-dir "$I"); jrc=$?
[ "$jrc" = 0 ] && ok || bad "jurors: rc $jrc for a node that serves every juror: $jout"
[ ! -s "$T/net.log" ] && ok || bad "the juror check opened a connection: $(cat "$T/net.log")"
has "jurors: JSON for each juror" "$jout" '"model":"google/gemini-4-argon"'
keys "OPENAI_API_KEY=$OAK"; NO_NET_LOG="$T/net.log" node -r "$T/no-net.js" "$I/code-review-check.js" jurors --install-dir "$I" >/dev/null; jrc=$?
[ "$jrc" = 1 ] && ok || bad "jurors: rc $jrc for a node that cannot serve Gemini, expected 1"
[ ! -s "$T/net.log" ] && ok || bad "the juror check opened a connection: $(cat "$T/net.log")"
all_keys

# --- not installed: one INFO, and no noise for a text-only arbiter
good; mv "$I/code-runner/.env" "$T/env.off"; rm -f "$I/code-runner-state/conformance.json"; out=$(run)
is_sev "not installed" "$out" sandbox.skipped INFO
hasnt "not installed: no FAIL" "$out" "^FAIL"
# A text-only arbiter needs no juror of a code panel: no finding, even with no key at all.
keys; out=$(run); hasnt "text-only: no juror check" "$out" "ai.code_jurors"; hasnt "text-only, no keys: no FAIL" "$out" "^FAIL"; all_keys
# ... and a disk image with no sandbox is 40 GB nobody is using.
mkdir -p "$T/prefix/var/lib"; : > "$T/prefix/var/lib/verdikta-code-runner.img"
out=$(VERDIKTA_SANDBOX_PREFIX="$T/prefix" run); is_sev "an orphan image" "$out" sandbox.disk WARN
rm -rf "$T/prefix"
# ... but a node registered on a code class without it is broken.
printf 'CLASSES_ID="128 133"\n' > "$I/installer/.contracts"; out=$(run)
is_sev "registered without a sandbox" "$out" svc.code_runner FAIL
is_sev "registered without a sandbox: its jurors are checked" "$out" ai.code_jurors PASS
keys "OPENAI_API_KEY=$OAK" "ANTHROPIC_API_KEY=$ANK"; out=$(run); is_sev "registered, no OpenRouter key" "$out" ai.code_jurors FAIL; all_keys
rm -f "$I/installer/.contracts"
# ... and so is an adapter turned on by hand.
echo 'CODE_REVIEW_ENABLED=true' > "$I/external-adapter/.env"; out=$(run)
is_sev "turned on without a sandbox" "$out" svc.code_runner FAIL
keys "OPENROUTER_API_KEY=$ORK"; out=$(run); is_sev "turned on without a sandbox: its jurors are checked" "$out" ai.code_jurors PASS; all_keys
rm -f "$I/external-adapter/.env"
mv "$T/env.off" "$I/code-runner/.env"

echo "code-review-doctor: pass=$pass fail=$fail"; [ "$fail" = 0 ]
