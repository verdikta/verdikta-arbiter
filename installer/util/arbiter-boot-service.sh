#!/bin/bash
#
# Verdikta Arbiter - start at boot (2026-10-18 Contabo reboot wave)
#
# Six operator VMs were rebooted by the hosting provider and every arbiter on
# them stayed down until someone ran start-arbiter.sh by hand (15 hours on the
# main mainnet node). Nothing brought the node back: the chainlink and
# cl-postgres containers had Docker's default restart policy ("no") and the AI
# Node / External Adapter are plain background processes.
#
# This tool makes a node come back on its own:
#   - the two containers get `--restart unless-stopped` (Docker restarts them
#     after a reboot or daemon restart unless an operator stopped them), and
#   - a systemd unit, verdikta-arbiter.service, runs <install-dir>/start-arbiter.sh
#     after docker.service and the network are up, as the install's user. It is a
#     oneshot unit with no Restart= line: stop-arbiter.sh keeps working and
#     nothing is restarted behind the operator's back. `systemctl stop` runs
#     stop-arbiter.sh, so a disabled unit leaves the whole node down after a
#     reboot instead of a half-up one (containers back, adapter missing).
#
# Usage (from the install directory; needs root or sudo for the systemd part):
#   arbiter-boot-service.sh enable          # restart policies + unit, enabled for the next boot
#   arbiter-boot-service.sh disable         # disable + remove the unit, containers back to --restart no
#   arbiter-boot-service.sh status [--quiet]  # exit 0 configured, 1 not configured, 2 no systemd
#   arbiter-boot-service.sh print-unit      # the unit text (review, systemd-analyze verify)
#
# Options: --install-dir DIR (default: this script's directory)
#          --user USER        (default: owner of the install directory)
#          --unit-name NAME   (default: verdikta-arbiter)
#
# Exit codes: 0 done, 1 not configured (status) / failed, 2 systemd not available
# (container policies are still applied), 3 no root and no usable sudo, 64 misuse.
#
# Test hook: VERDIKTA_SYSTEMD_UNIT_DIR overrides /etc/systemd/system (and counts
# as "systemd is present"; the tests stub systemctl on PATH).
#

set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

ACTION=""
INSTALL_DIR=""
RUN_USER=""
UNIT_NAME="verdikta-arbiter"
QUIET=0
UNIT_DIR="${VERDIKTA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
CONTAINERS="cl-postgres chainlink"

usage() { sed -n '2,36p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        enable|disable|status|print-unit)
            [ -n "$ACTION" ] && { echo "only one action, please" >&2; exit 64; }
            ACTION="$1"; shift ;;
        --install-dir) shift; [ -z "${1:-}" ] && { echo "--install-dir needs a directory" >&2; exit 64; }; INSTALL_DIR="$1"; shift ;;
        --user) shift; [ -z "${1:-}" ] && { echo "--user needs a user name" >&2; exit 64; }; RUN_USER="$1"; shift ;;
        --unit-name) shift; [ -z "${1:-}" ] && { echo "--unit-name needs a name" >&2; exit 64; }; UNIT_NAME="${1%.service}"; shift ;;
        --quiet|-q) QUIET=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done
[ -z "$ACTION" ] && { usage >&2; exit 64; }

say()  { [ "$QUIET" = "1" ] || echo -e "$@"; }
warn() { echo -e "${YELLOW}$*${NC}" >&2; }

############################################
# Install dir, user, home
############################################
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
INSTALL_DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" || { echo "install directory not found: $INSTALL_DIR" >&2; exit 64; }
START_SCRIPT="$INSTALL_DIR/start-arbiter.sh"
STOP_SCRIPT="$INSTALL_DIR/stop-arbiter.sh"

if [ -z "$RUN_USER" ]; then
    RUN_USER=$(stat -c %U "$INSTALL_DIR" 2>/dev/null || stat -f %Su "$INSTALL_DIR" 2>/dev/null)
    [ -z "$RUN_USER" ] && RUN_USER=$(id -un)
fi
RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)
if [ -z "$RUN_HOME" ]; then
    if [ "$RUN_USER" = "$(id -un)" ]; then RUN_HOME="$HOME"
    elif [ "$RUN_USER" = "root" ]; then RUN_HOME="/root"
    else RUN_HOME="/home/$RUN_USER"; fi
