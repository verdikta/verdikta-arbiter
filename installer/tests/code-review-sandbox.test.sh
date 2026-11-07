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

# systemctl: every call logged; is-active follows a state dir; start marks active. The runner's
# dockerd mounts two files in its exec root when it starts and leaves them when it stops (measured on
# a canary host, #126): a start of its unit adds them to the mount table findmnt reads.
stub systemctl 'echo "systemctl $*" >> "$STUB_LOG"
verb="$1"; shift
case "$verb" in
  start|restart) for u in "$@"; do if [ "${STUB_UNIT_FAIL:-}" = "${u%.service}" ]; then exit 1; fi; : > "$STUB_STATE/active-${u%.service}"
       if [ "${u%.service}" = verdikta-code-runner-docker ]; then for m in netns/default runtime-runc/vcr/null-netns; do
         grep -qxF "$VERDIKTA_SANDBOX_PREFIX/run/verdikta-code-runner/exec/$m" "$STUB_STATE/mounts" 2>/dev/null || echo "$VERDIKTA_SANDBOX_PREFIX/run/verdikta-code-runner/exec/$m" >> "$STUB_STATE/mounts"
       done; fi; done ;;
  stop) for u in "$@"; do if [ "${STUB_STOP_FAIL:-}" = "${u%.service}" ]; then exit 1; fi; rm -f "$STUB_STATE/active-${u%.service}"; done ;;
  is-active) shift_q=0; [ "$1" = "--quiet" ] && shift; [ -f "$STUB_STATE/active-${1%.service}" ]; exit $? ;;
  is-enabled) [ "$1" = "--quiet" ] && shift; exit 1 ;;
esac
exit 0'
# docker: every call logged with its environment host; info answers from what it is told.
stub docker 'echo "docker DOCKER_HOST=${DOCKER_HOST:-} $*" >> "$STUB_LOG"
case "$*" in
  *"info --format {{.DockerRootDir}}"*) echo "${STUB_ROOTDIR:-$VERDIKTA_SANDBOX_PREFIX/var/lib/verdikta-code-runner/docker}" ;;
  *"info --format {{.Driver}}"*) echo "${STUB_DRIVER:-overlay2}" ;;
  *"(index .Runtimes"*)
     # STUB_RELOAD_LAG: the old path this many times: a reload is a signal, taken in the daemon'"'"'s own time.
     n=$(cat "$STUB_STATE/runtimes-asked" 2>/dev/null || echo 0); echo $((n+1)) > "$STUB_STATE/runtimes-asked"
     if [ "$n" -lt "${STUB_RELOAD_LAG:-0}" ]; then echo /opt/gvisor/old/runsc; else echo "${STUB_RUNSC_PATH:-$VERDIKTA_SANDBOX_PREFIX/opt/gvisor/20260921.0/runsc}"; fi ;;
  *" version "*) echo 28.0.4 ;;
  *" pull "*) if [ "${STUB_SLOW_PULL:-0}" = 1 ]; then : > "$STUB_STATE/signal-now"; sleep 1; fi
     if [ -n "${STUB_LOCK:-}" ] && [ -f "$STUB_LOCK" ]; then echo "lock-held-during-pull" >> "$STUB_LOG"; fi
     [ "${STUB_PULL_FAIL:-0}" = 1 ] && exit 1 ;;
  *"image inspect"*) [ "${STUB_NOT_WARM:-0}" = 1 ] && exit 1 ;;
  *"ps -aq --filter name=vcr-cal-registry-"*) echo "${STUB_STALE_REGISTRY:-}" ;;
esac
exit 0'
stub dockerd 'echo "dockerd $*" >> "$STUB_LOG"; exit 0'
stub containerd 'exit 0'
stub curl 'echo "curl $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { shift; : > "$1"; }; shift; done; [ "${STUB_CURL_FAIL:-0}" = 1 ] && exit 22; exit 0'
stub sha512sum 'cat > "$STUB_STATE/sha-input"; [ "${STUB_SHA_FAIL:-0}" = 1 ] && exit 1; exit 0'
stub tar 'echo "tar $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do if [ "$1" = "-C" ]; then shift; printf "#!/bin/bash\necho runsc version release-20260921.0\n" > "$1/runsc"; chmod +x "$1/runsc"; mkdir -p "$1/gvisor-bin"; printf "#!/bin/bash\n" > "$1/gvisor-bin/gvisor_sentry"; chmod +x "$1/gvisor-bin/gvisor_sentry"; fi; shift; done; exit 0'
stub bzip2 'exit 0'
stub fallocate 'echo "fallocate $*" >> "$STUB_LOG"; [ "${STUB_FALLOCATE_FAIL:-0}" = 1 ] && exit 1; for last; do :; done; : > "$last"; exit 0'
stub mkfs.ext4 'echo "mkfs.ext4 $*" >> "$STUB_LOG"; [ "${STUB_MKFS_FAIL:-0}" = 1 ] && exit 1; exit 0'
stub mount 'echo "mount $*" >> "$STUB_LOG"; exit 0'
# umount: a target with a mount below it is busy, as the kernel says; so is STUB_UMOUNT_FAIL.
# What it unmounts leaves the table findmnt reads.
stub umount 'echo "umount $*" >> "$STUB_LOG"
for t; do :; done
if [ -f "$STUB_STATE/mounts" ] && { [ "$t" = "${STUB_UMOUNT_FAIL:-}" ] || awk -v t="$t" "index(\$0, t \"/\") == 1 {f=1} END {exit !f}" "$STUB_STATE/mounts"; }; then
  echo "umount: $t: target is busy." >&2; exit 32
