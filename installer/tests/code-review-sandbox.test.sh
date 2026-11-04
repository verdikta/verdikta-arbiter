#!/bin/bash
# The code-review sandbox phase (node A8; design §16, §9.1, §9.6), the REAL
# installer/util/code-review-sandbox.sh against stubs of everything that touches
# the host: systemctl, mount, docker, dockerd, curl, mkfs. Every host path sits under
# VERDIKTA_SANDBOX_PREFIX. What this pins: it never restarts or reloads the arbiter's
# Docker, never touches cl-postgres or /etc/docker, a failed first enable leaves no
# disk image behind, an upgrade's refresh keeps what it has, the lock is held and
# let go, dev trust is never written. What real dockerd and gVisor do is measured by
# code-review-sandbox.integration.sh.
# Run: bash installer/tests/code-review-sandbox.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
TOOL="$ROOT/util/code-review-sandbox.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
is()    { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }

T=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$T"' EXIT
STUBS="$T/stubs"; mkdir -p "$STUBS"
stub() { printf '#!/bin/bash\n%s\n' "$2" > "$STUBS/$1"; chmod +x "$STUBS/$1"; }

# systemctl: every call logged; is-active follows a state dir; start marks active.
stub systemctl 'echo "systemctl $*" >> "$STUB_LOG"
verb="$1"; shift
case "$verb" in
  start|restart) for u in "$@"; do if [ "${STUB_UNIT_FAIL:-}" = "${u%.service}" ]; then exit 1; fi; : > "$STUB_STATE/active-${u%.service}"; done ;;
  stop) for u in "$@"; do rm -f "$STUB_STATE/active-${u%.service}"; done ;;
  is-active) shift_q=0; [ "$1" = "--quiet" ] && shift; [ -f "$STUB_STATE/active-${1%.service}" ]; exit $? ;;
  is-enabled) [ "$1" = "--quiet" ] && shift; exit 1 ;;
esac
exit 0'
# docker: every call logged with its environment host; info answers from what it is told.
stub docker 'echo "docker DOCKER_HOST=${DOCKER_HOST:-} $*" >> "$STUB_LOG"
case "$*" in
  *"info --format {{.DockerRootDir}}"*) echo "${STUB_ROOTDIR:-$VERDIKTA_SANDBOX_PREFIX/var/lib/verdikta-code-runner/docker}" ;;
  *"info --format {{.Driver}}"*) echo "${STUB_DRIVER:-overlay2}" ;;
  *"(index .Runtimes"*) if [ -n "${STUB_RUNSC_PATH_FILE:-}" ] && [ -f "$STUB_RUNSC_PATH_FILE" ]; then cat "$STUB_RUNSC_PATH_FILE"; else echo "${STUB_RUNSC_PATH:-$VERDIKTA_SANDBOX_PREFIX/opt/gvisor/20260921.0/runsc}"; fi ;;
  *" version "*) echo 28.0.4 ;;
  *" pull "*) if [ -n "${STUB_LOCK:-}" ] && [ -f "$STUB_LOCK" ]; then echo "lock-held-during-pull" >> "$STUB_LOG"; fi
     [ "${STUB_PULL_FAIL:-0}" = 1 ] && exit 1 ;;
  *"image inspect"*) [ "${STUB_NOT_WARM:-0}" = 1 ] && exit 1 ;;