fi

UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"

############################################
# systemd / privilege helpers
############################################
have_systemd() {
    command -v systemctl >/dev/null 2>&1 || return 1
    [ -d /run/systemd/system ] || [ -n "${VERDIKTA_SYSTEMD_UNIT_DIR:-}" ]
}

# Run a command as root: directly when we are root, else through sudo. A
# password prompt is fine on a terminal; unattended runs need passwordless
# sudo (the installer already assumes that for its prerequisites).
SUDO=()
as_root() {
    if [ "$(id -u)" = "0" ]; then "$@"; return $?; fi
    if [ "${#SUDO[@]}" -eq 0 ]; then
        if ! command -v sudo >/dev/null 2>&1; then return 3; fi
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

unit_text() {
    cat <<EOF
# Verdikta Arbiter node - generated by arbiter-boot-service.sh; re-run
# "$INSTALL_DIR/arbiter-boot-service.sh enable" instead of editing.
#
# Starts the AI Node, the External Adapter and the chainlink / cl-postgres
# containers through start-arbiter.sh once Docker and the network are up.
# oneshot + RemainAfterExit: start-arbiter.sh launches the components and
# exits; systemd does not supervise or restart them (stop-arbiter.sh keeps
# working, the watchdog does the health checks). "systemctl stop" runs
# stop-arbiter.sh.
[Unit]
Description=Verdikta Arbiter node (AI Node, External Adapter, Chainlink node)
Documentation=https://github.com/verdikta/verdikta-arbiter
After=network-online.target docker.service containerd.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
Environment=HOME=$RUN_HOME
ExecStart=$START_SCRIPT
ExecStop=$STOP_SCRIPT
# start-arbiter.sh waits for the AI Node (up to 3 min; up to 20 more if it
# has to rebuild its production bundle first) and the adapter.
TimeoutStartSec=30min
TimeoutStopSec=2min
SyslogIdentifier=$UNIT_NAME

[Install]
WantedBy=multi-user.target
EOF
}

container_policy() {
    docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$1" 2>/dev/null
}

# set_container_policies POLICY -> 0 when every existing container has it
set_container_policies() {
    local policy="$1" c rc=0 current
    for c in $CONTAINERS; do
        if ! docker inspect "$c" >/dev/null 2>&1; then
            say "  $c: ${YELLOW}container not found (created later by the installer with --restart unless-stopped)${NC}"
            continue
        fi
        current=$(container_policy "$c")
        if [ "$current" = "$policy" ]; then
            say "  $c: restart policy already ${GREEN}$policy${NC}"
        elif docker update --restart "$policy" "$c" >/dev/null 2>&1; then
            say "  $c: restart policy ${current:-no} -> ${GREEN}$policy${NC}"
        else
            warn "  $c: could not set --restart $policy (docker update failed)"
            rc=1
        fi
    done
    return $rc
}

############################################
# Actions
############################################
case "$ACTION" in
print-unit)
    unit_text
    exit 0
    ;;

status)
    rc=0
    for c in $CONTAINERS; do
        p=$(container_policy "$c")
        if [ -z "$p" ]; then
            say "  $c: ${YELLOW}container not found${NC}"
        elif [ "$p" = "unless-stopped" ] || [ "$p" = "always" ]; then
            say "  $c: restart policy ${GREEN}$p${NC}"
        else
            say "  $c: restart policy ${RED}${p:-no}${NC} (will not come back after a reboot)"
            rc=1
        fi
    done
    if ! have_systemd; then
        say "  $UNIT_NAME.service: ${YELLOW}systemd is not managing this host${NC}"
        exit 2
    fi
    enabled=$(systemctl is-enabled "$UNIT_NAME.service" 2>/dev/null)
    active=$(systemctl is-active "$UNIT_NAME.service" 2>/dev/null)
    case "$enabled" in
        enabled|static|alias)
            say "  $UNIT_NAME.service: ${GREEN}$enabled${NC} (state now: ${active:-unknown}; starts $START_SCRIPT at boot)" ;;
        "")
            say "  $UNIT_NAME.service: ${RED}not installed${NC} - the node will not start after a reboot (run: $INSTALL_DIR/arbiter-boot-service.sh enable)"
            rc=1 ;;
        *)
            say "  $UNIT_NAME.service: ${RED}$enabled${NC} - the node will not start after a reboot (run: $INSTALL_DIR/arbiter-boot-service.sh enable)"
            rc=1 ;;
    esac
    exit $rc
    ;;

