#!/bin/bash
#
# Verdikta Arbiter - the code-review sandbox (node A8; design §16, §9.1, §9.6)
#
# Optional. Installs what a node needs to judge stake claims, beside a live arbiter and
# without touching it:
#   - gVisor, the release @verdikta/common pins, checked by SHA-512, at an absolute path;
#   - a Docker daemon of its own: its own containerd, socket, exec root, data root and bridge,
#     no iptables, storing on a fixed-size loop-mounted ext4 image, so pulls and scratch can
#     fill only that disk (40 GB by default);
#   - the code runner, on loopback with a token of its own;
#   - the pinned base and Semgrep images, warmed;
#   - the conformance self-test: the canary's report hash against @verdikta/common's. A pass
#     is what turns code review on in the adapter and lets the node register on a code class.
#
# It never restarts, reloads or reconfigures the arbiter's Docker or its containerd, never
# touches /etc/docker or a container of the arbiter's, and installs no package: apt can
# restart Docker. A new gVisor release reaches a running daemon with `systemctl reload` of
# the runner's own daemon. A first enable that fails removes what it made, the disk image
# included. A failed refresh keeps what is there and turns code review off.
#
# Usage (from the install directory; root or sudo for the host parts):
#   code-review-sandbox.sh enable [--disk-gb N]  # install or refresh; safe to run again
#   code-review-sandbox.sh status [--quiet]      # 0 ready, 1 not installed, 2 installed and not ready, 4 this host cannot
#   code-review-sandbox.sh warm                  # pull the pinned images again
#   code-review-sandbox.sh self-test             # run the canary again
#   code-review-sandbox.sh disable [--purge]     # remove it; --purge also frees the disk image
#   code-review-sandbox.sh hold                  # code review off in the adapter unless a pass stands
#   code-review-sandbox.sh print-config          # the units and daemon config (review)
#
# Options: --install-dir DIR (default: this script's directory)
#          --user USER       (default: owner of the install directory)
#          --disk-gb N       (default: VA_CODE_REVIEW_DISK_GB, else 40; a first enable only)
#
# Exit codes: 0 done, 1 failed, 2 not ready (status), 3 no root and no usable sudo,
# 4 this host cannot (what is missing is named), 64 misuse.
#
# Test hook: VERDIKTA_SANDBOX_PREFIX puts every host path under a directory and counts as
# "systemd is present"; the tests stub systemctl, docker and mount on PATH.
#

set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# mkfs.ext4 is in sbin, which a non-root PATH can leave out.
PATH="$PATH:/usr/sbin:/sbin"

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# The release @verdikta/common pins (GVISOR_RELEASE, without its `release-`) and the SHA-512
# of its x86_64 gvisor.tar.bz2. installer/tests/code-review-sandbox.test.sh ties these to
# .github/workflows/code-runner.yml, whose release code-runner/test/unit/runtime.test.js ties to common.
GVISOR_VERSION='20260921.0'
GVISOR_SHA512='7c899979bed334f0987888c41e545cede8e1f7e67a257978c8de244c3867e32bc30d08491e9af36720273c502acd01d8d86c9844ebcbe125790c43fe6bdf563e'
GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/x86_64/gvisor.tar.bz2"

DEFAULT_DISK_GB=40
# The class's 6 GB image, its scratch and reserve, the warm images and the canary's.
MIN_DISK_GB=12
# What the image's filesystem keeps free after the image: Chainlink and Postgres write there.
HOST_SPARE_GB=10
PLATFORM='linux/amd64'

P="${VERDIKTA_SANDBOX_PREFIX:-}"
GVISOR_DIR="$P/opt/gvisor/$GVISOR_VERSION"
RUNSC="$GVISOR_DIR/runsc"
MOUNT="$P/var/lib/verdikta-code-runner"
IMAGE="$P/var/lib/verdikta-code-runner.img"
ETC="$P/etc/verdikta-code-runner"
RUNDIR="$P/run/verdikta-code-runner"
SOCK="$RUNDIR/docker.sock"
CONTAINERD_SOCK="$RUNDIR/containerd/containerd.sock"
UNIT_DIR="${VERDIKTA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
DISK_UNIT=verdikta-code-runner-disk
CONTAINERD_UNIT=verdikta-code-runner-containerd
DOCKER_UNIT=verdikta-code-runner-docker
OWN_UNITS="$DOCKER_UNIT $CONTAINERD_UNIT $DISK_UNIT"
RUNNER_PORT=8090
# The daemon's own bridge. No container attaches to it (every sandbox is --network none), but a
# daemon must have one: `"bridge": "none"` makes dockerd DELETE the host's docker0 when it starts,
# which is the arbiter's Docker's interface (measured on Docker 29, installer.yml, A8). A link-local
# /30, so it routes nothing anyone uses; no iptables rule or forwarding goes with it.
BRIDGE=vcr0
BRIDGE_ADDRESS=169.254.77.1/30

ACTION=""
INSTALL_DIR=""
RUN_USER=""
DISK_GB="${VA_CODE_REVIEW_DISK_GB:-}"
QUIET=0
PURGE=0

usage() { sed -n '2,39p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        enable|status|warm|self-test|disable|hold|print-config)
            [ -n "$ACTION" ] && { echo "only one action, please" >&2; exit 64; }
            ACTION="$1"; shift ;;
        --install-dir) shift; [ -z "${1:-}" ] && { echo "--install-dir needs a directory" >&2; exit 64; }; INSTALL_DIR="$1"; shift ;;
        --user) shift; [ -z "${1:-}" ] && { echo "--user needs a user name" >&2; exit 64; }; RUN_USER="$1"; shift ;;
        --disk-gb) shift; [ -z "${1:-}" ] && { echo "--disk-gb needs a size" >&2; exit 64; }; DISK_GB="$1"; shift ;;
        --quiet|-q) QUIET=1; shift ;;
        --purge) PURGE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done