esac
exit 0'
stub dockerd 'echo "dockerd $*" >> "$STUB_LOG"; exit 0'
stub containerd 'exit 0'
stub curl 'echo "curl $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { shift; : > "$1"; }; shift; done; [ "${STUB_CURL_FAIL:-0}" = 1 ] && exit 22; exit 0'
stub sha512sum 'cat > "$STUB_STATE/sha-input"; [ "${STUB_SHA_FAIL:-0}" = 1 ] && exit 1; exit 0'
stub tar 'echo "tar $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do if [ "$1" = "-C" ]; then shift; printf "#!/bin/bash\necho runsc version release-20260921.0\n" > "$1/runsc"; chmod +x "$1/runsc"; fi; shift; done; exit 0'
stub bzip2 'exit 0'
stub fallocate 'echo "fallocate $*" >> "$STUB_LOG"; [ "${STUB_FALLOCATE_FAIL:-0}" = 1 ] && exit 1; for last; do :; done; : > "$last"; exit 0'
stub mkfs.ext4 'echo "mkfs.ext4 $*" >> "$STUB_LOG"; [ "${STUB_MKFS_FAIL:-0}" = 1 ] && exit 1; exit 0'
stub mount 'echo "mount $*" >> "$STUB_LOG"; exit 0'
stub umount 'echo "umount $*" >> "$STUB_LOG"; : ; rm -f "$STUB_STATE/mounted"; exit 0'
stub mountpoint '[ -f "$STUB_STATE/active-verdikta-code-runner-disk" ]'
stub df 'echo "Avail"; echo "${STUB_AVAIL:-500000000000}"'
stub uname 'if [ "$1" = "-m" ]; then echo "${STUB_ARCH:-x86_64}"; else /usr/bin/uname "$@"; fi'
stub runuser 'shift 2; [ "$1" = "--" ] && shift; "$@"'
stub npm 'echo "npm $*" >> "$STUB_LOG"; exit 0'
stub timeout 'shift; "$@"'
stub sudo 'if [ "${STUB_NO_SUDO:-0}" = 1 ]; then exit 1; fi; [ "$1" = "-n" ] && shift; "$@"'
# chown as a stub: the tests run as one user.
stub chown 'exit 0'
# env -i stays env -i, and is logged: only what a test's stand-in needs to report goes through it.
stub env 'if [ "$1" = "-i" ]; then echo "env -i" >> "$STUB_LOG"; shift; exec /usr/bin/env -i STUB_LOG="$STUB_LOG" STUB_LOCK="$STUB_LOCK" STUB_CANARY_EXIT="${STUB_CANARY_EXIT:-}" STUB_HASH="${STUB_HASH:-}" "$@"; fi; exec /usr/bin/env "$@"'

fresh() { # a new prefix and install tree; sets P, I
    rm -rf "$T/p"; P="$T/p"; I="$T/p/install"
    mkdir -p "$P/etc/docker" "$P/var/lib" "$P/run" "$P/opt" "$I/installer" "$I/external-adapter" "$I/code-runner/.state" "$I/code-runner/node_modules/@verdikta/common" "$I/code-runner/src" "$I/code-runner/conformance" "$P/state" "$P/etc/systemd/system"
    echo '{"live-restore":false}' > "$P/etc/docker/daemon.json"
    : > "$P/log"
    cp "$ROOT/util/code-review-check.js" "$ROOT/util/common-pin.js" "$I/"
    cat > "$I/code-runner/package.json" <<'J'
{ "name": "verdikta-code-runner", "version": "0.1.0", "dependencies": { "@verdikta/common": "9.9.9-test" } }
J
    mkdir -p "$I/ai-node" ; cp "$I/code-runner/package.json" "$I/ai-node/package.json"; cp "$I/code-runner/package.json" "$I/external-adapter/package.json"
    cat > "$I/code-runner/node_modules/@verdikta/common/package.json" <<'J'
{ "name": "@verdikta/common", "version": "9.9.9-test", "main": "index.js" }
J
    cat > "$I/code-runner/node_modules/@verdikta/common/index.js" <<'J'
module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], GVISOR_RELEASE: 'release-20260921.0', OCI_PLATFORM: 'linux/amd64',
  BASE_IMAGE_PINS: { foundry: { reference: 'ghcr.io/foundry-rs/foundry:v1.8.5@sha256:aaa' } },
  CONFORMANCE_CANARY: { reportSha256: 'cafe'.repeat(16), runner: '0.1.0' } } };
J
    cat > "$I/code-runner/src/semgrepPin.js" <<'J'
module.exports = { SEMGREP: { reference: 'docker.io/semgrep/semgrep@sha256:bbb' } };
J
    # The conformance entry point: writes what the real one writes, or fails on demand.
    cat > "$I/code-runner/conformance/run.js" <<'J'
