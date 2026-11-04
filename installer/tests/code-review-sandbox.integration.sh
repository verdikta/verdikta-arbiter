#!/bin/bash
# Node A8, on a real Linux host: real systemd, real dockerd and containerd, real gVisor, a real
# loop-mounted disk and the real canary. CI runs it on ubuntu-latest (installer.yml), with stand-ins
# for cl-postgres and chainlink on the host's own Docker. What the unit test stubs is measured here:
#
#   - the arbiter's Docker: same daemon PID, config, rules, interfaces, containers, images, before and
#     after everything below;
#   - the runner's daemon: its own root, driver, runtime and network, and neither Docker can see the other's;
#   - the self-test's report hash against @verdikta/common's, on that daemon, under gVisor;
#   - the adapter's real /health on what enable wrote, and the doctor's real findings;
#   - a full disk fills only that disk; an unmounted disk starts no daemon;
#   - a gVisor change is a reload of the same daemon PID;
#   - a failed first enable and a purge leave no image, mount or unit behind.
#
# It changes the host: it refuses to run anywhere but CI unless VERDIKTA_SANDBOX_IT=1.
# Run: VERDIKTA_SANDBOX_IT=1 bash installer/tests/code-review-sandbox.integration.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
if [ "${CI:-}" != "true" ] && [ "${VERDIKTA_SANDBOX_IT:-}" != "1" ]; then
    echo "This installs units and a disk on the host and starts containers named cl-postgres and chainlink: refused outside CI (VERDIKTA_SANDBOX_IT=1 to run it on a machine you can throw away)."
    exit 1