[ -z "$ACTION" ] && { usage >&2; exit 64; }

DISK_GB="${DISK_GB:-$DEFAULT_DISK_GB}"
if ! [[ "$DISK_GB" =~ ^[0-9]{1,5}$ ]] || [ "$DISK_GB" -lt "$MIN_DISK_GB" ]; then
    echo "The disk must be a whole number of GB, at least $MIN_DISK_GB (got [$DISK_GB])." >&2
    exit 64
fi

say()  { [ "$QUIET" = "1" ] || echo -e "$@"; }
warn() { echo -e "${YELLOW}$*${NC}" >&2; }

INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
INSTALL_DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" || { echo "install directory not found: $INSTALL_DIR" >&2; exit 64; }
RUNNER_DIR="$INSTALL_DIR/code-runner"
STATE_DIR="$RUNNER_DIR/.state"
LOCK_FILE="$STATE_DIR/maintenance"
TOKEN_FILE="$STATE_DIR/token"
RUNNER_ENV="$RUNNER_DIR/.env"
ADAPTER_DIR="$INSTALL_DIR/external-adapter"
ADAPTER_ENV="$ADAPTER_DIR/.env"
CHECK="$INSTALL_DIR/code-review-check.js"
[ -f "$CHECK" ] || CHECK="$SCRIPT_DIR/code-review-check.js"
PIN_CHECK="$INSTALL_DIR/common-pin.js"
[ -f "$PIN_CHECK" ] || PIN_CHECK="$INSTALL_DIR/installer/util/common-pin.js"
[ -f "$PIN_CHECK" ] || PIN_CHECK="$SCRIPT_DIR/common-pin.js"

if [ -z "$RUN_USER" ]; then
    RUN_USER=$(stat -c %U "$INSTALL_DIR" 2>/dev/null || stat -f %Su "$INSTALL_DIR" 2>/dev/null)
    [ -z "$RUN_USER" ] && RUN_USER=$(id -un)
fi
RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null || id -gn)
RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)
[ -z "$RUN_HOME" ] && RUN_HOME="$HOME"