const fs = require('fs');
const a = process.argv; const out = a[a.indexOf('--json') + 1];
if (process.env.STUB_LOCK && fs.existsSync(process.env.STUB_LOCK)) fs.appendFileSync(process.env.STUB_LOG, 'lock-held-during-self-test\n');
fs.appendFileSync(process.env.STUB_LOG, `conformance DOCKER_HOST=${process.env.DOCKER_HOST} REGNET=${process.env.CODE_RUNNER_CONFORMANCE_REGISTRY_NETWORK} RUNTIME=${process.env.CODE_RUNNER_RUNTIME} TMPDIR=${process.env.TMPDIR} KEY=${process.env.STUB_SECRET_KEY || 'none'}\n`);
if (process.env.STUB_CANARY_EXIT) process.exit(Number(process.env.STUB_CANARY_EXIT));
fs.writeFileSync(out, JSON.stringify({ canonical: true, reportSha256: process.env.STUB_HASH || 'cafe'.repeat(16), runner: '0.1.0', gvisor: 'release-20260921.0' }));
J
    printf '#!/bin/bash\necho "runner-start DOCKER_HOST=$(grep ^DOCKER_HOST= .env 2>/dev/null)" >> "$STUB_LOG"; exit "${STUB_RUNNER_START_RC:-0}"\n' > "$I/code-runner/start.sh"
    (cd "$I/code-runner" && sed -i.bak 's#^echo "runner-start.*#echo "runner-start" >> "$STUB_LOG"; exit "${STUB_RUNNER_START_RC:-0}"#' start.sh && rm -f start.sh.bak)
    printf '#!/bin/bash\necho runner-stop >> "$STUB_LOG"; exit 0\n' > "$I/code-runner/stop.sh"
    printf '#!/bin/bash\necho adapter-stop >> "$STUB_LOG"; exit 0\n' > "$I/external-adapter/stop.sh"
    printf '#!/bin/bash\necho adapter-start >> "$STUB_LOG"; exit 0\n' > "$I/external-adapter/start.sh"
    printf 'OPERATOR_ADDR=0xabc\nIPFS_PINNING_KEY=not-a-real-key\n' > "$I/external-adapter/.env"
    printf 'DEPLOYMENT_NETWORK="base_sepolia"\nNETWORK_CHAIN_ID="84532"\nPRIVATE_KEY="not-a-real-key"\n' > "$I/installer/.env"
    : > "$P/state/.keep"
    DAEMON_BEFORE=$(cat "$P/etc/docker/daemon.json")
}
run() { # run ARGS... (the environment passes through)
    PATH="$STUBS:$PATH" VERDIKTA_SANDBOX_PREFIX="$P" VERDIKTA_SYSTEMD_UNIT_DIR="$P/etc/systemd/system" STUB_LOG="$P/log" STUB_STATE="$P/state" \
    STUB_LOCK="$I/code-runner/.state/maintenance" VERDIKTA_UNATTENDED=1 \
    bash "$TOOL" "$@" --install-dir "$I" --user "$(id -un)"
}
log()  { cat "$P/log"; }
own_units='verdikta-code-runner-(disk|containerd|docker)'