enable)
    say "${BLUE}Making the arbiter in $INSTALL_DIR come back after a reboot...${NC}"
    for s in "$START_SCRIPT" "$STOP_SCRIPT"; do
        [ -x "$s" ] || { echo -e "${RED}$s is missing or not executable; is $INSTALL_DIR an arbiter install?${NC}" >&2; exit 64; }
    done

    say "${BLUE}Container restart policies:${NC}"
    set_container_policies unless-stopped || true

    if ! have_systemd; then
        warn "systemd is not managing this host: containers will restart, but the AI Node and"
        warn "External Adapter need your init system to run $START_SCRIPT at boot."
        exit 2
    fi

    say "${BLUE}systemd unit $UNIT_FILE (User=$RUN_USER):${NC}"
    tmp=$(mktemp) || exit 1
    trap 'rm -f "$tmp"' EXIT
    unit_text > "$tmp"
    as_root install -m 0644 "$tmp" "$UNIT_FILE"; rc=$?
    if [ "$rc" != "0" ]; then
        if [ "$rc" = "3" ]; then
            echo -e "${RED}Need root (or sudo) to install $UNIT_FILE.${NC}" >&2
            echo -e "${YELLOW}Run as root:  $INSTALL_DIR/arbiter-boot-service.sh enable --user $RUN_USER${NC}" >&2
            exit 3
        fi
        echo -e "${RED}Could not write $UNIT_FILE${NC}" >&2
        exit 1
    fi
    as_root systemctl daemon-reload || { echo -e "${RED}systemctl daemon-reload failed${NC}" >&2; exit 1; }
    if ! as_root systemctl enable "$UNIT_NAME.service" >/dev/null 2>&1; then
        echo -e "${RED}systemctl enable $UNIT_NAME.service failed${NC}" >&2
        exit 1
    fi
    say "${GREEN}Enabled: $UNIT_NAME.service runs $START_SCRIPT at boot (as $RUN_USER).${NC}"
    say "  Start now instead of waiting for a reboot: $START_SCRIPT  (or: sudo systemctl start $UNIT_NAME)"
    say "  Stop the node:                             $STOP_SCRIPT   (nothing restarts it until the next boot)"
    say "  Turn boot start off:                       $INSTALL_DIR/arbiter-boot-service.sh disable"
    exit 0
    ;;

disable)
    say "${BLUE}Turning off start-at-boot for the arbiter in $INSTALL_DIR...${NC}"
    rc=0
    if have_systemd; then
        if systemctl list-unit-files "$UNIT_NAME.service" 2>/dev/null | grep -q "^$UNIT_NAME.service"; then
            # disable, not --now: the node keeps running until stop-arbiter.sh.
            as_root systemctl disable "$UNIT_NAME.service" >/dev/null 2>&1 || rc=$?
            as_root rm -f "$UNIT_FILE" || rc=$?
            as_root systemctl daemon-reload || rc=$?
            if [ "$rc" = "3" ]; then
                echo -e "${RED}Need root (or sudo) to remove $UNIT_FILE.${NC}" >&2
                echo -e "${YELLOW}Run as root:  systemctl disable $UNIT_NAME && rm -f $UNIT_FILE && systemctl daemon-reload${NC}" >&2
                exit 3
            fi
            [ "$rc" = "0" ] && say "${GREEN}$UNIT_NAME.service disabled and removed.${NC}"
        else
            say "  $UNIT_NAME.service was not installed."
        fi
    else
        say "  systemd is not managing this host; no unit to remove."
    fi
    # Without the unit, containers that restart on their own would leave a
    # half-up node (chainlink taking requests, no adapter) after a reboot.
    say "${BLUE}Container restart policies:${NC}"
    set_container_policies no || rc=1
    say "The node now stays down after a reboot until someone runs $START_SCRIPT."
    exit $rc
    ;;
esac