# Node as the arbiter's own start scripts load it.
if ! command -v node >/dev/null 2>&1 && [ -s "$RUN_HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$RUN_HOME/.nvm"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use 20.18.1 >/dev/null 2>&1
fi

############################################
# The configuration: every path the arbiter's Docker also uses a default for is named here
############################################
daemon_json() {
    cat <<EOF
{
  "data-root": "$MOUNT/docker",
  "exec-root": "$RUNDIR/exec",
  "pidfile": "$RUNDIR/docker.pid",
  "hosts": ["unix://$SOCK"],
  "group": "$RUN_GROUP",
  "containerd": "$CONTAINERD_SOCK",
  "containerd-namespace": "vcr",
  "containerd-plugins-namespace": "vcr-plugins",
  "bridge": "$BRIDGE",
  "iptables": false,
  "ip6tables": false,
  "ip-forward": false,
  "ip-masq": false,
  "userland-proxy": false,
  "live-restore": false,
  "storage-driver": "overlay2",
  "features": { "containerd-snapshotter": false },
  "runtimes": {
    "runsc": {
      "path": "$RUNSC",
      "runtimeArgs": ["--platform=systrap", "--overlay2=root:dir=$MOUNT/scratch,size=4g"]
    }
  }
}
EOF
}

containerd_toml() {
    cat <<EOF
version = 2
root = "$MOUNT/containerd"
state = "$RUNDIR/containerd-state"
disabled_plugins = ["io.containerd.grpc.v1.cri"]

[grpc]
  address = "$CONTAINERD_SOCK"

[ttrpc]
  address = "$CONTAINERD_SOCK.ttrpc"

[debug]
  address = ""

[metrics]
  address = ""
EOF
}

# Fixed means allocated, and a loop device passes discards on as holes in its file: fstrim.timer
# would make the image sparse, and its writes would then spend the root filesystem. So the device
# takes no discard, and each start allocates whatever is missing, or does not start: an image with
# holes it cannot fill would spend the root filesystem. The doctor measures the result too.
disk_unit() {
    cat <<EOF
[Unit]
Description=Verdikta code runner: the fixed-size disk of its Docker daemon
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sh -c 'mountpoint -q $MOUNT || { fallocate -l "\$\$(stat -c %%s $IMAGE)" $IMAGE && [ "\$\$(( \$\$(stat -c %%b $IMAGE) * 512 ))" -ge "\$\$(stat -c %%s $IMAGE)" ]; }'
ExecStart=/bin/sh -c 'mountpoint -q $MOUNT || mount -t ext4 -o loop,noatime,nodev,nosuid $IMAGE $MOUNT'
ExecStartPost=-/bin/sh -c 'echo 0 > /sys/block/\$\$(basename "\$\$(findmnt -no SOURCE $MOUNT)")/queue/discard_max_bytes'
ExecStop=/bin/umount $MOUNT

[Install]
WantedBy=multi-user.target
EOF
}

containerd_unit() {
    cat <<EOF
[Unit]
Description=Verdikta code runner: containerd of its own Docker daemon
After=$DISK_UNIT.service
BindsTo=$DISK_UNIT.service
AssertPathIsMountPoint=$MOUNT

[Service]
Type=notify
RuntimeDirectory=verdikta-code-runner
RuntimeDirectoryPreserve=yes
ExecStart=$(command -v containerd || echo /usr/bin/containerd) --config $ETC/containerd.toml
KillMode=process
Delegate=yes
LimitNOFILE=infinity
TasksMax=infinity
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

docker_unit() {
    cat <<EOF
[Unit]
Description=Verdikta code runner: its own Docker daemon (never the arbiter's)
After=network-online.target $DISK_UNIT.service $CONTAINERD_UNIT.service
Wants=network-online.target
BindsTo=$DISK_UNIT.service $CONTAINERD_UNIT.service
AssertPathIsMountPoint=$MOUNT

[Service]
Type=notify
ExecStartPre=/bin/sh -c 'ip link show $BRIDGE >/dev/null 2>&1 || ip link add $BRIDGE type bridge'
ExecStartPre=/bin/sh -c 'ip -4 addr show dev $BRIDGE | grep -q "${BRIDGE_ADDRESS%/*}/" || ip addr add $BRIDGE_ADDRESS dev $BRIDGE'
ExecStart=$(command -v dockerd || echo /usr/bin/dockerd) --config-file $ETC/daemon.json
ExecReload=/bin/kill -s HUP \$MAINPID
TimeoutStartSec=120
KillMode=process
Delegate=yes
LimitNOFILE=infinity
TasksMax=infinity
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

############################################
# Privileges and the host
############################################
have_systemd() {
    command -v systemctl >/dev/null 2>&1 || return 1
    [ -d /run/systemd/system ] || [ -n "$P" ]
}

# Run a command as root: directly when we are root, else through sudo. Unattended runs need
# passwordless sudo, as the installer's other host steps do.
SUDO=()
as_root() {
    if [ "$(id -u)" = "0" ]; then "$@"; return $?; fi
    if [ "${#SUDO[@]}" -eq 0 ]; then
        command -v sudo >/dev/null 2>&1 || return 3
        if sudo -n true 2>/dev/null; then
            SUDO=(sudo -n)
        elif [ "${VERDIKTA_UNATTENDED:-0}" != "1" ] && [ -t 0 ]; then
            SUDO=(sudo)
        else
            return 3
        fi
    fi
    "${SUDO[@]}" "$@"
}

# The install's own files belong to the install's user, whoever runs this.
as_user() {
    if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; return $?; fi
    runuser -u "$RUN_USER" -- "$@"
}
own() {
    if [ "$(id -u)" = "0" ]; then chown -R "$RUN_USER:$RUN_GROUP" "$@"; fi
}

# What this host lacks, one line each; empty when it can run the sandbox.
host_problems() {
    local arch tool
    arch=$(uname -m)
    [ "$arch" = "x86_64" ] || echo "the class platform is linux/amd64, and this host is $arch"
    have_systemd || echo "no systemd: the runner's daemon and disk are systemd units"
    for tool in dockerd containerd docker ip curl tar bzip2 sha512sum fallocate mkfs.ext4 mount umount mountpoint df node npm; do
        command -v "$tool" >/dev/null 2>&1 || echo "$tool is not on PATH (this script installs no package: apt can restart Docker)"
    done
}

own_docker() { # the runner's daemon, with no operator credentials
    DOCKER_CONFIG="$DOCKER_CONFIG_DIR" docker --host "unix://$SOCK" "$@"
}

############################################
# The lock, and what happens on the way out
############################################
# The lock file says who holds it: `<holder> <pid> <time>`. Maintenance operations are one at a time,
# or the first to finish would lift the lock from under the second. So another live holder is a
# refusal; the upgrade that started this run hands its own down (CODE_REVIEW_LOCK_PARENT), and keeps
# it; a dead holder's file is stale and taken over; one with no pid is an operator's, and stays theirs.
LOCK_MINE=0
TMP_DIR=""
lock_write() { echo "code-review-sandbox $$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"; }
lock_take() {
    local holder
    mkdir -p "$STATE_DIR" 2>/dev/null
    if ( set -C; lock_write ) 2>/dev/null; then
        LOCK_MINE=1
    else
        holder=$(awk '{print $2; exit}' "$LOCK_FILE" 2>/dev/null)
        if [[ "$holder" =~ ^[0-9]+$ ]]; then
            if [ "$holder" = "${CODE_REVIEW_LOCK_PARENT:-}" ]; then
                :
            elif kill -0 "$holder" 2>/dev/null; then
                echo -e "${RED}Another maintenance operation holds $LOCK_FILE (pid $holder): $(cat "$LOCK_FILE"). Wait for it, or remove the file if it is gone.${NC}" >&2
                exit 1
            else
                lock_write && LOCK_MINE=1
            fi
        fi
    fi
    own "$STATE_DIR" 2>/dev/null
}
# The way out of a run, however it comes: a signal after the disk was allocated still removes it.
# bash runs a signal's trap when the foreground child ends, so the child is not left using the disk.
ENABLE_RUNNING=0
on_exit() {
    trap '' TERM INT HUP
    if [ "$ENABLE_RUNNING" = "1" ]; then
        ENABLE_RUNNING=0
        end_failed_enable
    fi
    if [ "$LOCK_MINE" = "1" ]; then rm -f "$LOCK_FILE"; fi
    if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

TMP_DIR=$(mktemp -d)
DOCKER_CONFIG_DIR="$TMP_DIR/docker-config"
mkdir -p "$DOCKER_CONFIG_DIR"

############################################
# Steps. Each says why it failed and returns non-zero.
############################################
FRESH=0
DISK_CREATED=0

install_gvisor() {
    # The sandbox's binaries sit beside runsc in the release (gvisor-bin/): the whole release, or none.
    if [ -x "$RUNSC" ] && [ -x "$GVISOR_DIR/gvisor-bin/gvisor_sentry" ] && "$RUNSC" --version 2>/dev/null | grep -q "release-$GVISOR_VERSION\$"; then
        say "gVisor $GVISOR_VERSION is already at $RUNSC."
        return 0
    fi
    say "Installing gVisor $GVISOR_VERSION..."
    if ! curl -fsSL --retry 3 --max-time 300 -o "$TMP_DIR/gvisor.tar.bz2" "$GVISOR_URL"; then
        echo -e "${RED}Could not download $GVISOR_URL${NC}" >&2; return 1
    fi
    if ! (cd "$TMP_DIR" && echo "$GVISOR_SHA512  gvisor.tar.bz2" | sha512sum -c - >/dev/null 2>&1); then
        echo -e "${RED}The gVisor download does not match its pinned SHA-512: refused.${NC}" >&2; return 1
    fi
    mkdir -p "$TMP_DIR/gvisor"
    tar -xjf "$TMP_DIR/gvisor.tar.bz2" -C "$TMP_DIR/gvisor" || { echo -e "${RED}Could not unpack gVisor.${NC}" >&2; return 1; }
    # Executable by anyone, up the whole path: the runner's user asks this binary its release.
    as_root mkdir -p "$(dirname "$GVISOR_DIR")" && as_root chmod 0755 "$(dirname "$GVISOR_DIR")" \
        && as_root rm -rf "$GVISOR_DIR.new" && as_root cp -R "$TMP_DIR/gvisor" "$GVISOR_DIR.new" \
        && as_root chown -R root:root "$GVISOR_DIR.new" && as_root chmod -R a+rX,go-w "$GVISOR_DIR.new" \
        && as_root rm -rf "$GVISOR_DIR" && as_root mv -f "$GVISOR_DIR.new" "$GVISOR_DIR" \
        || { echo -e "${RED}Could not install gVisor at $GVISOR_DIR.${NC}" >&2; return 1; }
}

disk_preflight() {
    [ -e "$IMAGE" ] && return 0
    local dir avail need
    dir="$(dirname "$IMAGE")"
    avail=$(df -B1 --output=avail "$dir" 2>/dev/null | tail -1 | tr -d ' ')
    if ! [[ "$avail" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Could not read the free space on $dir.${NC}" >&2; return 4
    fi
    need=$(( (DISK_GB + HOST_SPARE_GB) * 1024 * 1024 * 1024 ))
    if [ "$avail" -lt "$need" ]; then
        echo -e "${RED}$dir has $((avail / 1024 / 1024 / 1024)) GB free: a $DISK_GB GB disk image plus the $HOST_SPARE_GB GB the arbiter keeps does not fit. Free some, or use --disk-gb (at least $MIN_DISK_GB).${NC}" >&2
        return 4
    fi
}

create_disk() {
    if [ -e "$IMAGE" ]; then
        say "The disk image $IMAGE is there; keeping it."
        return 0
    fi
    say "Creating the $DISK_GB GB disk image $IMAGE..."
    as_root rm -f "$IMAGE.partial"
    # Allocated, not sparse: writes to it can never run the root filesystem out of space. mkfs
    # would discard it again, which on a file punches holes: -E nodiscard (measured, A8).
    if ! as_root fallocate -l "${DISK_GB}G" "$IMAGE.partial"; then
        as_root rm -f "$IMAGE.partial"
        echo -e "${RED}Could not allocate $DISK_GB GB at $IMAGE (fallocate).${NC}" >&2; return 1
    fi
    if ! as_root mkfs.ext4 -F -q -m 0 -i 8192 -E nodiscard -L vcr-docker "$IMAGE.partial"; then
        as_root rm -f "$IMAGE.partial"
        echo -e "${RED}Could not format the disk image.${NC}" >&2; return 1
    fi
    as_root chmod 0600 "$IMAGE.partial"
    as_root mv -f "$IMAGE.partial" "$IMAGE" || { as_root rm -f "$IMAGE.partial"; return 1; }
    DISK_CREATED=1
}

# Installs stdin at DEST as root. 0 when it changed, 1 when it was already that, 2 on failure.
put_root() {
    local dest="$1" mode="$2" tmp="$TMP_DIR/put.$$"
    cat > "$tmp"
    if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then rm -f "$tmp"; return 1; fi
    as_root cp "$tmp" "$dest.new" && as_root chmod "$mode" "$dest.new" && as_root mv -f "$dest.new" "$dest" || { rm -f "$tmp"; return 2; }
    rm -f "$tmp"
    return 0
}

# Measured from the daemon that answers: whichever daemon that is.
daemon_verify() {
    local root driver runsc
    root=$(own_docker info --format '{{.DockerRootDir}}' 2>/dev/null)
    if [ "$root" != "$MOUNT/docker" ]; then
        echo -e "${RED}The daemon on $SOCK stores under [$root], not $MOUNT/docker: refused.${NC}" >&2; return 1
    fi
    driver=$(own_docker info --format '{{.Driver}}' 2>/dev/null)
    if [ "$driver" != "overlay2" ]; then
        echo -e "${RED}The daemon on $SOCK uses the storage driver [$driver]; only overlay2 keeps layers on the fixed disk.${NC}" >&2; return 1
    fi
    runsc=$(own_docker info --format '{{(index .Runtimes "runsc").Path}}' 2>/dev/null)
    if [ "$runsc" != "$RUNSC" ]; then
        echo -e "${RED}The daemon on $SOCK names runsc at [$runsc], not $RUNSC.${NC}" >&2; return 1
    fi
}

daemon_wait() {
    local waited=0
    until own_docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
        if [ "$waited" -ge "${CODE_REVIEW_DAEMON_WAIT_SECS:-60}" ]; then
            echo -e "${RED}The runner's Docker daemon did not answer on $SOCK after ${waited}s. See: journalctl -u $DOCKER_UNIT${NC}" >&2
            return 1
        fi
        sleep 1; waited=$((waited+1))
    done
}

# The config and the units. Only this phase's own units are ever named to systemctl.
bring_up() {
    local rc units_changed=0 config_changed=0 ctd_changed=0
    as_root mkdir -p "$ETC" "$UNIT_DIR" "$MOUNT" || return 1
    daemon_json > "$TMP_DIR/daemon.json"
    if dockerd --help 2>/dev/null | grep -q -- --validate; then
        if ! as_root dockerd --validate --config-file "$TMP_DIR/daemon.json" >/dev/null 2>&1; then
            echo -e "${RED}dockerd refuses the configuration in $TMP_DIR/daemon.json; this Docker is too old?${NC}" >&2; return 1
        fi
    fi
    rc=0; put_root "$ETC/daemon.json" 0644 < "$TMP_DIR/daemon.json" || rc=$?
    case "$rc" in 0) config_changed=1 ;; 1) ;; *) return 1 ;; esac
    rc=0; containerd_toml | put_root "$ETC/containerd.toml" 0644 || rc=$?
    case "$rc" in 0) ctd_changed=1 ;; 1) ;; *) return 1 ;; esac
    for u in "$DISK_UNIT:disk_unit" "$CONTAINERD_UNIT:containerd_unit" "$DOCKER_UNIT:docker_unit"; do
        rc=0; "${u#*:}" | put_root "$UNIT_DIR/${u%%:*}.service" 0644 || rc=$?
        case "$rc" in 0) units_changed=1 ;; 1) ;; *) return 1 ;; esac
    done
    if [ "$units_changed" = "1" ]; then as_root systemctl daemon-reload || return 1; fi
    # shellcheck disable=SC2086
    as_root systemctl enable $DISK_UNIT $CONTAINERD_UNIT $DOCKER_UNIT >/dev/null 2>&1 || { echo -e "${RED}Could not enable the units.${NC}" >&2; return 1; }

    as_root systemctl start "$DISK_UNIT" || { echo -e "${RED}Could not mount the disk. See: journalctl -u $DISK_UNIT${NC}" >&2; return 1; }
    if ! mountpoint -q "$MOUNT"; then echo -e "${RED}$MOUNT is not mounted.${NC}" >&2; return 1; fi
    as_root mkdir -p "$MOUNT/docker" "$MOUNT/containerd" "$MOUNT/scratch" "$MOUNT/selftest" || return 1
    as_root chmod 0700 "$MOUNT/scratch" || return 1
    as_root chown "$RUN_USER:$RUN_GROUP" "$MOUNT/selftest" || return 1

    local was_active=0
    if systemctl is-active --quiet "$DOCKER_UNIT"; then was_active=1; fi
    if [ "$units_changed" = "1" ] || [ "$ctd_changed" = "1" ]; then
        # Its own daemon, under the lock: no run is in flight, and the arbiter's Docker has no part in this.
        if [ "$was_active" = "1" ]; then as_root systemctl restart "$CONTAINERD_UNIT" "$DOCKER_UNIT" || return 1; fi
    elif [ "$config_changed" = "1" ] && [ "$was_active" = "1" ]; then
        as_root systemctl reload "$DOCKER_UNIT" || { echo -e "${RED}Could not reload the runner's daemon.${NC}" >&2; return 1; }
    fi
    as_root systemctl start "$CONTAINERD_UNIT" || { echo -e "${RED}Could not start containerd. See: journalctl -u $CONTAINERD_UNIT${NC}" >&2; return 1; }
    as_root systemctl start "$DOCKER_UNIT" || { echo -e "${RED}Could not start the runner's Docker daemon. See: journalctl -u $DOCKER_UNIT${NC}" >&2; return 1; }
    daemon_wait || return 1
    # A reload is a signal: the daemon takes it in its own time. A setting a reload cannot take shows
    # up after that wait, and only then does its own daemon restart, once.
    if [ "$was_active" = "1" ] && [ "$config_changed" = "1" ]; then
        local waited=0
        until daemon_verify 2>/dev/null || [ "$waited" -ge "${CODE_REVIEW_RELOAD_WAIT_SECS:-30}" ]; do
            sleep 1; waited=$((waited+1))
        done
        if ! daemon_verify 2>/dev/null; then
            as_root systemctl restart "$DOCKER_UNIT" || return 1
            daemon_wait || return 1
        fi
    fi
    daemon_verify
}