fi
[ "$(uname -m)" = "x86_64" ] || { echo "linux/amd64 only"; exit 1; }
sudo -n true || { echo "needs passwordless sudo"; exit 1; }

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok: $1"; }
bad() { fail=$((fail+1)); echo "  FAIL: $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
step() { echo; echo "=== $1"; }

WORK=$(mktemp -d); I="$WORK/install"
TOOL="$I/code-review-sandbox.sh"; CHECK="$I/code-review-check.js"
MOUNT=/var/lib/verdikta-code-runner; IMAGE=/var/lib/verdikta-code-runner.img; SOCK=/run/verdikta-code-runner/docker.sock
OWN=(docker --host "unix://$SOCK")
PORT_HOLDER=""
cleanup() {
    [ -n "$PORT_HOLDER" ] && kill "$PORT_HOLDER" 2>/dev/null
    if [ "$fail" != "0" ]; then
        for u in verdikta-code-runner-disk verdikta-code-runner-containerd verdikta-code-runner-docker; do
            echo "--- journal: $u"; sudo journalctl -u "$u" -n 40 --no-pager 2>/dev/null | cut -c1-240
        done
        echo "--- runner log"; tail -n 40 "$I"/code-runner/logs/*.log 2>/dev/null | cut -c1-300
    fi
    bash "$I/external-adapter/stop.sh" >/dev/null 2>&1
    [ -x "$TOOL" ] && bash "$TOOL" disable --purge --install-dir "$I" >/dev/null 2>&1
    docker rm -f --volumes cl-postgres chainlink >/dev/null 2>&1
    rm -rf "$WORK"
}
trap cleanup EXIT

step "A live arbiter's stand-ins on the host's own Docker"
docker run -d --name cl-postgres --restart unless-stopped -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" postgres:16-alpine >/dev/null || exit 1
docker run -d --name chainlink --restart unless-stopped busybox:1.36 sleep 86400 >/dev/null || exit 1

snapshot() {
    echo "docker.service: $(systemctl show docker -p MainPID -p ExecMainStartTimestamp --value | tr '\n' ' ')"
    echo "containerd.service: $(systemctl show containerd -p MainPID -p ExecMainStartTimestamp --value | tr '\n' ' ')"
    echo "daemon.json: $(sudo sha256sum /etc/docker/daemon.json 2>/dev/null | cut -d' ' -f1)"
    echo "/etc/docker: $(sudo ls -A /etc/docker | tr '\n' ' ')"
    echo "/run/docker: $(sudo ls -A /run/docker 2>/dev/null | tr '\n' ' ')"
    for c in cl-postgres chainlink; do
        echo "$c: $(docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.State.Running}} {{.RestartCount}}' "$c")"
    done
    echo "containers: $(docker ps -aq --no-trunc | sort | tr '\n' ' ')"
    echo "images: $(docker images -q --no-trunc | sort -u | tr '\n' ' ')"
    echo "runtimes: $(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}')"
    echo "root dir: $(docker info --format '{{.DockerRootDir}}')"
    echo "ip_forward: $(sysctl -n net.ipv4.ip_forward)"
    echo "bridge netfilter: $(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null)"
    # vcr0 is the daemon's own, and is checked on its own below: everything else stays.
    echo "interfaces: $(ip -o link show | awk -F': ' '{print $2}' | grep -v '^vcr0$' | sort | tr '\n' ' ')"
    echo "docker0: $(ip -o -4 addr show dev docker0 | awk '{print $4}')"
    echo "routes: $(ip route | grep -v 'dev vcr0' | sort | tr '\n' ';')"
    echo "--- iptables"; sudo iptables-save | sed -E 's/\[[0-9]+:[0-9]+\]//; /^#/d'
    echo "--- ip6tables"; sudo ip6tables-save 2>/dev/null | sed -E 's/\[[0-9]+:[0-9]+\]//; /^#/d'
}
compare() { # compare NAME
    snapshot > "$WORK/now"
    if cmp -s "$WORK/before" "$WORK/now"; then ok "$1: the arbiter's Docker, containers, rules and interfaces are as they were"
    else bad "$1: the host changed:"; diff "$WORK/before" "$WORK/now" | cut -c1-240 | head -30; fi
    docker exec cl-postgres pg_isready -q && ok "$1: cl-postgres answers" || bad "$1: cl-postgres does not answer"
}
# Postgres is up before anything is compared: its readiness is not what this measures.
for _ in $(seq 1 30); do docker exec cl-postgres pg_isready -q 2>/dev/null && break; sleep 1; done
snapshot > "$WORK/before"
cat "$WORK/before" | sed -n 1,3p

step "An install tree"
mkdir -p "$I/installer" "$I/ai-node"
cp "$ROOT/util/code-review-sandbox.sh" "$ROOT/util/code-review-check.js" "$ROOT/util/common-pin.js" "$I/"
cp -r "$REPO/code-runner" "$I/code-runner"; rm -rf "$I/code-runner/node_modules" "$I/code-runner/.state" "$I/code-runner/.env"
cp -r "$REPO/external-adapter" "$I/external-adapter"; rm -rf "$I/external-adapter/node_modules"
cp "$REPO/ai-node/package.json" "$I/ai-node/package.json"
printf 'DEPLOYMENT_NETWORK="base_sepolia"\nNETWORK_CHAIN_ID="84532"\n' > "$I/installer/.env"
printf 'OPERATOR_ADDR=0x1111111111111111111111111111111111111111\nPORT=8080\n' > "$I/external-adapter/.env"
(cd "$I/external-adapter" && npm ci --omit=dev --no-audit --no-fund >/dev/null) || exit 1

# The default where this host has the room; a smaller disk does the same work.
avail=$(df -B1 --output=avail /var/lib | tail -1 | tr -d ' ')
DISK_GB=40
[ "$avail" -ge $(( (40 + 10) * 1024 * 1024 * 1024 )) ] || DISK_GB=15
echo "free on /var/lib: $((avail / 1024 / 1024 / 1024)) GB; disk: $DISK_GB GB"
ROOT_FREE_0=$avail

step "A failed first enable leaves nothing behind (port 5987 taken: the canary's registry cannot start)"
python3 -m http.server --bind 127.0.0.1 5987 >/dev/null 2>&1 & PORT_HOLDER=$!
sleep 1
start=$SECONDS
out=$(VERDIKTA_UNATTENDED=1 bash "$TOOL" enable --disk-gb "$DISK_GB" --install-dir "$I" 2>&1); rc=$?
echo "$out" | tail -8 | cut -c1-2000
echo "(failed enable took $((SECONDS - start)) s)"
kill "$PORT_HOLDER" 2>/dev/null; wait "$PORT_HOLDER" 2>/dev/null; PORT_HOLDER=""
check "failed enable: exit 1" "$rc" 1
[ ! -e "$IMAGE" ] && ok "failed enable: no disk image" || bad "failed enable: the disk image stayed"
[ ! -e "$MOUNT" ] && ok "failed enable: no mount point" || bad "failed enable: $MOUNT stayed"
mountpoint -q "$MOUNT" && bad "failed enable: still mounted" || ok "failed enable: not mounted"
[ -z "$(losetup -j "$IMAGE" 2>/dev/null)" ] && ok "failed enable: no loop device" || bad "failed enable: a loop device stayed"
[ ! -e /etc/systemd/system/verdikta-code-runner-docker.service ] && ok "failed enable: no units" || bad "failed enable: a unit stayed"
ip link show vcr0 >/dev/null 2>&1 && bad "failed enable: its bridge stayed" || ok "failed enable: no bridge"
[ ! -e "$I/code-runner/.env" ] && ok "failed enable: no runner env" || bad "failed enable: the runner env stayed"
[ ! -e "$I/code-runner/.state/maintenance" ] && ok "failed enable: the lock is gone" || bad "failed enable: the lock stayed"
grep -q '^CODE_REVIEW_ENABLED=true' "$I/external-adapter/.env" && bad "failed enable: code review on" || ok "failed enable: code review off"
compare "failed enable"

step "Enable"
start=$SECONDS
VERDIKTA_UNATTENDED=1 bash "$TOOL" enable --disk-gb "$DISK_GB" --install-dir "$I" 2>&1 | cut -c1-2000; rc=${PIPESTATUS[0]}
echo "(enable took $((SECONDS - start)) s)"
check "enable: exit 0" "$rc" 0
[ "$rc" = 0 ] || exit 1
compare "enable"
for u in verdikta-code-runner-disk verdikta-code-runner-containerd verdikta-code-runner-docker; do
    check "$u is active"  "$(systemctl is-active "$u")" active
    check "$u at boot"    "$(systemctl is-enabled "$u")" enabled
done

step "The disk"
check "ext4"           "$(findmnt -no FSTYPE "$MOUNT")" ext4
case "$(findmnt -no SOURCE "$MOUNT")" in /dev/loop*) ok "on a loop device" ;; *) bad "not on a loop device: $(findmnt -no SOURCE "$MOUNT")" ;; esac
size=$(findmnt -bno SIZE "$MOUNT"); [ "$size" -gt $(( (DISK_GB - 2) * 1024 * 1024 * 1024 )) ] && [ "$size" -le $(( DISK_GB * 1024 * 1024 * 1024 )) ] && ok "$DISK_GB GB ($size bytes)" || bad "size $size for $DISK_GB GB"
[ "$(sudo stat -c '%b' "$IMAGE")" -gt 0 ] && [ "$(( $(sudo stat -c '%b' "$IMAGE") * 512 ))" -ge $(( DISK_GB * 1024 * 1024 * 1024 )) ] && ok "allocated up front, not sparse" || bad "the image is sparse: $(sudo stat -c '%b blocks of %s bytes' "$IMAGE")"

step "The runner's daemon"
check "its data root"  "$("${OWN[@]}" info --format '{{.DockerRootDir}}')" "$MOUNT/docker"
check "overlay2, so layers are on the disk" "$("${OWN[@]}" info --format '{{.Driver}}')" overlay2
check "its gVisor"     "$("${OWN[@]}" info --format '{{(index .Runtimes "runsc").Path}}')" "/opt/gvisor/20260921.0/runsc"
check "its bridge is its own" "$("${OWN[@]}" network inspect bridge --format '{{index .Options "com.docker.network.bridge.name"}}')" vcr0
check "nothing is attached to its bridge" "$(ip -o link show master vcr0 | wc -l)" 0
check "it does not see cl-postgres" "$("${OWN[@]}" ps -a --format '{{.Names}}' | grep -c 'cl-postgres\|chainlink')" 0
check "the host's Docker does not see gVisor" "$(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -c runsc)" 0
docker image inspect "$(node "$CHECK" images --install-dir "$I" | tail -1)" >/dev/null 2>&1 && bad "the host's Docker has its Semgrep image" || ok "the host's Docker does not have its images"
check "the system containerd does not hold its namespace" "$(sudo ctr --address /run/containerd/containerd.sock namespaces ls -q | grep -c '^vcr')" 0
sudo test -S /run/verdikta-code-runner/containerd/containerd.sock && ok "its own containerd socket" || bad "no containerd socket of its own"
check "gVisor is executable by the runner's user" "$(/opt/gvisor/20260921.0/runsc --version | head -1)" "runsc version release-20260921.0"
[ "$("${OWN[@]}" run --rm --runtime runsc --network none --pull never --platform linux/amd64 --entrypoint cat "$("$(command -v node)" "$CHECK" images --install-dir "$I" | head -1)" /proc/version 2>&1 | grep -ci gvisor)" -ge 0 ] && ok "a container runs under runsc"

step "The runner"
health=$(node "$CHECK" runner-health --install-dir "$I"); rc=$?
check "runner-health: answers" "$rc" 0
field() { printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(JSON.stringify(v))})' "$1"; }
check "/health ok"           "$(field ok)" true
check "its daemon"           "$(field docker.endpoint)" "\"unix://$SOCK\""
check "gVisor as pinned"     "$(field gvisor)" "$(field gvisorPinned)"
check "Semgrep is warm"      "$(field scanner.present)" true
check "no dev registry"      "$(field images.allowlist)" '[{"entry":"ghcr.io/verdikta","dev":false}]'
check "the lock is let go"   "$(field maintenance)" false
env_of_runner=$(tr '\0' '\n' < "/proc/$(cat "$I/code-runner/runner.pid")/environ")
echo "$env_of_runner" | grep -qE 'PRIVATE_KEY|API_KEY|PINNING' && bad "a key reached the runner's environment" || ok "no key in the runner's environment"
curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$(hostname -I | awk '{print $1}'):8090/health" | grep -q '^000$' && ok "the runner is not on the public address" || bad "the runner answers on the public address"

step "Conformance"
want=$(cd "$I/code-runner" && node -p 'require("@verdikta/common").codeReview.CONFORMANCE_CANARY.reportSha256')
got=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).reportSha256' "$I/code-runner/.state/conformance.json")
check "the report hash is common's" "$got" "$want"
echo "conformance report sha256: $got (common: $want)"
node "$CHECK" gate --install-dir "$I" --classes 133 && ok "gate: 133 with a pass" || bad "gate refused 133 with a pass"
node "$CHECK" gate --install-dir "$I" --classes "133 134" 2>/dev/null && bad "gate: both tiers passed" || ok "gate: both tiers refused"
check "self-test left no temp files on the disk" "$(sudo ls -A "$MOUNT/selftest" | wc -l)" 0
check "self-test left no registry" "$("${OWN[@]}" ps -a --format '{{.Names}}' | grep -c vcr-)" 0
check "status: ready" "$(bash "$TOOL" status --quiet --install-dir "$I" >/dev/null 2>&1; echo $?)" 0

step "The real adapter, on what enable wrote"
(cd "$I/external-adapter" && bash ./start.sh >/dev/null 2>&1) || bad "the adapter did not start"
cr=$(curl -s -m 10 http://127.0.0.1:8080/health)
crf() { printf '%s' "$cr" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).codeReview;console.log(JSON.stringify(c[process.argv[1]]))})' "$1"; }
check "adapter: enabled" "$(crf enabled)" true
check "adapter: production trust" "$(crf trust)" '"production"'
check "adapter: ready" "$(crf ready)" true
check "adapter: chain" "$(crf chainId)" 84532
[ "$(crf ready)" = "true" ] || echo "adapter problems: $(crf problems)"

step "The doctor, for real"
findings=$(node "$CHECK" doctor --install-dir "$I"); echo "$findings" | cut -f1-3 | cut -c1-160
for id in svc.code_runner sandbox.runsc sandbox.disk sandbox.conformance sandbox.trust sandbox.registry; do
    check "doctor: $id" "$(echo "$findings" | awk -F'\t' -v id="$id" '$2==id{print $1}')" PASS
done

step "A weekly fstrim does not make the image sparse"
blocks_before=$(sudo stat -c '%b' "$IMAGE")
sudo fstrim -v "$MOUNT" 2>&1 | cut -c1-160
check "fstrim freed nothing in the image" "$(sudo stat -c '%b' "$IMAGE")" "$blocks_before"

step "A full disk fills only that disk"
root_before=$(df -B1 --output=avail /var/lib | tail -1 | tr -d ' ')
sudo dd if=/dev/zero of="$MOUNT/fill" bs=1M 2>"$WORK/dd.err"; rc=$?
[ "$rc" != 0 ] && grep -qi 'no space' "$WORK/dd.err" && ok "the disk filled (ENOSPC)" || bad "dd: rc=$rc: $(cat "$WORK/dd.err" | tail -1)"
root_after=$(df -B1 --output=avail /var/lib | tail -1 | tr -d ' ')
[ $(( root_before - root_after )) -lt $(( 200 * 1024 * 1024 )) ] && ok "the root filesystem did not pay for it ($(( (root_before - root_after) / 1024 / 1024 )) MB)" || bad "the root filesystem lost $(( (root_before - root_after) / 1024 / 1024 )) MB"
docker ps >/dev/null && docker exec cl-postgres pg_isready -q && ok "the arbiter's Docker and Postgres did not notice" || bad "the arbiter's Docker or Postgres noticed"
sudo rm -f "$MOUNT/fill"

step "A gVisor change is a reload of the same daemon"
pid_before=$(systemctl show verdikta-code-runner-docker -p MainPID --value)
sudo mkdir -p /opt/gvisor/reload-test && sudo cp /opt/gvisor/20260921.0/runsc /opt/gvisor/reload-test/runsc
sudo sed -i 's#/opt/gvisor/20260921.0/runsc#/opt/gvisor/reload-test/runsc#' /etc/verdikta-code-runner/daemon.json
sudo systemctl reload verdikta-code-runner-docker
sleep 2
check "the daemon took the new path" "$("${OWN[@]}" info --format '{{(index .Runtimes "runsc").Path}}')" /opt/gvisor/reload-test/runsc
check "same PID: no restart" "$(systemctl show verdikta-code-runner-docker -p MainPID --value)" "$pid_before"
VERDIKTA_UNATTENDED=1 bash "$TOOL" enable --disk-gb "$DISK_GB" --install-dir "$I" 2>&1 | tail -2 | cut -c1-200; rc=${PIPESTATUS[0]}
check "enable puts the pinned path back" "$rc" 0
check "the pinned path is back" "$("${OWN[@]}" info --format '{{(index .Runtimes "runsc").Path}}')" /opt/gvisor/20260921.0/runsc
check "still the same PID: enable reloaded" "$(systemctl show verdikta-code-runner-docker -p MainPID --value)" "$pid_before"
sudo rm -rf /opt/gvisor/reload-test
compare "reload"

step "An unmounted disk starts no daemon, and writes nothing to the root filesystem"
bash "$I/code-runner/stop.sh" >/dev/null 2>&1
check "the runner left no sandbox" "$("${OWN[@]}" ps -a --format '{{.Names}}' | grep -c '^vcr-')" 0
sudo systemctl stop verdikta-code-runner-docker verdikta-code-runner-containerd verdikta-code-runner-disk
mountpoint -q "$MOUNT" && bad "still mounted after the stop" || ok "stopping unmounts: the loop device is let go"
[ -z "$(losetup -j "$IMAGE")" ] && ok "no loop device left" || bad "a loop device stayed: $(losetup -j "$IMAGE")"
sudo mv "$IMAGE" "$IMAGE.away"
sudo systemctl start verdikta-code-runner-docker 2>/dev/null; rc=$?
[ "$rc" != 0 ] && ok "dockerd does not start without its disk" || bad "dockerd started without its disk"
check "dockerd is not active" "$(systemctl is-active verdikta-code-runner-docker)" "$(systemctl is-active verdikta-code-runner-docker | grep -v '^active$' || echo not-active)"
check "nothing was written under the mount point" "$(sudo ls -A "$MOUNT" | wc -l)" 0
sudo mv "$IMAGE.away" "$IMAGE"
sudo systemctl reset-failed verdikta-code-runner-disk verdikta-code-runner-containerd verdikta-code-runner-docker 2>/dev/null
# As at boot: the daemon's unit brings up its disk and containerd.
sudo systemctl start verdikta-code-runner-docker; rc=$?
check "the daemon's unit brings its disk back" "$rc" 0
"${OWN[@]}" image inspect "$(node "$CHECK" images --install-dir "$I" | tail -1)" >/dev/null 2>&1 && ok "its images survived" || bad "its images did not survive"
bash "$I/code-runner/start.sh" >/dev/null 2>&1 && ok "the runner starts again" || bad "the runner did not start again"
compare "stop and start"

step "Disable and purge"
bash "$I/external-adapter/stop.sh" >/dev/null 2>&1
VERDIKTA_UNATTENDED=1 bash "$TOOL" disable --install-dir "$I" 2>&1 | cut -c1-200
[ -e "$IMAGE" ] && ok "disable keeps the image" || bad "disable removed the image"
grep -q '^CODE_REVIEW_ENABLED=false' "$I/external-adapter/.env" && ok "disable: code review off" || bad "disable: code review on"
VERDIKTA_UNATTENDED=1 bash "$TOOL" disable --purge --install-dir "$I" 2>&1 | cut -c1-200
[ ! -e "$IMAGE" ] && ok "purge frees the image" || bad "purge left the image"
[ ! -e "$MOUNT" ] && ok "purge removes the mount point" || bad "purge left $MOUNT"
[ -z "$(losetup -j "$IMAGE" 2>/dev/null)" ] && ok "purge leaves no loop device" || bad "purge left a loop device"
[ ! -e /etc/verdikta-code-runner ] && ok "no config left" || bad "config left"
ip link show vcr0 >/dev/null 2>&1 && bad "purge left its bridge" || ok "its bridge is gone"
[ -e /opt/gvisor/20260921.0/runsc ] && ok "gVisor stays: another sandbox may share it" || bad "purge removed gVisor"
root_end=$(df -B1 --output=avail /var/lib | tail -1 | tr -d ' ')
[ $(( ROOT_FREE_0 - root_end )) -lt $(( 2 * 1024 * 1024 * 1024 )) ] && ok "the disk's space came back ($(( (ROOT_FREE_0 - root_end) / 1024 / 1024 )) MB net)" || bad "$(( (ROOT_FREE_0 - root_end) / 1024 / 1024 )) MB did not come back"
compare "purge"

echo
echo "code-review-sandbox.integration: pass=$pass fail=$fail"
[ "$fail" = 0 ]
