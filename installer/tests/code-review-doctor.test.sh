#!/bin/bash
# arbiter-doctor.sh's code-review checks (node A8; design §16): svc.code_runner,
# sandbox.runsc, sandbox.disk, sandbox.conformance, sandbox.trust and sandbox.registry.
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

# --- not installed: one INFO, and no noise for a text-only arbiter
good; mv "$I/code-runner/.env" "$T/env.off"; rm -f "$I/code-runner-state/conformance.json"; out=$(run)
is_sev "not installed" "$out" sandbox.skipped INFO
hasnt "not installed: no FAIL" "$out" "^FAIL"
# ... and a disk image with no sandbox is 40 GB nobody is using.
mkdir -p "$T/prefix/var/lib"; : > "$T/prefix/var/lib/verdikta-code-runner.img"
out=$(VERDIKTA_SANDBOX_PREFIX="$T/prefix" run); is_sev "an orphan image" "$out" sandbox.disk WARN
rm -rf "$T/prefix"
# ... but a node registered on a code class without it is broken.
printf 'CLASSES_ID="128 133"\n' > "$I/installer/.contracts"; out=$(run)
is_sev "registered without a sandbox" "$out" svc.code_runner FAIL
rm -f "$I/installer/.contracts"
# ... and so is an adapter turned on by hand.
echo 'CODE_REVIEW_ENABLED=true' > "$I/external-adapter/.env"; out=$(run)
is_sev "turned on without a sandbox" "$out" svc.code_runner FAIL
rm -f "$I/external-adapter/.env"
mv "$T/env.off" "$I/code-runner/.env"

echo "code-review-doctor: pass=$pass fail=$fail"; [ "$fail" = 0 ]