set_env_line() { # set_env_line FILE KEY VALUE: replace or append, keeping the file's mode
    local file="$1" key="$2" value="$3" tmp
    [ -f "$file" ] || : > "$file"
    tmp="$file.new.$$"
    K="$key" V="$value" awk 'BEGIN{k=ENVIRON["K"];v=ENVIRON["V"];done=0}
        index($0,k"=")==1 {print k"="v; done=1; next} {print}
        END{if(!done)print k"="v}' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
    chmod --reference="$file" "$tmp" 2>/dev/null
    mv -f "$tmp" "$file"
}

env_value() { # env_value FILE KEY: as data, quotes off
    [ -f "$1" ] || return 0
    grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# The largest local model: admission keeps its memory free. Asked of Ollama's API, in JSON.
local_model_mb() {
    local mb
    mb=$(curl -s --max-time 5 http://127.0.0.1:11434/api/tags 2>/dev/null | node -e '
        let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
          try { const m = JSON.parse(s).models || []; console.log(Math.ceil(Math.max(0, ...m.map((x) => Number(x.size) || 0)) / 1048576)); }
          catch (_) { console.log(0); }
        });' 2>/dev/null)
    [[ "$mb" =~ ^[0-9]+$ ]] && echo "$mb" || echo 0
}