fi
rm -f "$STUB_STATE/mounted"
if [ -f "$STUB_STATE/mounts" ]; then grep -vxF -- "$t" "$STUB_STATE/mounts" > "$STUB_STATE/mounts.new"; /bin/mv "$STUB_STATE/mounts.new" "$STUB_STATE/mounts"; fi
exit 0'
# findmnt: the mount table, one target per line, for the one question the script asks of it.
stub findmnt 'echo "findmnt $*" >> "$STUB_LOG"
[ "${STUB_FINDMNT_FAIL:-0}" = 1 ] && exit 1
[ "$*" = "-rn -o TARGET" ] || { echo "findmnt stub: unexpected arguments: $*" >&2; exit 64; }
cat "$STUB_STATE/mounts"'
stub mountpoint '[ -f "$STUB_STATE/active-verdikta-code-runner-disk" ]'
stub df 'echo "Avail"; echo "${STUB_AVAIL:-500000000000}"'
stub uname 'if [ "$1" = "-m" ]; then echo "${STUB_ARCH:-x86_64}"; else /usr/bin/uname "$@"; fi'
stub runuser 'shift 2; [ "$1" = "--" ] && shift; "$@"'
stub npm 'echo "npm $*" >> "$STUB_LOG"; exit 0'
stub ip 'echo "ip $*" >> "$STUB_LOG"; exit 0'
stub timeout 'shift; "$@"'
stub sudo 'if [ "${STUB_NO_SUDO:-0}" = 1 ]; then exit 1; fi; [ "$1" = "-n" ] && shift; "$@"'
# chown as a stub: the tests run as one user.
stub chown 'exit 0'
# env -i stays env -i, and is logged: only what a test's stand-in needs to report goes through it.
# mv and cp, failing on demand for one kind of destination; mv can also be slow, for a signal to land in.
stub mv 'case "$*" in *.env.new.*) [ "${STUB_ENV_WRITE_FAIL:-0}" = 1 ] && exit 1 ;; esac
if [ "${STUB_SLOW_RENAME:-0}" = 1 ]; then case "$*" in *verdikta-code-runner.img.partial*) : > "$STUB_STATE/signal-now"; sleep 1 ;; esac; fi
exec /bin/mv "$@"'
stub cp 'case "$*" in *adapter.env.before*) [ "${STUB_ENV_COPY_FAIL:-0}" = 1 ] && exit 1 ;; esac; exec /bin/cp "$@"'
stub env 'if [ "$1" = "-i" ]; then echo "env -i" >> "$STUB_LOG"; shift; exec /usr/bin/env -i STUB_LOG="$STUB_LOG" STUB_LOCK="$STUB_LOCK" STUB_STATE="$STUB_STATE" STUB_CANARY_EXIT="${STUB_CANARY_EXIT:-}" STUB_CANARY_SAY="${STUB_CANARY_SAY:-}" STUB_HASH="${STUB_HASH:-}" STUB_SLOW_CANARY="${STUB_SLOW_CANARY:-}" "$@"; fi; exec /usr/bin/env "$@"'