# --- print-config: the isolation, as text a reviewer can read
fresh
cfg=$(run print-config); rc=$?
is "print-config rc" "$rc" 0
daemon=$(printf '%s\n' "$cfg" | awk '/^# daemon\.json/{p=1;next} /^# /{p=0} p')
parsed=$(printf '%s' "$daemon" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const out=[];
for (const k of ["bridge","iptables","ip6tables","ip-forward","ip-masq","userland-proxy","storage-driver","live-restore"]) out.push(`${k}=${d[k]}`);
out.push(`snapshotter=${d.features&&d.features["containerd-snapshotter"]}`);
out.push(`hosts=${d.hosts.join(",")}`); out.push(`data-root=${d["data-root"]}`); out.push(`exec-root=${d["exec-root"]}`); out.push(`pidfile=${d.pidfile}`);
out.push(`containerd=${d.containerd}`); out.push(`ns=${d["containerd-namespace"]}`); out.push(`pns=${d["containerd-plugins-namespace"]}`); out.push(`runsc=${d.runtimes.runsc.path}`); out.push(`args=${d.runtimes.runsc.runtimeArgs.join(" ")}`);
console.log(out.join("\n"));')
has "no default bridge"    "$parsed" "^bridge=none$"
has "no iptables"          "$parsed" "^iptables=false$"
has "no ip6tables"         "$parsed" "^ip6tables=false$"
has "no ip forward change" "$parsed" "^ip-forward=false$"
has "no masquerade"        "$parsed" "^ip-masq=false$"
has "no containerd store: layers stay on the fixed disk" "$parsed" "^snapshotter=false$"
has "overlay2 pinned"      "$parsed" "^storage-driver=overlay2$"
has "own socket only"      "$parsed" "^hosts=unix://$P/run/verdikta-code-runner/docker.sock$"
has "data root on the disk" "$parsed" "^data-root=$P/var/lib/verdikta-code-runner/docker$"
has "own exec root"        "$parsed" "^exec-root=$P/run/verdikta-code-runner/exec$"
has "own pid file"         "$parsed" "^pidfile=$P/run/verdikta-code-runner/docker.pid$"
has "own containerd"       "$parsed" "^containerd=$P/run/verdikta-code-runner/containerd/containerd.sock$"
has "own containerd namespace" "$parsed" "^ns=verdikta-code-runner$"
has "own plugins namespace" "$parsed" "^pns=verdikta-code-runner-plugins$"
has "gVisor at an absolute pinned path" "$parsed" "^runsc=$P/opt/gvisor/20260921.0/runsc$"
has "systrap" "$parsed" "^args=--platform=systrap "
has "the scratch overlay is on the fixed disk, not the root filesystem" "$parsed" "overlay2=root:dir=$P/var/lib/verdikta-code-runner/scratch,size=4g"
hasnt "never the arbiter's socket"    "$cfg" "/var/run/docker.sock"
hasnt "never the arbiter's data root" "$cfg" "/var/lib/docker"
unit=$(printf '%s\n' "$cfg" | awk '/^# verdikta-code-runner-docker\.service/{p=1;next} /^# /{p=0} p')
has "dockerd uses its own config" "$unit" "dockerd --config-file $P/etc/verdikta-code-runner/daemon.json"
has "dockerd bound to the disk"   "$unit" "^BindsTo=.*verdikta-code-runner-disk.service"
has "dockerd refuses an unmounted disk" "$unit" "^AssertPathIsMountPoint=$P/var/lib/verdikta-code-runner$"
has "reload is a HUP, no restart" "$unit" '^ExecReload=/bin/kill -s HUP \$MAINPID'
hasnt "no dependency on the arbiter's Docker" "$cfg" "[= ]docker.service"
hasnt "no dependency on the arbiter's containerd" "$cfg" "^After=.* containerd.service"
hasnt "no socket activation"      "$cfg" "docker.socket"
ctd=$(printf '%s\n' "$cfg" | awk '/^# containerd\.toml/{p=1;next} /^# /{p=0} p')
has "containerd root on the disk" "$ctd" "^root = \"$P/var/lib/verdikta-code-runner/containerd\""
has "containerd own socket"       "$ctd" "address = \"$P/run/verdikta-code-runner/containerd/containerd.sock\""
hasnt "containerd never the system socket" "$ctd" '"/run/containerd'

# --- enable on a fresh host
fresh
out=$(STUB_SECRET_KEY=leaked run enable 2>&1); rc=$?
is "enable rc" "$rc" 0
has "self-test: nothing of the caller's environment" "$(log)" "^conformance .*KEY=none$"
has "self-test: env -i" "$(log)" "^env -i$"
is "/etc/docker untouched" "$(cat "$P/etc/docker/daemon.json")" "$DAEMON_BEFORE"
# Only this phase's own units, whatever the verb; the arbiter's Docker and containerd never.
l=$(log)
sysc=$(printf '%s\n' "$l" | grep '^systemctl ' | grep -vE '^systemctl (daemon-reload|is-active|is-enabled)' )
odd=$(printf '%s\n' "$sysc" | grep -vE "^systemctl [a-z-]+( --[a-z]+)*( $own_units(\\.service)?)+$")
is "systemctl names own units only" "$odd" ""
hasnt "never restart anything but its own" "$l" "restart docker"
hasnt "never reload the arbiter's Docker"  "$l" "reload docker"
hasnt "never stop the arbiter's Docker"    "$l" "stop docker"
hasnt "never touch cl-postgres"            "$l" "cl-postgres"
hasnt "never touch chainlink"              "$l" " chainlink"
# Every docker call goes to the runner's own daemon.
dockers=$(printf '%s\n' "$l" | grep '^docker ')
[ -n "$dockers" ] && ok || bad "no docker calls logged"
strays=$(printf '%s\n' "$dockers" | grep -v -- "--host unix://$P/run/verdikta-code-runner/docker.sock" | grep -v "DOCKER_HOST=unix://$P/run/verdikta-code-runner/docker.sock")
is "every docker call names the runner's socket" "$strays" ""
has "SHA-512 checked" "$(cat "$P/state/sha-input")" "^7c899979bed334f0987888c41e545cede8e1f7e67a257978c8de244c3867e32bc30d08491e9af36720273c502acd01d8d86c9844ebcbe125790c43fe6bdf563e  "
has "gVisor executable by anyone: the runner's user asks it its release" "$(stat -c '%a' "$P/opt/gvisor/20260921.0/runsc" 2>/dev/null || stat -f '%Lp' "$P/opt/gvisor/20260921.0/runsc")" "755"
has "disk 40 GB by default" "$l" "^fallocate -l 40G "
has "ext4 without root's reserve" "$l" "^mkfs.ext4 .*-m 0"
hasnt "no partial image left" "$(ls "$P/var/lib")" "partial"
[ -f "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "no disk image"
has "warms the base by digest with a platform"   "$l" "pull --quiet --platform linux/amd64 ghcr.io/foundry-rs/foundry:v1.8.5@sha256:aaa"
has "warms Semgrep by digest with a platform"    "$l" "pull --quiet --platform linux/amd64 docker.io/semgrep/semgrep@sha256:bbb"
# Warm before the self-test: the self-test's own pull could hide a cold host.
pull_line=$(printf '%s\n' "$l" | grep -n ' pull ' | tail -1 | cut -d: -f1); self_line=$(printf '%s\n' "$l" | grep -n '^conformance ' | head -1 | cut -d: -f1)
[ -n "$self_line" ] && [ "$pull_line" -lt "$self_line" ] && ok || bad "warm then self-test: pull $pull_line, self-test $self_line"
has "the lock is held during the pull"      "$l" "lock-held-during-pull"
has "the lock is held during the self-test" "$l" "lock-held-during-self-test"
[ ! -e "$I/code-runner/.state/maintenance" ] && ok || bad "the lock was not let go"
has "self-test drives the runner's daemon" "$l" "^conformance DOCKER_HOST=unix://$P/run/verdikta-code-runner/docker.sock "
has "self-test's registry on the host network: the daemon has no bridge" "$l" "REGNET=host"
has "self-test under gVisor"   "$l" "RUNTIME=runsc"
has "self-test's temp files on the fixed disk" "$l" "TMPDIR=$P/var/lib/verdikta-code-runner/selftest"
[ -f "$I/code-runner/.state/conformance.json" ] && ok || bad "no pass recorded"
# The runner's environment.
envf=$(cat "$I/code-runner/.env")
has "runner env: own daemon" "$envf" "^DOCKER_HOST=unix://$P/run/verdikta-code-runner/docker.sock$"
has "runner env: gVisor"     "$envf" "^CODE_RUNNER_RUNTIME=runsc$"
has "runner env: the disk"   "$envf" "^CODE_RUNNER_DATA_ROOT=$P/var/lib/verdikta-code-runner$"
has "runner env: token file" "$envf" "^CODE_RUNNER_TOKEN_FILE=$I/code-runner/.state/token$"
has "runner env: allowlist"  "$envf" "^CODE_RUNNER_REGISTRY_ALLOWLIST=ghcr.io/verdikta$"
has "runner env: slots"      "$envf" "^CODE_RUNNER_SLOTS=1$"
has "runner env: model reserve" "$envf" "^CODE_RUNNER_RESERVE_LOCAL_MODEL_MB=0$"
hasnt "runner env: no key"   "$envf" "PRIVATE_KEY"
tok=$(cat "$I/code-runner/.state/token"); is "token length" "${#tok}" 64
is "token mode" "$(stat -c '%a' "$I/code-runner/.state/token" 2>/dev/null || stat -f '%Lp' "$I/code-runner/.state/token")" 600
hasnt "token never in the log or output" "$l$out" "$tok"
# The adapter's environment.
ea=$(cat "$I/external-adapter/.env")
has "adapter: on"      "$ea" "^CODE_REVIEW_ENABLED=true$"
has "adapter: production trust" "$ea" "^CODE_REVIEW_TRUST=production$"
has "adapter: runner url" "$ea" "^CODE_RUNNER_URL=http://127.0.0.1:8090$"
has "adapter: token file" "$ea" "^CODE_RUNNER_TOKEN_FILE=$I/code-runner/.state/token$"
has "adapter: chain"   "$ea" "^NETWORK_CHAIN_ID=84532$"
has "adapter: network" "$ea" "^DEPLOYMENT_NETWORK=base_sepolia$"
has "adapter: keeps its own lines" "$ea" "^OPERATOR_ADDR=0xabc$"
hasnt "adapter: never dev keys" "$ea" "CODE_REVIEW_DEV_KEYS"
# status
PATH="$STUBS:$PATH" true
out=$(run status --quiet 2>&1); is "status after enable" "$?" 0

# --- a second enable reuses the disk and asks for nothing new
: > "$P/log"
out=$(run enable 2>&1); rc=$?
is "re-enable rc" "$rc" 0
hasnt "re-enable: no new image" "$(log)" "^fallocate"
hasnt "re-enable: no mkfs"      "$(log)" "^mkfs.ext4"
hasnt "re-enable: no restart when nothing changed" "$(log)" "restart"
hasnt "re-enable: no gVisor download"  "$(log)" "gvisor.tar.bz2"
hasnt "re-enable: no self-test on a standing pass" "$(log)" "^conformance"

# --- a new gVisor path on a running daemon is a reload of its own daemon, no restart
printf '%s\n' "$P/opt/gvisor/old/runsc" > "$P/state/runsc-old"
sed -i.bak "s#$P/opt/gvisor/20260921.0/runsc#$P/opt/gvisor/old/runsc#" "$P/etc/verdikta-code-runner/daemon.json"; rm -f "$P/etc/verdikta-code-runner/daemon.json.bak"
: > "$P/log"
out=$(run enable 2>&1); rc=$?
is "gVisor change rc" "$rc" 0
has "reload of its own daemon" "$(log)" "^systemctl reload verdikta-code-runner-docker"
hasnt "no restart on a gVisor change" "$(log)" "restart"
hasnt "the arbiter's Docker is not reloaded" "$(log)" "^systemctl reload docker"

# --- SHA-512 mismatch: nothing installed, no disk made
fresh
out=$(STUB_SHA_FAIL=1 run enable 2>&1); rc=$?
is "bad SHA rc" "$rc" 1
has "bad SHA says so" "$out" "SHA-512"
[ ! -e "$P/opt/gvisor/20260921.0/runsc" ] && ok || bad "a binary of the wrong hash was installed"
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "a disk was made after a bad SHA"
[ ! -e "$I/code-runner/.state/maintenance" ] && ok || bad "lock left after a bad SHA"

# --- disk preflight, before anything is allocated
fresh
out=$(STUB_AVAIL=$((45*1024*1024*1024)) run enable 2>&1); rc=$?
is "too little room rc" "$rc" 4
has "too little room says so" "$out" "40 GB"
hasnt "too little room: nothing allocated" "$(log)" "^fallocate"
fresh
out=$(run enable --disk-gb 5 2>&1); rc=$?
is "below minimum rc" "$rc" 64
hasnt "below minimum: nothing allocated" "$(log)" "^fallocate"
fresh
out=$(run enable --disk-gb 20 2>&1); rc=$?
is "a smaller disk rc" "$rc" 0
has "a smaller disk" "$(log)" "^fallocate -l 20G "
out=$(run enable --disk-gb 60 2>&1)
has "an existing disk is never resized" "$out" "disable --purge"
hasnt "no second allocation" "$(tail -n +2 "$P/log" | grep -c '^fallocate' | grep -v '^0$')" "2"

# --- a failed first enable leaves no disk image behind, whichever step it failed at
fail_case() { # NAME ENV=VAL
    fresh
    out=$(env "$2" bash -c 'true' ; )
    out=$(eval "$2 run enable" 2>&1); rc=$?
    is "$1: rc" "$rc" 1
    [ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "$1: the disk image stayed"
    [ ! -e "$P/var/lib/verdikta-code-runner.img.partial" ] && ok || bad "$1: a partial image stayed"
    [ ! -e "$P/etc/systemd/system/verdikta-code-runner-docker.service" ] && ok || bad "$1: a unit stayed"
    [ ! -e "$I/code-runner/.env" ] && ok || bad "$1: the runner env stayed"
    [ ! -e "$I/code-runner/.state/maintenance" ] && ok || bad "$1: the lock stayed"
    [ ! -e "$I/code-runner/.state/conformance.json" ] && ok || bad "$1: a pass stayed"
    hasnt "$1: adapter stays off" "$(cat "$I/external-adapter/.env")" "CODE_REVIEW_ENABLED=true"
    is "$1: /etc/docker untouched" "$(cat "$P/etc/docker/daemon.json")" "$DAEMON_BEFORE"
    hasnt "$1: no Docker restart on the way out" "$(log)" "restart docker"
}
fail_case "fallocate fails"   "STUB_FALLOCATE_FAIL=1"
fail_case "mkfs fails"        "STUB_MKFS_FAIL=1"
fail_case "disk unit fails"   "STUB_UNIT_FAIL=verdikta-code-runner-disk"
fail_case "dockerd fails"     "STUB_UNIT_FAIL=verdikta-code-runner-docker"
fail_case "wrong data root"   "STUB_ROOTDIR=/var/lib/docker"
fail_case "wrong driver"      "STUB_DRIVER=overlayfs"
fail_case "a pull fails"      "STUB_PULL_FAIL=1"
fail_case "self-test exits 1" "STUB_CANARY_EXIT=1"
fail_case "another hash"      "STUB_HASH=$(printf 'beef%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)"
# A wrong data root must name the arbiter's Docker as the reason.
fresh
out=$(STUB_ROOTDIR=/var/lib/docker run enable 2>&1)
has "wrong data root explained" "$out" "/var/lib/docker"

# --- a failed refresh (an upgrade's) keeps what is there, and code mode goes off
fresh
run enable >/dev/null 2>&1
printf '{"bogus":1}' > "$I/code-runner/.state/conformance.json"
: > "$P/log"
out=$(STUB_CANARY_EXIT=1 run enable 2>&1); rc=$?
is "failed refresh rc" "$rc" 1
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "a refresh removed the disk"
[ -e "$I/code-runner/.env" ] && ok || bad "a refresh removed the runner env"
[ ! -e "$I/code-runner/.state/conformance.json" ] && ok || bad "a failed refresh kept a pass"
has "failed refresh: code mode off" "$(cat "$I/external-adapter/.env")" "^CODE_REVIEW_ENABLED=false$"
[ ! -e "$I/code-runner/.state/maintenance" ] && ok || bad "a failed refresh left the lock"
out=$(run status --quiet 2>&1); is "status after a failed refresh" "$?" 2

# --- the self-test refuses a cold host: its own pull would hide it
fresh
run enable >/dev/null 2>&1
rm -f "$I/code-runner/.state/conformance.json"
: > "$P/log"
out=$(STUB_NOT_WARM=1 run self-test 2>&1); rc=$?
is "cold host rc" "$rc" 1
has "cold host says so" "$out" "warm"
hasnt "cold host: the canary never ran" "$(log)" "^conformance"

# --- a lock somebody else holds is not taken from them
fresh
run enable >/dev/null 2>&1
echo "by hand" > "$I/code-runner/.state/maintenance"
rm -f "$I/code-runner/.state/conformance.json"
out=$(run enable 2>&1); rc=$?
is "with another's lock rc" "$rc" 0
is "another's lock stays" "$(cat "$I/code-runner/.state/maintenance")" "by hand"

# --- status exit codes
fresh
out=$(run status --quiet 2>&1); is "status: not installed" "$?" 1
out=$(STUB_ARCH=aarch64 run status --quiet 2>&1); is "status: not x86_64" "$?" 4
out=$(STUB_ARCH=aarch64 run enable 2>&1); is "enable: not x86_64" "$?" 4
# no root and no sudo
if [ "$(id -u)" != 0 ]; then
    fresh
    out=$(STUB_NO_SUDO=1 run enable 2>&1); is "no sudo rc" "$?" 3
    [ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "no sudo: a disk appeared"
fi

# --- disable
fresh
run enable >/dev/null 2>&1
: > "$P/log"
out=$(run disable 2>&1); rc=$?
is "disable rc" "$rc" 0
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "disable without --purge removed the image"
has "disable says how to reclaim the disk" "$out" "disable --purge"
[ ! -e "$P/etc/systemd/system/verdikta-code-runner-docker.service" ] && ok || bad "disable left a unit"
[ ! -e "$I/code-runner/.env" ] && ok || bad "disable left the runner env"
[ ! -e "$I/code-runner/.state/conformance.json" ] && ok || bad "disable left the pass"
has "disable: code mode off" "$(cat "$I/external-adapter/.env")" "^CODE_REVIEW_ENABLED=false$"
odd=$(log | grep '^systemctl ' | grep -vE '^systemctl (daemon-reload|is-active|is-enabled)' | grep -vE "^systemctl [a-z-]+( --[a-z]+)*( $own_units(\\.service)?)+$")
is "disable names own units only" "$odd" ""
[ -e "$P/opt/gvisor/20260921.0/runsc" ] && ok || bad "disable removed gVisor (another sandbox may share it)"
is "disable: /etc/docker untouched" "$(cat "$P/etc/docker/daemon.json")" "$DAEMON_BEFORE"
out=$(run disable --purge 2>&1); rc=$?
is "purge rc" "$rc" 0
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "purge left the image"

# --- what the script may never contain
code=$(grep -vE '^[[:space:]]*#' "$TOOL")
hasnt "never restarts docker"  "$code" "restart docker"
hasnt "never reloads docker"   "$code" "reload docker"
hasnt "no package manager: apt can restart Docker" "$code" "apt-get\|apt install\|dpkg\|yum \|dnf "
hasnt "never names cl-postgres" "$code" "cl-postgres"
hasnt "no default-socket docker path" "$code" "/var/run/docker.sock"
# The installer never writes dev trust, anywhere.
hits=$(grep -rnE 'CODE_REVIEW_TRUST=.?dev|CODE_REVIEW_DEV_KEYS' "$ROOT/bin" "$ROOT/util" "$ROOT/lib" "$ROOT/config" | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' )
is "the installer never writes dev trust" "$hits" ""
# The pin agrees with the workflow, which code-runner/test/unit/runtime.test.js ties to common.
wf="$REPO/.github/workflows/code-runner.yml"
ver=$(grep -E "^[[:space:]]*GVISOR_VERSION:" "$wf" | sed "s/.*'\(.*\)'.*/\1/"); sha=$(grep -E "^[[:space:]]*GVISOR_SHA512:" "$wf" | awk '{print $2}')
has "gVisor version as CI's" "$(grep -E '^GVISOR_VERSION=' "$TOOL")" "$ver"
has "gVisor SHA-512 as CI's" "$(grep -E '^GVISOR_SHA512=' "$TOOL")" "$sha"

echo "code-review-sandbox: pass=$pass fail=$fail"; [ "$fail" = 0 ]