configure_runner() {
    [ -f "$RUNNER_DIR/package.json" ] || { echo -e "${RED}$RUNNER_DIR is not there. Run upgrade-arbiter.sh first.${NC}" >&2; return 1; }
    mkdir -p "$STATE_DIR" || return 1
    chmod 0700 "$STATE_DIR"
    if [ ! -s "$TOKEN_FILE" ]; then
        ( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex")+"\n")' > "$TOKEN_FILE" ) || return 1
    fi
    chmod 0600 "$TOKEN_FILE"
    cat > "$RUNNER_ENV.new" <<EOF
DOCKER_HOST=unix://$SOCK
CODE_RUNNER_RUNTIME=runsc
CODE_RUNNER_HOST=127.0.0.1
CODE_RUNNER_PORT=$RUNNER_PORT
CODE_RUNNER_TOKEN_FILE=$TOKEN_FILE
CODE_RUNNER_STATE_DIR=$STATE_DIR
CODE_RUNNER_DATA_ROOT=$MOUNT
CODE_RUNNER_REGISTRY_ALLOWLIST=ghcr.io/verdikta
CODE_RUNNER_SLOTS=${VA_CODE_RUNNER_SLOTS:-1}
CODE_RUNNER_RESERVE_LOCAL_MODEL_MB=$(local_model_mb)
LOG_LEVEL=info
EOF
    mv -f "$RUNNER_ENV.new" "$RUNNER_ENV" || return 1
    own "$STATE_DIR" "$RUNNER_ENV"
    local pinned installed
    pinned=$(node "$PIN_CHECK" "$RUNNER_DIR" 2>/dev/null)
    installed=$(node -p 'require(process.argv[1]).version' "$RUNNER_DIR/node_modules/@verdikta/common/package.json" 2>/dev/null)
    if [ -z "$pinned" ] || [ "$pinned" != "$installed" ]; then
        say "Installing the code runner's dependencies..."
        (cd "$RUNNER_DIR" && as_user npm ci --omit=dev --no-audit --no-fund >/dev/null) || { echo -e "${RED}npm ci failed in $RUNNER_DIR.${NC}" >&2; return 1; }
    fi
}

restart_runner() {
    as_user bash "$RUNNER_DIR/stop.sh" >/dev/null 2>&1
    as_user bash "$RUNNER_DIR/start.sh" || { echo -e "${RED}The code runner did not start.${NC}" >&2; return 1; }
}

warm_images() {
    local refs ref
    refs=$(node "$CHECK" images --install-dir "$INSTALL_DIR") || { echo -e "${RED}Could not read the pinned images.${NC}" >&2; return 1; }
    for ref in $refs; do
        say "Warming $ref..."
        if ! timeout 1200 env DOCKER_CONFIG="$DOCKER_CONFIG_DIR" docker --host "unix://$SOCK" pull --quiet --platform "$PLATFORM" "$ref" >/dev/null; then
            echo -e "${RED}Could not pull $ref on the runner's daemon.${NC}" >&2; return 1
        fi
    done
}

# Warmth first: the canary pulls what is missing, and that would hide a cold host.
self_test() {
    local refs ref rc=0 result="$STATE_DIR/conformance-run.json"
    refs=$(node "$CHECK" images --install-dir "$INSTALL_DIR") || { echo -e "${RED}Could not read the pinned images.${NC}" >&2; return 1; }
    for ref in $refs; do
        if ! own_docker image inspect "$ref" >/dev/null 2>&1; then
            echo -e "${RED}$ref is not on the runner's daemon: warm the images first (code-review-sandbox.sh warm).${NC}" >&2; return 1
        fi
    done
    say "Running the conformance self-test (a few minutes; it needs ghcr.io and binaries.soliditylang.org, and port 5987 on loopback)..."
    rm -f "$result"
    # A killed self-test's registry would still hold the canary's port. Only this daemon's, by its name.
    local stale
    stale=$(own_docker ps -aq --filter name=vcr-cal-registry- 2>/dev/null)
    # shellcheck disable=SC2086
    [ -z "$stale" ] || own_docker rm -f --volumes $stale >/dev/null 2>&1
    # Its downloads and its image go on the fixed disk, and it gets no key: env -i.
    (cd "$RUNNER_DIR" && as_user env -i PATH="$PATH" HOME="$RUN_HOME" \
        DOCKER_HOST="unix://$SOCK" CODE_RUNNER_RUNTIME=runsc CODE_RUNNER_CONFORMANCE_REGISTRY_NETWORK=host TMPDIR="$MOUNT/selftest" \
        node conformance/run.js --json "$result") || rc=$?
    as_user find "$MOUNT/selftest" -mindepth 1 -delete 2>/dev/null
    if [ "$rc" != "0" ]; then
        rm -f "$STATE_DIR/conformance.json"
        echo -e "${RED}The conformance self-test failed (exit $rc). Its output is above.${NC}" >&2; return 1
    fi
    rc=0
    node "$CHECK" record --install-dir "$INSTALL_DIR" --result "$result" || rc=$?
    rm -f "$result"
    own "$STATE_DIR"
    [ "$rc" = "0" ] || return 1
    say "${GREEN}Conformance self-test passed.${NC}"
}

adapter_up() { curl -fsS --max-time 3 http://127.0.0.1:8080/version >/dev/null 2>&1; }

# The adapter reads .env when it starts. A node that does not run it yet reads this at its next start.
restart_adapter_if_up() {
    adapter_up || return 0
    say "Restarting the External Adapter so it reads its new settings..."
    as_user bash "$ADAPTER_DIR/stop.sh" >/dev/null 2>&1
    (cd "$ADAPTER_DIR" && as_user bash ./start.sh >/dev/null 2>&1)
}

# Dev trust is never written here: it is for a developer's hand, on a test chain.
adapter_env_on() {
    local before chain network
    before=$(cat "$ADAPTER_ENV" 2>/dev/null)
    cp -p "$ADAPTER_ENV" "$TMP_DIR/adapter.env.before" 2>/dev/null
    network=$(env_value "$INSTALL_DIR/installer/.env" DEPLOYMENT_NETWORK)
    chain=$(env_value "$INSTALL_DIR/installer/.env" NETWORK_CHAIN_ID)
    case "$chain:$network" in
        :base_mainnet) chain=8453 ;;
        :base_sepolia) chain=84532 ;;
    esac
    set_env_line "$ADAPTER_ENV" CODE_REVIEW_ENABLED true || return 1
    set_env_line "$ADAPTER_ENV" CODE_REVIEW_TRUST production || return 1
    set_env_line "$ADAPTER_ENV" CODE_RUNNER_URL "http://127.0.0.1:$RUNNER_PORT" || return 1
    set_env_line "$ADAPTER_ENV" CODE_RUNNER_TOKEN_FILE "$TOKEN_FILE" || return 1
    [ -n "$chain" ] && { set_env_line "$ADAPTER_ENV" NETWORK_CHAIN_ID "$chain" || return 1; }
    [ -n "$network" ] && { set_env_line "$ADAPTER_ENV" DEPLOYMENT_NETWORK "$network" || return 1; }
    own "$ADAPTER_ENV"
    [ "$before" != "$(cat "$ADAPTER_ENV")" ] || return 0
    restart_adapter_if_up && return 0
    # Text requests are what that stopped: back to what it ran, and say so.
    echo -e "${RED}The External Adapter did not restart on its new settings. Going back to the old ones.${NC}" >&2
    if [ -f "$TMP_DIR/adapter.env.before" ]; then
        cp -p "$TMP_DIR/adapter.env.before" "$ADAPTER_ENV"
    else
        rm -f "$ADAPTER_ENV"
    fi
    own "$ADAPTER_ENV"
    (cd "$ADAPTER_DIR" && as_user bash ./start.sh >/dev/null 2>&1) \
        || echo -e "${RED}The External Adapter is DOWN: run $ADAPTER_DIR/start.sh${NC}" >&2
    return 1
}