fresh() { # a new prefix and install tree; sets P, I
    rm -rf "$T/p"; P="$T/p"; I="$T/p/install"
    mkdir -p "$P/etc/docker" "$P/var/lib" "$P/run" "$P/opt" "$I/installer" "$I/external-adapter" "$I/code-runner" "$I/code-runner/node_modules/@verdikta/common" "$I/code-runner/src" "$I/code-runner/conformance" "$P/state" "$P/etc/systemd/system"
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
    # The rule itself is real; what it compares with comes from this fake's pins.
    cp "$REPO/code-runner/src/conformance.js" "$REPO/code-runner/src/version.js" "$I/code-runner/src/"
    cat > "$I/code-runner/src/common.js" <<'J'
module.exports = { GVISOR_RELEASE: 'release-20260921.0', COMMON_VERSION: '9.9.9-test', CONFORMANCE_CANARY: { reportSha256: 'cafe'.repeat(16) } };
J
    echo '{"lock":1}' > "$I/code-runner/package-lock.json"
    # The conformance entry point: writes what the real one writes, or fails on demand.
    cat > "$I/code-runner/conformance/run.js" <<'J'
const fs = require('fs');
const a = process.argv; const out = a[a.indexOf('--json') + 1];
if (process.env.STUB_LOCK && fs.existsSync(process.env.STUB_LOCK)) fs.appendFileSync(process.env.STUB_LOG, 'lock-held-during-self-test\n');
fs.appendFileSync(process.env.STUB_LOG, `conformance DOCKER_HOST=${process.env.DOCKER_HOST} REGNET=${process.env.CODE_RUNNER_CONFORMANCE_REGISTRY_NETWORK} RUNTIME=${process.env.CODE_RUNNER_RUNTIME} TMPDIR=${process.env.TMPDIR} KEY=${process.env.STUB_SECRET_KEY || 'none'}\n`);
if (process.env.STUB_SLOW_CANARY === '1') { fs.writeFileSync(`${process.env.STUB_STATE}/signal-now`, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); process.exit(1); }
if (process.env.STUB_CANARY_SAY) process.stderr.write(`${process.env.STUB_CANARY_SAY}\n`);
if (process.env.STUB_CANARY_EXIT) process.exit(Number(process.env.STUB_CANARY_EXIT));
fs.writeFileSync(out, JSON.stringify({ canonical: true, reportSha256: process.env.STUB_HASH || 'cafe'.repeat(16), runner: '0.1.0', gvisor: 'release-20260921.0', sourceSha256: require('../src/conformance').sourceSha256() }));
J
    printf '#!/bin/bash\necho "runner-start DOCKER_HOST=$(grep ^DOCKER_HOST= .env 2>/dev/null)" >> "$STUB_LOG"; exit "${STUB_RUNNER_START_RC:-0}"\n' > "$I/code-runner/start.sh"
    (cd "$I/code-runner" && sed -i.bak 's#^echo "runner-start.*#echo "runner-start" >> "$STUB_LOG"; exit "${STUB_RUNNER_START_RC:-0}"#' start.sh && rm -f start.sh.bak)
    printf '#!/bin/bash\necho runner-stop >> "$STUB_LOG"; exit 0\n' > "$I/code-runner/stop.sh"
    printf '#!/bin/bash\necho adapter-stop >> "$STUB_LOG"; exit 0\n' > "$I/external-adapter/stop.sh"
    # STUB_ADAPTER_FAILS: this many starts fail.
    printf '#!/bin/bash\necho adapter-start >> "$STUB_LOG"; n=$(cat "$STUB_STATE/adapter-starts" 2>/dev/null || echo 0); echo $((n+1)) > "$STUB_STATE/adapter-starts"; [ "$n" -lt "${STUB_ADAPTER_FAILS:-0}" ] && exit 1; exit 0\n' > "$I/external-adapter/start.sh"
    printf 'OPERATOR_ADDR=0xabc\nIPFS_PINNING_KEY=not-a-real-key\n' > "$I/external-adapter/.env"
    printf 'DEPLOYMENT_NETWORK="base_sepolia"\nNETWORK_CHAIN_ID="84532"\nPRIVATE_KEY="not-a-real-key"\n' > "$I/installer/.env"
    : > "$P/state/.keep"
    DAEMON_BEFORE=$(cat "$P/etc/docker/daemon.json")
    # The host's other mounts: the arbiter's Docker's netns, a sibling whose name starts like the exec
    # root's, and the runner's own state outside it. Not one of them is the sandbox's to unmount.
    printf '%s\n' / /run /run/docker/netns/default "$P/run/docker/netns/default" "$P/run/docker/netns/0123abcd" \
        "$P/run/verdikta-code-runner/execution/keep" "$P/run/verdikta-code-runner/containerd-state/keep" > "$P/state/mounts"
    OTHER_MOUNTS=$(cat "$P/state/mounts")
}
run() { # run ARGS... (the environment passes through)
    PATH="$STUBS:$PATH" VERDIKTA_SANDBOX_PREFIX="$P" VERDIKTA_SYSTEMD_UNIT_DIR="$P/etc/systemd/system" STUB_LOG="$P/log" STUB_STATE="$P/state" \
    STUB_LOCK="$I/code-runner-state/maintenance" VERDIKTA_UNATTENDED=1 \
    bash "$TOOL" "$@" --install-dir "$I" --user "$(id -un)"
}
log()  { cat "$P/log"; }
own_units='verdikta-code-runner-(disk|containerd|docker)'
# The mount table, split at the runner daemon's exec root: at or below it, and everything else.
exec_mounts()  { awk -v r="$P/run/verdikta-code-runner/exec" '$0 == r || index($0, r "/") == 1' "$P/state/mounts"; }
other_mounts() { awk -v r="$P/run/verdikta-code-runner/exec" '!($0 == r || index($0, r "/") == 1)' "$P/state/mounts"; }
# Every umount names the disk's mount point or a path at or below the exec root: printed, the others.
umount_strays() {
    log | awk -v m="$P/var/lib/verdikta-code-runner" -v r="$P/run/verdikta-code-runner/exec" \
        '$1 == "umount" { t = substr($0, 8); if (t != m && t != r && index(t, r "/") != 1) print }'
}
logged() { if log | grep -qxF -- "$2"; then ok; else bad "$1: no line [$2] in the log"; fi; }
EXEC="$T/p/run/verdikta-code-runner/exec"

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
# `"bridge": "none"` makes dockerd delete the host's docker0 when it starts: measured, on Docker 29.
has "its own bridge, never none" "$parsed" "^bridge=vcr0$"
has "the bridge is made before the daemon" "$cfg" "^ExecStartPre=.*ip link add vcr0 type bridge"
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
has "own containerd namespace" "$parsed" "^ns=vcr$"
has "own plugins namespace" "$parsed" "^pns=vcr-plugins$"
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
disku=$(printf '%s\n' "$cfg" | awk '/^# verdikta-code-runner-disk\.service/{p=1;next} /^# /{p=0} p')
has "the loop device takes no discard: fstrim would make the image sparse" "$disku" "discard_max_bytes"
has "a start allocates what is missing, or does not start" "$disku" "^ExecStartPre=/bin/sh .*fallocate .*-ge"
hasnt "and checks it, mounted or not" "$(printf '%s\n' "$disku" | grep '^ExecStartPre')" "mountpoint"
has "a start that fails leaves nothing mounted" "$disku" "^ExecStopPost=/bin/sh .*mountpoint .*umount"
hasnt "an allocation that fails is not ignored" "$disku" "^ExecStartPre=-"
has "units escape the shell's dollar and percent for systemd" "$disku" 'stat -c %%s'
has "no discard is verified, not assumed" "$disku" '^ExecStartPost=/bin/sh .*discard_max_bytes.*= 0'
hasnt "a discard that can't be turned off is not ignored" "$disku" "^ExecStartPost=-"
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
[ -x "$P/opt/gvisor/20260921.0/gvisor-bin/gvisor_sentry" ] && ok || bad "the release's other binaries were not installed: runsc needs them beside it"
has "disk 40 GB by default" "$l" "^fallocate -l 40G "
has "ext4 without root's reserve" "$l" "^mkfs.ext4 .*-m 0"
has "mkfs does not punch holes in the allocated image" "$l" "^mkfs.ext4 .*-E nodiscard"
hasnt "no partial image left" "$(ls "$P/var/lib")" "partial"
[ -f "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "no disk image"
has "warms the base by digest with a platform"   "$l" "pull --quiet --platform linux/amd64 ghcr.io/foundry-rs/foundry:v1.8.5@sha256:aaa"
has "warms Semgrep by digest with a platform"    "$l" "pull --quiet --platform linux/amd64 docker.io/semgrep/semgrep@sha256:bbb"
# Warm before the self-test: the self-test's own pull could hide a cold host.
pull_line=$(printf '%s\n' "$l" | grep -n ' pull ' | tail -1 | cut -d: -f1); self_line=$(printf '%s\n' "$l" | grep -n '^conformance ' | head -1 | cut -d: -f1)
[ -n "$self_line" ] && [ "$pull_line" -lt "$self_line" ] && ok || bad "warm then self-test: pull $pull_line, self-test $self_line"
has "the lock is held during the pull"      "$l" "lock-held-during-pull"
has "the lock is held during the self-test" "$l" "lock-held-during-self-test"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "the lock was not let go"
has "self-test drives the runner's daemon" "$l" "^conformance DOCKER_HOST=unix://$P/run/verdikta-code-runner/docker.sock "
has "self-test's registry on the host network: the daemon cannot publish a port" "$l" "REGNET=host"
has "self-test under gVisor"   "$l" "RUNTIME=runsc"
has "self-test's temp files on the fixed disk" "$l" "TMPDIR=$P/var/lib/verdikta-code-runner/selftest"
[ -f "$I/code-runner-state/conformance.json" ] && ok || bad "no pass recorded"
is "the pass is the rule's own: the runner reads it as good" "$(node -p 'require(process.argv[1]).passProblem(process.argv[2])' "$I/code-runner/src/conformance.js" "$I/code-runner-state/conformance.json")" "null"
is "written whole: no temp left" "$(ls -A "$I/code-runner-state" | grep -c 'conformance.json.new')" 0
# The runner's environment.
envf=$(cat "$I/code-runner/.env")
has "runner env: own daemon" "$envf" "^DOCKER_HOST=unix://$P/run/verdikta-code-runner/docker.sock$"
has "runner env: gVisor"     "$envf" "^CODE_RUNNER_RUNTIME=runsc$"
has "runner env: the disk"   "$envf" "^CODE_RUNNER_DATA_ROOT=$P/var/lib/verdikta-code-runner$"
has "runner env: token file" "$envf" "^CODE_RUNNER_TOKEN_FILE=$I/code-runner-state/token$"
has "runner env: the check is asked for" "$envf" "^CODE_RUNNER_CONFORMANCE_FILE=$I/code-runner-state/conformance.json$"
has "runner env: allowlist"  "$envf" "^CODE_RUNNER_REGISTRY_ALLOWLIST=ghcr.io/verdikta$"
has "runner env: slots"      "$envf" "^CODE_RUNNER_SLOTS=1$"
has "runner env: model reserve" "$envf" "^CODE_RUNNER_RESERVE_LOCAL_MODEL_MB=0$"
hasnt "runner env: no key"   "$envf" "PRIVATE_KEY"
tok=$(cat "$I/code-runner-state/token"); is "token length" "${#tok}" 64
is "token mode" "$(stat -c '%a' "$I/code-runner-state/token" 2>/dev/null || stat -f '%Lp' "$I/code-runner-state/token")" 600
hasnt "token never in the log or output" "$l$out" "$tok"
# The adapter's environment.
ea=$(cat "$I/external-adapter/.env")
has "adapter: on"      "$ea" "^CODE_REVIEW_ENABLED=true$"
has "adapter: production trust" "$ea" "^CODE_REVIEW_TRUST=production$"
has "adapter: runner url" "$ea" "^CODE_RUNNER_URL=http://127.0.0.1:8090$"
has "adapter: token file" "$ea" "^CODE_RUNNER_TOKEN_FILE=$I/code-runner-state/token$"
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
rm -f "$P/state/runtimes-asked"
out=$(STUB_RELOAD_LAG=2 run enable 2>&1); rc=$?
is "gVisor change rc" "$rc" 0
has "reload of its own daemon" "$(log)" "^systemctl reload verdikta-code-runner-docker"
hasnt "no restart on a gVisor change, even when the reload takes a moment" "$(log)" "restart"
hasnt "the arbiter's Docker is not reloaded" "$(log)" "^systemctl reload docker"
# A setting a reload cannot take: its own daemon restarts, once, and never the arbiter's.
sed -i.bak "s#$P/opt/gvisor/20260921.0/runsc#$P/opt/gvisor/old/runsc#" "$P/etc/verdikta-code-runner/daemon.json"; rm -f "$P/etc/verdikta-code-runner/daemon.json.bak"
: > "$P/log"; rm -f "$P/state/runtimes-asked"
out=$(CODE_REVIEW_RELOAD_WAIT_SECS=1 STUB_RELOAD_LAG=3 run enable 2>&1); rc=$?
is "a reload that does not take: rc" "$rc" 0
has "its own daemon restarts" "$(log)" "^systemctl restart verdikta-code-runner-docker"
hasnt "the arbiter's Docker does not" "$(log)" "restart docker"

# --- a release missing its binaries is installed again, whatever runsc says
rm -rf "$P/opt/gvisor/20260921.0/gvisor-bin"
: > "$P/log"
out=$(run enable 2>&1); rc=$?
is "partial release rc" "$rc" 0
has "partial release: downloaded again" "$(log)" "gvisor.tar.bz2"
[ -x "$P/opt/gvisor/20260921.0/gvisor-bin/gvisor_sentry" ] && ok || bad "a partial release stayed partial"

# --- SHA-512 mismatch: nothing installed, no disk made
fresh
out=$(STUB_SHA_FAIL=1 run enable 2>&1); rc=$?
is "bad SHA rc" "$rc" 1
has "bad SHA says so" "$out" "SHA-512"
[ ! -e "$P/opt/gvisor/20260921.0/runsc" ] && ok || bad "a binary of the wrong hash was installed"
hasnt "the arbiter's bridge is never named" "$(log)" "ip link del docker0"
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "a disk was made after a bad SHA"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "lock left after a bad SHA"

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
    [ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "$1: the lock stayed"
    [ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "$1: a pass stayed"
    hasnt "$1: adapter stays off" "$(cat "$I/external-adapter/.env")" "CODE_REVIEW_ENABLED=true"
    is "$1: /etc/docker untouched" "$(cat "$P/etc/docker/daemon.json")" "$DAEMON_BEFORE"
    hasnt "$1: no Docker restart on the way out" "$(log)" "restart docker"
    is "$1: nothing stays mounted under the daemon's exec root" "$(exec_mounts)" ""
    is "$1: every other mount stays" "$(other_mounts)" "$OTHER_MOUNTS"
    is "$1: umount names only its own" "$(umount_strays)" ""
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

# --- the runner daemon's exec root: what its dockerd mounted there goes once it has stopped (#126)
# The rollback, after the daemon ran: both of its mounts, each after the units stopped.
fresh
out=$(STUB_PULL_FAIL=1 run enable 2>&1)
logged "rollback: netns/default" "umount $EXEC/netns/default"
logged "rollback: null-netns"    "umount $EXEC/runtime-runc/vcr/null-netns"
after_stop=$(log | awk '/^systemctl stop verdikta-code-runner-containerd$/ {s=1} s && /^umount .*\/exec\// {print "ok"; exit}')
is "rollback: unmounts after its daemons stopped" "$after_stop" "ok"
before_stop=$(log | awk '/^umount .*\/exec\// {u=1} u && /^systemctl stop verdikta-code-runner-(docker|containerd)$/ {print "early"; exit}')
is "rollback: no unmount while a daemon still runs" "$before_stop" ""
# Deepest first: a mount below another goes before it (the stub, as the kernel, refuses a parent first).
fresh
printf '%s\n' "$EXEC" "$EXEC/netns" >> "$P/state/mounts"
out=$(STUB_PULL_FAIL=1 run enable 2>&1)
order=$(log | awk -v r="$EXEC" '$1 == "umount" && ($2 == r || index($2, r "/") == 1) {print $2}')
is "deepest first" "$order" "$(printf '%s\n' "$EXEC/runtime-runc/vcr/null-netns" "$EXEC/netns/default" "$EXEC/netns" "$EXEC")"
is "deepest first: all of them go" "$(exec_mounts)" ""
is "deepest first: the rest stays" "$(other_mounts)" "$OTHER_MOUNTS"
hasnt "deepest first: no busy target" "$out" "target is busy"
# disable, after a working enable.
fresh
run enable >/dev/null 2>&1
is "enable: the daemon's mounts are there" "$(exec_mounts | wc -l | tr -d ' ')" 2
: > "$P/log"
out=$(run disable 2>&1); rc=$?
is "disable: rc" "$rc" 0
is "disable: nothing under the exec root" "$(exec_mounts)" ""
is "disable: every other mount stays" "$(other_mounts)" "$OTHER_MOUNTS"
is "disable: umount names only its own" "$(umount_strays)" ""
hasnt "disable: never the arbiter's /run/docker" "$(log | grep '^umount ')" "/run/docker"
# What an earlier rollback left on a host with no units at all: disable takes it away.
fresh
printf '%s\n' "$EXEC/netns/default" "$EXEC/runtime-runc/vcr/null-netns" >> "$P/state/mounts"
out=$(run disable 2>&1); rc=$?
is "leftovers, nothing installed: disable rc" "$rc" 0
is "leftovers, nothing installed: gone" "$(exec_mounts)" ""
is "leftovers, nothing installed: the rest stays" "$(other_mounts)" "$OTHER_MOUNTS"
# A daemon that did not stop keeps what it mounted, and disable says so.
fresh
run enable >/dev/null 2>&1
: > "$P/log"
out=$(STUB_STOP_FAIL=verdikta-code-runner-docker run disable 2>&1); rc=$?
is "a daemon still running: disable rc" "$rc" 1
is "a daemon still running: its mounts stay" "$(exec_mounts | wc -l | tr -d ' ')" 2
hasnt "a daemon still running: no umount under the exec root" "$(log | grep '^umount ')" "/exec"
has "a daemon still running: says so" "$out" "still running"
fresh
run enable >/dev/null 2>&1
: > "$P/log"
out=$(STUB_STOP_FAIL=verdikta-code-runner-containerd run disable 2>&1); rc=$?
is "containerd still running: disable rc" "$rc" 1
is "containerd still running: the mounts stay" "$(exec_mounts | wc -l | tr -d ' ')" 2
hasnt "containerd still running: no umount under the exec root" "$(log | grep '^umount ')" "/exec"
# A mount that will not go: the others still go, disable exits 1 and names it.
fresh
run enable >/dev/null 2>&1
: > "$P/log"
out=$(STUB_UMOUNT_FAIL="$EXEC/netns/default" run disable 2>&1); rc=$?
is "a busy mount: disable rc" "$rc" 1
is "a busy mount: the other one goes" "$(exec_mounts)" "$EXEC/netns/default"
has "a busy mount: names what stays" "$out" "$EXEC/netns/default"
# No list from findmnt: nothing is unmounted, and it is said.
fresh
run enable >/dev/null 2>&1
: > "$P/log"
out=$(STUB_FINDMNT_FAIL=1 run disable 2>&1); rc=$?
is "no mount list: disable rc" "$rc" 1
hasnt "no mount list: no umount under the exec root" "$(log | grep '^umount ')" "/exec"
has "no mount list: says so" "$out" "findmnt"
# The rollback with a daemon that did not stop: its mounts stay, the rest is removed as before.
fresh
out=$(STUB_PULL_FAIL=1 STUB_STOP_FAIL=verdikta-code-runner-docker run enable 2>&1); rc=$?
is "rollback, a daemon still running: rc" "$rc" 1
hasnt "rollback, a daemon still running: no umount under the exec root" "$(log | grep '^umount ')" "/exec"
has "rollback, a daemon still running: says so" "$out" "still running"
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "rollback, a daemon still running: the image stayed"

# --- a self-test that ran out of time points to the host requirements; any other failure does not
hint="Host requirements"
fresh
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY="conformance: the listing check refused canary: [{\"code\":\"LISTING_TOO_HEAVY\",\"detail\":\"preparing the sandbox took 186 s; 3x that alone is above the class's 360 s run\"}]" run enable 2>&1); rc=$?
is "too heavy: rc" "$rc" 1
has "too heavy: the canary's own words are shown" "$out" "preparing the sandbox took 186 s"
has "too heavy: points to the host requirements" "$out" "$hint"
is "too heavy: one line" "$(printf '%s\n' "$out" | grep -c "$hint")" 1
fresh
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY='conformance: the listing check of canary did not finish (HTTP 200): {"cause":"step_timeout","step":"prepare:tools","detail":"the step ran past its limit"}' run enable 2>&1)
has "a prepare step timeout: points to the host requirements" "$out" "$hint"
fresh
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY='conformance: the listing check of canary did not finish (HTTP 200): {"cause":"step_timeout","step":"integrity:reference:manifest","detail":"the step ran past its limit"}' run enable 2>&1)
has "a reference watch timeout: points to the host requirements" "$out" "$hint"
fresh
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY='conformance: the listing check of canary did not finish (HTTP 200): {"cause":"step_timeout","step":"suite:1","detail":"the step ran past its limit"}' run enable 2>&1)
hasnt "a timeout outside preparation: no pointer" "$out" "$hint"
fresh
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY='conformance: the runner session did not start: listen EADDRINUSE 127.0.0.1:5987' run enable 2>&1)
hasnt "another failure: no pointer" "$out" "$hint"
has "another failure: the canary's own words are shown" "$out" "EADDRINUSE"
fresh; run enable >/dev/null 2>&1
out=$(STUB_CANARY_EXIT=3 STUB_CANARY_SAY='conformance: the listing check refused canary: [{"code":"LISTING_TOO_HEAVY","detail":"x"}]' run self-test 2>&1); rc=$?
is "self-test action, too heavy: rc" "$rc" 1
has "self-test action, too heavy: points to the host requirements" "$out" "$hint"
# The section it names is there.
grep -qxF "## $hint" "$ROOT/docs/maintenance/code-review-sandbox.md" && ok || bad "the doc has no section \"## $hint\", which the pointer names"
# The quick check CI runs on a real host (code-review-sandbox.integration.sh) is the one the doc gives.
qc() { tr '\n\\' '  ' < "$1" | tr -s ' ' | grep -o "runsc --platform=systrap --network=none do /bin/bash -c 'd=[^']*'"; }
doc_qc=$(qc "$ROOT/docs/maintenance/code-review-sandbox.md")
it_qc=$(qc "$ROOT/tests/code-review-sandbox.integration.sh")
[ -n "$doc_qc" ] && ok || bad "the doc's quick check was not found"
is "CI runs the documented quick check" "$it_qc" "$doc_qc"