adapter_env_off() {
    [ -f "$ADAPTER_ENV" ] || return 0
    grep -q '^CODE_REVIEW_ENABLED=true' "$ADAPTER_ENV" || return 0
    set_env_line "$ADAPTER_ENV" CODE_REVIEW_ENABLED false
    own "$ADAPTER_ENV"
    restart_adapter_if_up && return 0
    echo -e "${RED}The External Adapter did not restart after code review went off: it is DOWN. Run $ADAPTER_DIR/start.sh${NC}" >&2
    return 1
}

# What a failed first enable made goes again. The arbiter's Docker is not in this list.
remove_own_units() {
    local u
    for u in $OWN_UNITS; do
        as_root systemctl stop "$u" 2>/dev/null
    done
    # shellcheck disable=SC2086
    as_root systemctl disable $OWN_UNITS >/dev/null 2>&1
    for u in $OWN_UNITS; do
        as_root rm -f "$UNIT_DIR/$u.service"
    done
    as_root systemctl daemon-reload 2>/dev/null
    as_root rm -rf "$ETC"
    if ip link show "$BRIDGE" >/dev/null 2>&1; then as_root ip link del "$BRIDGE"; fi
}

purge_disk() {
    if mountpoint -q "$MOUNT" 2>/dev/null; then
        as_root umount "$MOUNT" || { echo -e "${RED}$MOUNT is still in use; the image stays at $IMAGE.${NC}" >&2; return 1; }
    fi
    as_root rm -f "$IMAGE" "$IMAGE.partial"
    as_root rm -rf "$MOUNT"
}

# An image this run did not make stays, unmounted: an earlier `disable` kept it on purpose.
rollback_fresh() {
    warn "Removing what this enable made..."
    [ -f "$RUNNER_DIR/stop.sh" ] && as_user bash "$RUNNER_DIR/stop.sh" >/dev/null 2>&1
    remove_own_units
    if [ "$DISK_CREATED" = "1" ]; then
        purge_disk
    else
        as_root rm -f "$IMAGE.partial"
        if mountpoint -q "$MOUNT" 2>/dev/null; then as_root umount "$MOUNT"; fi
        [ -e "$IMAGE" ] || as_root rm -rf "$MOUNT"
        [ -e "$IMAGE" ] && warn "The disk image from before stays at $IMAGE: $0 disable --purge frees it."
    fi
    rm -f "$RUNNER_ENV" "$STATE_DIR/conformance.json"
    adapter_env_off
}

# The end of an enable that did not finish, by what it was: a failed step, or a signal.
end_failed_enable() {
    if [ "$FRESH" = "1" ]; then
        rollback_fresh
        echo -e "${RED}The code-review sandbox was not installed. The rest of the arbiter was not touched.${NC}" >&2
    else
        rm -f "$STATE_DIR/conformance.json"
        adapter_env_off
        echo -e "${RED}The code-review sandbox was not refreshed. It stays installed, code review is off until a pass, and the rest of the arbiter was not touched. Run: $0 enable${NC}" >&2
    fi
}
failed() {
    ENABLE_RUNNING=0
    end_failed_enable
    exit 1
}