# --- a failed enable keeps an image it did not make: an earlier disable kept it on purpose
fresh
run enable >/dev/null 2>&1
run disable >/dev/null 2>&1
: > "$P/log"
out=$(STUB_PULL_FAIL=1 run enable 2>&1); rc=$?
is "enable over a kept image, failing: rc" "$rc" 1
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "a failed enable removed an image it did not make"
has "and says where it is" "$out" "disable --purge"
hasnt "no second allocation over a kept image" "$(log)" "^fallocate"
out=$(run status 2>&1); is "status: not installed, an image stays" "$?" 1
has "status names the image" "$out" "A disk image stays"

# --- a failed refresh (an upgrade's) keeps what is there, touches no adapter, and leaves no pass
stale_install() { fresh; run enable >/dev/null 2>&1; printf '{"bogus":1}' > "$I/code-runner-state/conformance.json"; : > "$P/log"; rm -f "$P/state/adapter-starts"; }
adapter_untouched() { # NAME: the adapter's settings and process, as enable left them
    has "$1: code review stays set: the runner refuses" "$(cat "$I/external-adapter/.env")" "^CODE_REVIEW_ENABLED=true$"
    hasnt "$1: no adapter restart" "$(log)" "^adapter-"
}
stale_install
out=$(STUB_CANARY_EXIT=1 run enable 2>&1); rc=$?
is "failed refresh rc" "$rc" 1
has "failed refresh: says what it means" "$out" "refuses claims"
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "a refresh removed the disk"
[ -e "$I/code-runner/.env" ] && ok || bad "a refresh removed the runner env"
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "a failed self-test kept a pass"
adapter_untouched "failed refresh"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "a failed refresh left the lock"
out=$(run status --quiet 2>&1); is "status after a failed refresh" "$?" 2
# The old pass can't be removed: the canary does not run on it, and that is a failure.
fresh; run enable >/dev/null 2>&1
rm -f "$I/code-runner-state/conformance.json"; mkdir "$I/code-runner-state/conformance.json"; touch "$I/code-runner-state/conformance.json/x"
: > "$P/log"
out=$(run self-test 2>&1); is "the old pass can't be removed: rc" "$?" 1
has "the old pass can't be removed: says so" "$out" "Could not remove the old pass"
hasnt "the old pass can't be removed: no canary" "$(log)" "^conformance "
rm -rf "$I/code-runner-state/conformance.json"
# A failed step with a pass that still stands: what the pass says is still true, so it stays.
fresh; run enable >/dev/null 2>&1; : > "$P/log"
out=$(STUB_PULL_FAIL=1 run enable 2>&1); is "failed re-run with a pass: rc" "$?" 1
[ -e "$I/code-runner-state/conformance.json" ] && ok || bad "a failed pull removed a pass that stands"
out=$(run status --quiet 2>&1); is "status with a pass that stands" "$?" 0
# A self-test whose hash is another's leaves none.
stale_install
out=$(STUB_HASH=$(printf 'beef%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16) run self-test 2>&1); is "another hash: rc" "$?" 1
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "another hash left a pass"
is "another hash: no temp left" "$(ls -A "$I/code-runner-state" | grep -c 'conformance.json.new')" 0
adapter_untouched "another hash"
# A new source is no pass: the same version, common and gVisor, and one changed byte.
fresh; run enable >/dev/null 2>&1
out=$(run status --quiet 2>&1); is "status before a source change" "$?" 0
echo '// a change' >> "$I/code-runner/src/version.js"
out=$(run status --quiet 2>&1); is "status after a source change" "$?" 2
: > "$P/log"
out=$(run enable 2>&1); is "enable after a source change: rc" "$?" 0
has "enable after a source change: the canary runs again" "$(log)" "^conformance "
out=$(run status --quiet 2>&1); is "status after that" "$?" 0

# A write of the runner's settings that fails leaves the old ones, and no half of them.
fresh; run enable >/dev/null 2>&1
before=$(cat "$I/code-runner/.env")
printf '{"bogus":1}' > "$I/code-runner-state/conformance.json"
mkdir "$I/code-runner/.env.new"
out=$(run enable 2>&1); rc=$?
is "the runner's settings can't be written: rc" "$rc" 1
has "the runner's settings can't be written: says so" "$out" "Could not write"
is "the runner's settings can't be written: unchanged" "$(cat "$I/code-runner/.env")" "$before"
[ ! -e "$I/code-runner/.env.new" ] && ok || bad "the runner's settings can't be written: the temp stayed"
# A mismatching canary with a pass already there, and a diagnostic that can't be written: no pass stays.
fresh; run enable >/dev/null 2>&1
rm -rf "$I/code-runner-state/conformance-last.json"; mkdir "$I/code-runner-state/conformance-last.json"
out=$(STUB_HASH=$(printf 'beef%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16) run self-test 2>&1); is "a rejected result, its diagnostic unwritable: rc" "$?" 1
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "a rejected result left the old pass"
has "a rejected result: says why" "$out" "publishes"
has "a rejected result: and that the diagnostic went" "$out" "could not keep"
# A good result, its diagnostic unwritable: the pass doesn't depend on it.
out=$(run self-test 2>&1); is "a good result, its diagnostic unwritable: rc" "$?" 0
[ -e "$I/code-runner-state/conformance.json" ] && ok || bad "a good result was lost to a diagnostic"
# A recorder that can't run at all leaves no pass either: the tool removes it.
fresh; run enable >/dev/null 2>&1
cp "$I/code-review-check.js" "$I/check.keep.js"
cat > "$I/code-review-check.js" <<'J'
if (process.argv[2] === 'record') process.exit(7);
require(process.argv[1].replace('code-review-check.js', 'check.keep.js'));
J
out=$(run self-test 2>&1); is "a recorder that fails: rc" "$?" 1
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "a recorder that fails left the old pass"

# --- a refresh refused before it starts changes nothing: the runner holds the rule
stale_install
out=$(STUB_ARCH=aarch64 run enable 2>&1); is "refused refresh, host: rc" "$?" 4
adapter_untouched "refused refresh, host"
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "refused refresh, host: the disk went"
if [ "$(id -u)" != 0 ]; then
    stale_install
    out=$(STUB_NO_SUDO=1 run enable 2>&1); is "refused refresh, no sudo: rc" "$?" 3
    adapter_untouched "refused refresh, no sudo"
fi
stale_install
sed -i.b 's/9.9.9-test/9.9.8-test/' "$I/ai-node/package.json"
out=$(run enable 2>&1); is "refused refresh, pins disagree: rc" "$?" 1
has "refused refresh, pins disagree: names them" "$out" "ai-node:9.9.8-test"
adapter_untouched "refused refresh, pins disagree"

# --- what a design review removed stays removed: the runner holds this rule, not a sequence of steps
out=$(run hold 2>&1); is "there is no hold" "$?" 64
code=$(grep -vE '^[[:space:]]*#' "$TOOL")
hasnt "no pin"  "$code" "pin_lock\|lift_pin"
hasnt "no hold" "$code" "hold_without_a_pass\|refuse_enable"

# --- an adapter that does not come back is the arbiter's problem, and it is said: exit 1, old settings
fresh
out=$(STUB_ADAPTER_FAILS=1 run enable 2>&1); rc=$?
is "adapter does not restart: rc" "$rc" 1
has "adapter does not restart: says so" "$out" "Going back to the old ones"
hasnt "adapter does not restart: old settings" "$(cat "$I/external-adapter/.env")" "CODE_REVIEW_ENABLED=true"
is "adapter does not restart: started again" "$(grep -c '^adapter-start$' "$P/log")" 2
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "adapter does not restart: the disk stayed"
fresh
out=$(STUB_ADAPTER_FAILS=2 run enable 2>&1); rc=$?
is "adapter stays down: rc" "$rc" 1
has "adapter stays down: says so, loudly" "$out" "is DOWN"
# Turning it off is a restart too.
fresh; run enable >/dev/null 2>&1; rm -f "$P/state/adapter-starts"
out=$(STUB_ADAPTER_FAILS=1 run disable 2>&1); is "disable, adapter does not restart: rc" "$?" 1
has "disable, adapter does not restart: says so" "$out" "is DOWN"

# --- a signal is a failure too: a first enable removes what it made, a refresh changes nothing else
term_at() { # term_at STUB_VAR [ACTION]: SIGTERM when that stub says signal-now
    rm -f "$P/state/signal-now"
    env "$1=1" PATH="$STUBS:$PATH" VERDIKTA_SANDBOX_PREFIX="$P" VERDIKTA_SYSTEMD_UNIT_DIR="$P/etc/systemd/system" STUB_LOG="$P/log" STUB_STATE="$P/state" \
    STUB_LOCK="$I/code-runner-state/maintenance" VERDIKTA_UNATTENDED=1 \
    bash "$TOOL" "${2:-enable}" --install-dir "$I" --user "$(id -un)" >"$P/state/out" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do [ -e "$P/state/signal-now" ] && break; sleep 0.1; done
    kill -TERM "$pid"
    wait "$pid"; rc=$?
}
fresh
term_at STUB_SLOW_PULL
is "SIGTERM on a first enable: rc" "$rc" 143
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "SIGTERM: the disk image stayed"
[ ! -e "$P/etc/systemd/system/verdikta-code-runner-docker.service" ] && ok || bad "SIGTERM: a unit stayed"
[ ! -e "$I/code-runner/.env" ] && ok || bad "SIGTERM: the runner env stayed"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "SIGTERM: the lock stayed"
has "SIGTERM: says what became of it" "$(cat "$P/state/out")" "was not installed"
stale_install
term_at STUB_SLOW_PULL
is "SIGTERM on a refresh: rc" "$rc" 143
[ -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "SIGTERM on a refresh: the disk went"
adapter_untouched "SIGTERM on a refresh"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "SIGTERM on a refresh: the lock stayed"
# ... during a self-test, on a node with a good pass: from the moment it begins, only a new pass stands.
fresh; run enable >/dev/null 2>&1
[ -e "$I/code-runner-state/conformance.json" ] && ok || bad "no pass to begin with"
term_at STUB_SLOW_CANARY self-test
is "SIGTERM during a self-test: rc" "$rc" 143
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "SIGTERM during a self-test: the old pass stayed, and claims with it"
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "SIGTERM during a self-test: the lock stayed"
# ... during the final rename too: the image is this run's before it has its name.
fresh
term_at STUB_SLOW_RENAME
is "SIGTERM during the rename: rc" "$rc" 143
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "SIGTERM during the rename: the image stayed"
[ ! -e "$P/var/lib/verdikta-code-runner.img.partial" ] && ok || bad "SIGTERM during the rename: the partial image stayed"
# ... and between the adapter's stop and its start: it was running, so it runs again.
fresh
printf '#!/bin/bash\necho adapter-stop >> "$STUB_LOG"; [ "${STUB_SLOW_ADAPTER_STOP:-0}" = 1 ] && { : > "$STUB_STATE/signal-now"; sleep 1; }; exit 0\n' > "$I/external-adapter/stop.sh"
term_at STUB_SLOW_ADAPTER_STOP
is "SIGTERM during the adapter's stop: rc" "$rc" 143
is "SIGTERM during the adapter's stop: started again" "$(grep -c '^adapter-start$' "$P/log")" 1
hasnt "SIGTERM during the adapter's stop: not left on" "$(cat "$I/external-adapter/.env")" "CODE_REVIEW_ENABLED=true"
[ ! -e "$P/var/lib/verdikta-code-runner.img" ] && ok || bad "SIGTERM during the adapter's stop: the disk stayed"

# --- the adapter's settings: no copy, no change, and a failed copy destroys nothing
fresh
before=$(cat "$I/external-adapter/.env")
out=$(STUB_ENV_COPY_FAIL=1 run enable 2>&1); rc=$?
is "adapter env not copied: rc" "$rc" 1
has "adapter env not copied: says so" "$out" "Could not copy"
is "adapter env not copied: unchanged" "$(cat "$I/external-adapter/.env")" "$before"

# --- the self-test refuses a cold host: its own pull would hide it
fresh
run enable >/dev/null 2>&1
rm -f "$I/code-runner-state/conformance.json"
: > "$P/log"
out=$(STUB_NOT_WARM=1 run self-test 2>&1); rc=$?
is "cold host rc" "$rc" 1
has "cold host says so" "$out" "warm"
hasnt "cold host: the canary never ran" "$(log)" "^conformance"

# --- a killed self-test's registry is removed first: it would hold the canary's port
fresh
run enable >/dev/null 2>&1
rm -f "$I/code-runner-state/conformance.json"
: > "$P/log"
out=$(STUB_STALE_REGISTRY=abc123 run self-test 2>&1); rc=$?
is "stale registry rc" "$rc" 0
has "stale registry removed, on its own daemon" "$(log)" "docker DOCKER_HOST=.*--host unix://$P/run/verdikta-code-runner/docker.sock rm -f --volumes abc123"

# --- the lock: one operation at a time, or the first to end lifts it from under the second
# An operator's (no pid) stays theirs.
fresh
run enable >/dev/null 2>&1
echo "by hand" > "$I/code-runner-state/maintenance"
rm -f "$I/code-runner-state/conformance.json"
out=$(run enable 2>&1); rc=$?
is "with an operator's lock rc" "$rc" 0
is "an operator's lock stays" "$(cat "$I/code-runner-state/maintenance")" "by hand"
# Another live operation: refused, and its lock stays.
sleep 60 & live=$!
echo "code-review-sandbox $live 2026-11-04T00:00:00Z" > "$I/code-runner-state/maintenance"
rm -f "$I/code-runner-state/conformance.json"; : > "$P/log"
out=$(run enable 2>&1); rc=$?
is "with a live holder: enable rc" "$rc" 1
has "with a live holder: names it" "$out" "$live"
hasnt "with a live holder: nothing ran" "$(log)" "^conformance"
has "with a live holder: its lock stays" "$(cat "$I/code-runner-state/maintenance")" "$live"
out=$(run self-test 2>&1); is "with a live holder: self-test rc" "$?" 1
out=$(run warm 2>&1);      is "with a live holder: warm rc" "$?" 1
out=$(run disable 2>&1);   is "with a live holder: disable rc" "$?" 1
[ -e "$I/code-runner/.env" ] && ok || bad "with a live holder: disable went ahead"
# The upgrade that started this run hands its own down, and keeps it.
out=$(CODE_REVIEW_LOCK_PARENT=$live run enable 2>&1); rc=$?
is "the parent's lock: enable rc" "$rc" 0
has "the parent's lock: it stays" "$(cat "$I/code-runner-state/maintenance")" "$live"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
# A dead holder's file is stale: taken over, and let go at the end.
rm -f "$I/code-runner-state/conformance.json"
out=$(run enable 2>&1); rc=$?
is "a dead holder: enable rc" "$rc" 0
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "a dead holder's lock stayed"
# A lock that can't be written is no lock, and no operation goes on without one.
mv "$I/code-runner-state" "$I/code-runner-state.away"; : > "$I/code-runner-state"
: > "$P/log"
out=$(run warm 2>&1); is "a lock it cannot write: warm rc" "$?" 1
has "a lock it cannot write: says so" "$out" "Could not write the maintenance lock"
hasnt "a lock it cannot write: nothing ran" "$(log)" " pull "
out=$(run lock --pid $$ 2>&1); is "a lock it cannot write: lock rc" "$?" 4
rm -f "$I/code-runner-state"; mv "$I/code-runner-state.away" "$I/code-runner-state"
# An operator's touch is an operator's: the file is empty, and no writer here leaves one half-written.
: > "$I/code-runner-state/maintenance"
out=$(run lock --pid $$ 2>&1); is "an operator's empty file: lock rc" "$?" 2
[ -e "$I/code-runner-state/maintenance" ] && ok || bad "an operator's empty file went"
rm -f "$I/code-runner-state/maintenance"
# Published whole: two at once, one holds it, and no temporary file stays.
holders=(); for n in 1 2 3 4 5 6 7 8; do sleep 30 & holders+=($!); done
racers=(); for h in "${holders[@]}"; do ( run lock --pid "$h" >/dev/null 2>&1; echo "$?" >> "$P/state/racers" ) & racers+=($!); done
wait "${racers[@]}"
is "two at once: one winner" "$(grep -c '^0$' "$P/state/racers")" 1
is "two at once: no temp left" "$(ls -A "$I/code-runner-state" | grep -c 'maintenance.new')" 0
kill "${holders[@]}" 2>/dev/null; wait "${holders[@]}" 2>/dev/null
rm -f "$I/code-runner-state/maintenance" "$P/state/racers"
# A live holder this user cannot signal is still live: kill -0 says EPERM, /proc says it is there.
if [ -d /proc/1 ] && [ "$(id -u)" != 0 ]; then
    echo "code-review-sandbox 1 2026-11-04T00:00:00Z" > "$I/code-runner-state/maintenance"
    out=$(run warm 2>&1); is "another user's live holder: rc" "$?" 1
    has "another user's live holder: its lock stays" "$(cat "$I/code-runner-state/maintenance")" "sandbox 1 "
    rm -f "$I/code-runner-state/maintenance"
fi
# Of two seeing the same dead holder, one goes on.
sleep 0 & dead=$!; wait "$dead"
echo "code-review-sandbox $dead 2026-11-04T00:00:00Z" > "$I/code-runner-state/maintenance"
mkdir "$I/code-runner-state/maintenance.takeover"
out=$(run warm 2>&1); is "a takeover in progress: rc" "$?" 1
has "a takeover in progress: the file is unchanged" "$(cat "$I/code-runner-state/maintenance")" "sandbox $dead "
rmdir "$I/code-runner-state/maintenance.takeover"
rm -f "$I/code-runner-state/maintenance"
# Nobody removes a lock that is not their pid's: a run whose lock was taken from it leaves the new holder's.
sleep 60 & live=$!
echo "code-review-sandbox $live x" > "$I/code-runner-state/maintenance"
out=$(run unlock --pid 12345 2>&1); is "unlock of another's: rc" "$?" 0
has "unlock of another's: it stays" "$(cat "$I/code-runner-state/maintenance")" "$live"
out=$(run unlock --pid "$live" 2>&1)
[ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "unlock of its own: it stayed"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
out=$(run lock --pid $$ 2>&1); is "lock: rc" "$?" 0
has "lock: names the pid given" "$(cat "$I/code-runner-state/maintenance")" "sandbox $$ "
out=$(run lock 2>&1); is "lock needs a pid" "$?" 64
out=$(run unlock --pid $$ 2>&1); [ ! -e "$I/code-runner-state/maintenance" ] && ok || bad "unlock left the lock"

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
[ ! -e "$I/code-runner-state/conformance.json" ] && ok || bad "disable left the pass"
has "disable: code mode off" "$(cat "$I/external-adapter/.env")" "^CODE_REVIEW_ENABLED=false$"
odd=$(log | grep '^systemctl ' | grep -vE '^systemctl (daemon-reload|is-active|is-enabled)' | grep -vE "^systemctl [a-z-]+( --[a-z]+)*( $own_units(\\.service)?)+$")
is "disable names own units only" "$odd" ""
has "disable removes its bridge" "$(log)" "^ip link del vcr0$"
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
hasnt "the mount table is findmnt's to read, not the script's" "$code" "/proc/self/mount\|/proc/mounts\|/etc/mtab\|mountinfo"
hasnt "umount is never lazy or forced: what stays is said" "$code" "umount -[a-zA-Z]*[lf]"
has "findmnt is a tool the host must have" "$(grep -n 'for tool in' "$TOOL")" " findmnt "
# The installer never writes dev trust, anywhere.
hits=$(grep -rnE 'CODE_REVIEW_TRUST=.?dev|CODE_REVIEW_DEV_KEYS' "$ROOT/bin" "$ROOT/util" "$ROOT/lib" "$ROOT/config" | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' )
is "the installer never writes dev trust" "$hits" ""
# The pin agrees with the workflow, which code-runner/test/unit/runtime.test.js ties to common.
wf="$REPO/.github/workflows/code-runner.yml"
ver=$(grep -E "^[[:space:]]*GVISOR_VERSION:" "$wf" | sed "s/.*'\(.*\)'.*/\1/"); sha=$(grep -E "^[[:space:]]*GVISOR_SHA512:" "$wf" | awk '{print $2}')
has "gVisor version as CI's" "$(grep -E '^GVISOR_VERSION=' "$TOOL")" "$ver"
has "gVisor SHA-512 as CI's" "$(grep -E '^GVISOR_SHA512=' "$TOOL")" "$sha"

echo "code-review-sandbox: pass=$pass fail=$fail"; [ "$fail" = 0 ]