# A node that has the sandbox, cannot refresh it and has no pass for what it now runs judges no claim.
hold_without_a_pass() {
    [ -f "$RUNNER_ENV" ] || return 0
    node "$CHECK" conformance --install-dir "$INSTALL_DIR" >/dev/null 2>&1 && return 0
    warn "No conformance pass for this release: code review goes off in the adapter until there is one."
    adapter_env_off
}
refuse_enable() { # refuse_enable RC: before anything was changed
    hold_without_a_pass
    exit "$1"
}

check_host() {
    local problems
    problems=$(host_problems)
    if [ -n "$problems" ]; then
        echo -e "${RED}This host cannot run the code-review sandbox:${NC}" >&2
        printf '  - %s\n' "$problems" >&2
        refuse_enable 4
    fi
}
check_root() {
    if ! as_root true; then
        echo -e "${RED}The sandbox's host steps need root or passwordless sudo. Run as root: $0 $ACTION${NC}" >&2
        refuse_enable 3
    fi
}

############################################
# Actions
############################################
do_enable() {
    check_host
    check_root
    [ -f "$RUNNER_ENV" ] || FRESH=1
    local rc=0
    disk_preflight || rc=$?
    [ "$rc" = "0" ] || refuse_enable "$rc"
    if ! node "$PIN_CHECK" --agree "$INSTALL_DIR" >/dev/null 2>&1; then
        echo -e "${RED}The AI Node, the External Adapter and the code runner do not pin one @verdikta/common release:${NC}" >&2
        node "$PIN_CHECK" --agree "$INSTALL_DIR" >&2
        refuse_enable 1
    fi
    lock_take
    ENABLE_RUNNING=1
    if [ -e "$IMAGE" ] && [ "$DISK_GB" != "$DEFAULT_DISK_GB" ]; then
        say "The disk image is kept as it is, and never resized. For another size: $0 disable --purge, then enable --disk-gb $DISK_GB"
    fi
    install_gvisor || failed
    create_disk || failed
    bring_up || failed
    configure_runner || failed
    restart_runner || failed
    warm_images || failed
    if ! node "$CHECK" conformance --install-dir "$INSTALL_DIR" >/dev/null 2>&1; then
        self_test || failed
    fi
    adapter_env_on || failed
    ENABLE_RUNNING=0
    say "${GREEN}The code-review sandbox is ready: gVisor $GVISOR_VERSION, its own Docker on $SOCK, a conformance pass.${NC}"
    say "Code review is on in the adapter. Turn it off with: $0 disable"
}

do_status() {
    local problems rc=0 u
    if [ ! -f "$RUNNER_ENV" ]; then
        problems=$(host_problems | head -5)
        if [ -n "$problems" ]; then
            say "Not installed, and this host cannot run it:"; say "$problems"
            exit 4
        fi
        say "The code-review sandbox is not installed."
        if [ -e "$IMAGE" ]; then say "A disk image stays at $IMAGE: $0 disable --purge frees it."; fi
        exit 1
    fi
    for u in $OWN_UNITS; do
        if ! systemctl is-active --quiet "$u" 2>/dev/null; then say "$u is not active."; rc=2; fi
    done
    if ! node "$CHECK" conformance --install-dir "$INSTALL_DIR" >/dev/null 2>&1; then
        [ "$QUIET" = "1" ] || node "$CHECK" conformance --install-dir "$INSTALL_DIR"
        rc=2
    fi
    if [ "$rc" = "0" ]; then say "${GREEN}The code-review sandbox is installed, with a conformance pass.${NC}"; fi
    exit "$rc"
}

do_warm() {
    [ -f "$RUNNER_ENV" ] || { echo "The code-review sandbox is not installed." >&2; exit 1; }
    lock_take
    warm_images || exit 1
}

do_self_test() {
    [ -f "$RUNNER_ENV" ] || { echo "The code-review sandbox is not installed." >&2; exit 1; }
    lock_take
    if self_test; then
        adapter_env_on || exit 1
    else
        rm -f "$STATE_DIR/conformance.json"
        adapter_env_off
        exit 1
    fi
}

do_disable() {
    check_root
    lock_take
    [ -f "$RUNNER_DIR/stop.sh" ] && as_user bash "$RUNNER_DIR/stop.sh" >/dev/null 2>&1
    local rc=0
    adapter_env_off || rc=1
    remove_own_units
    rm -f "$RUNNER_ENV" "$STATE_DIR/conformance.json"
    if [ "$PURGE" = "1" ]; then
        purge_disk || exit 1
        say "${GREEN}The code-review sandbox is removed, with its disk image.${NC}"
    else
        say "${GREEN}The code-review sandbox is off.${NC} The disk image stays at $IMAGE; to free it: $0 disable --purge"
    fi
    say "gVisor stays at $GVISOR_DIR: another sandbox on this host may use it."
    exit "$rc"
}

# What an upgrade calls once the new runner is in place, before anything starts it.
do_hold() {
    hold_without_a_pass
}

do_print_config() {
    echo "# daemon.json"; daemon_json
    echo "# containerd.toml"; containerd_toml
    echo "# $DISK_UNIT.service"; disk_unit
    echo "# $CONTAINERD_UNIT.service"; containerd_unit
    echo "# $DOCKER_UNIT.service"; docker_unit
}

case "$ACTION" in
    enable) do_enable ;;
    status) do_status ;;
    warm) do_warm ;;
    self-test) do_self_test ;;
    disable) do_disable ;;
    hold) do_hold ;;
    print-config) do_print_config ;;
esac
