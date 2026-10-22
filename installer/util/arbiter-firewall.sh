#!/bin/bash
#
# Verdikta Arbiter - keep the database, operator UI and AI ports off the internet
#
# A port review (2026-10-21) found the Chainlink Postgres (5432), the Chainlink
# UI/API (6688), the AI Node (3000) and the External Adapter (8080) reachable
# from the internet on the hosts it checked (no host firewall, no provider
# firewall; the database under constant password guessing). The installer used
# to publish them on every interface. This tool closes them on the PUBLIC
# interface only:
#
#   DOCKER-USER  -i <nic> -p tcp -m conntrack --ctorigdstport 5432|6688 --ctdir ORIGINAL -j DROP
#                (Docker-published ports are DNAT'd and never reach INPUT)
#   INPUT        -i <nic> -p tcp -m multiport --dports 3000,8080 -j DROP
#   ip6tables    the same, INPUT for 3000,5432,6688,8080 (docker-proxy serves [::])
#
# <nic> is the default-route interface (`ip route get`, never hard-coded).
# Container -> host traffic arrives on docker0 / br-*, adapter -> AI Node on lo,
# so Chainlink -> Postgres, Chainlink -> adapter (the bridge URL is the host's
# own public IP) and adapter -> AI Node keep working. SSH is untouched.
#
# `enable` also marks the AI Node to bind 127.0.0.1 (ai-node/start.sh reads
# <install-dir>/.ai-node-loopback, so reboots and the boot unit honour it) and
# points the adapter's default AI_NODE_URL at 127.0.0.1; both apply from the
# next AI Node start. The rules persist through a systemd oneshot unit whose
# commands are plain iptables lines (nothing from the install directory runs
# as root).
#
# Usage (from the install directory; needs root or sudo):
#   arbiter-firewall.sh enable [--interface NIC]...  # rules now + unit enabled for boot
#   arbiter-firewall.sh disable                      # remove rules, unit and the AI Node marker
#   arbiter-firewall.sh status [--quiet]             # exit 0 configured, 1 not, 2 no systemd
#   arbiter-firewall.sh print-unit                   # the unit text
#   arbiter-firewall.sh check-bridge [--probe]       # does Chainlink reach the adapter through an address of this host?
#   any action with --print-rules                    # print the iptables commands, change nothing
#
# Options: --install-dir DIR   (default: this script's directory)
#          --interface NIC     (repeatable; default: detected default-route NIC
#                               plus the NICs of an installed unit. Add a private
#                               VPC NIC to close it too. To shrink the set: disable, then enable.)
#          --unit-name NAME    (default: verdikta-arbiter-firewall)
#          --ignore-bridge-check  enable even if a Chainlink bridge URL names an address that is not this host's
#
# Exit codes: 0 done / configured, 1 failed / not configured (status),
# 2 no systemd (enable: rules applied but will not survive a reboot; status:
# rules present but nothing persists them), 3 no root and no usable sudo,
# 4 iptables not installed, 64 misuse.
#
# Test hooks: VERDIKTA_SYSTEMD_UNIT_DIR overrides /etc/systemd/system (and counts
# as "systemd is present"; the tests stub systemctl, iptables, ip6tables, ip);
# VERDIKTA_FIREWALL_NO_SYSTEMD=1 pretends there is no systemd.
#

set -o pipefail
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

ACTION=""
INSTALL_DIR=""
UNIT_NAME="verdikta-arbiter-firewall"
QUIET=0
PRINT_RULES=0
PROBE=0
IGNORE_BRIDGE=0
USER_IFACES=""
UNIT_DIR="${VERDIKTA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

TAG="verdikta-arbiter-ports"          # iptables comment: makes the rules recognisable
DOCKER_PORTS="5432 6688"              # Docker-published (DNAT'd): matched in DOCKER-USER
INPUT_PORTS_V4="3000,8080"            # host processes: AI Node, External Adapter
INPUT_PORTS_V6="3000,5432,6688,8080"  # host processes and docker-proxy ([::])
MARKER_NAME=".ai-node-loopback"

usage() { sed -n '2,50p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        enable|disable|status|print-unit|check-bridge)
            [ -n "$ACTION" ] && { echo "only one action, please" >&2; exit 64; }
            ACTION="$1"; shift ;;
        --install-dir) shift; [ -z "${1:-}" ] && { echo "--install-dir needs a directory" >&2; exit 64; }; INSTALL_DIR="$1"; shift ;;
        --interface|-i) shift; [ -z "${1:-}" ] && { echo "--interface needs a NIC name" >&2; exit 64; }
            case "$1" in *[!A-Za-z0-9_.,-]*) echo "bad interface name: $1" >&2; exit 64 ;; esac
            USER_IFACES="$USER_IFACES $(echo "$1" | tr ',' ' ')"
            shift ;;
        --unit-name) shift; [ -z "${1:-}" ] && { echo "--unit-name needs a name" >&2; exit 64; }; UNIT_NAME="${1%.service}"; shift ;;
        --print-rules) PRINT_RULES=1; shift ;;
        --probe) PROBE=1; shift ;;
        --ignore-bridge-check) IGNORE_BRIDGE=1; shift ;;
        --quiet|-q) QUIET=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done
[ -z "$ACTION" ] && { usage >&2; exit 64; }
USER_IFACES="${USER_IFACES# }"

say()  { [ "$QUIET" = "1" ] || echo -e "$@"; }
warn() { echo -e "${YELLOW}$*${NC}" >&2; }

INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
INSTALL_DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" || { echo "install directory not found: $INSTALL_DIR" >&2; exit 64; }
UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"
MARKER="$INSTALL_DIR/$MARKER_NAME"

############################################
# systemd / privilege helpers
############################################
have_systemd() {
    [ "${VERDIKTA_FIREWALL_NO_SYSTEMD:-0}" = "1" ] && return 1    # test hook
    command -v systemctl >/dev/null 2>&1 || return 1
    [ -d /run/systemd/system ] || [ -n "${VERDIKTA_SYSTEMD_UNIT_DIR:-}" ]
}

# ensure_priv MODE: sets SUDO to the command prefix that runs things as root.
# MODE "prompt" may ask for a sudo password on a terminal (enable/disable);
# "quiet" never prompts (status: reading rules must not surprise anyone).
# Returns 1 when root is not available. Checked once, up front, so iptables'
# own exit codes are never confused with "no privilege".
SUDO=()
PRIV_OK=0
ensure_priv() {
    local mode="$1"
    if [ "$(id -u)" = "0" ]; then SUDO=(); PRIV_OK=1; return 0; fi
    command -v sudo >/dev/null 2>&1 || return 1
    if sudo -n true 2>/dev/null; then
        SUDO=(sudo -n); PRIV_OK=1; return 0
    fi
    if [ "$mode" = "prompt" ] && [ "${VERDIKTA_UNATTENDED:-0}" != "1" ] && [ -t 0 ]; then
        if sudo -v; then SUDO=(sudo); PRIV_OK=1; return 0; fi
    fi
    return 1
}
priv() {
    if [ "${#SUDO[@]}" -gt 0 ]; then "${SUDO[@]}" "$@"; else "$@"; fi
}

############################################
# Interfaces and rules
############################################
# detect_iface 4|6 -> the interface the default route leaves through.
detect_iface() {
    local target out
    if [ "$1" = "4" ]; then target="1.1.1.1"; else target="2606:4700:4700::1111"; fi
    command -v ip >/dev/null 2>&1 || return 1
    out=$(ip -"$1" route get "$target" 2>/dev/null) || return 1
    echo "$out" | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}'
}

IFACES4=""
IFACES6=""
resolve_ifaces() {
    if [ -n "$USER_IFACES" ]; then IFACES4="$USER_IFACES"; IFACES6="$USER_IFACES"; return 0; fi
    IFACES4=$(detect_iface 4)
    IFACES6=$(detect_iface 6)
    [ -z "$IFACES6" ] && IFACES6="$IFACES4"
    [ -z "$IFACES4" ] && IFACES4="$IFACES6"
    [ -n "$IFACES4" ]
}

# unit_ifaces: the interfaces the installed unit closes (enable --interface eth0
# --interface eth1 writes both), so `status` also checks a private/VPC NIC that
# was added on purpose and does not nag a host whose default NIC is covered.
unit_ifaces() {
    [ -r "$UNIT_FILE" ] || return 0
    sed -n "s/^ExecStart=.* -i \([A-Za-z0-9_.-][A-Za-z0-9_.-]*\) .*/\1/p" "$UNIT_FILE" | sort -u
}
add_unit_ifaces() {
    local n
    for n in $(unit_ifaces); do
        case " $IFACES4 " in *" $n "*) ;; *) IFACES4="$IFACES4 $n" ;; esac
        case " $IFACES6 " in *" $n "*) ;; *) IFACES6="$IFACES6 $n" ;; esac
    done
    IFACES4="${IFACES4# }"; IFACES6="${IFACES6# }"
}

# All candidate rules, one per line: tool|chain|nic|ports|iptables-spec
all_rules() {
    local ifc p
    for ifc in $IFACES4; do
        for p in $DOCKER_PORTS; do
            echo "iptables|DOCKER-USER|$ifc|$p|-i $ifc -p tcp -m conntrack --ctorigdstport $p --ctdir ORIGINAL -m comment --comment $TAG -j DROP"
        done
        echo "iptables|INPUT|$ifc|$INPUT_PORTS_V4|-i $ifc -p tcp -m multiport --dports $INPUT_PORTS_V4 -m comment --comment $TAG -j DROP"
    done
    for ifc in $IFACES6; do
        for p in $DOCKER_PORTS; do
            echo "ip6tables|DOCKER-USER|$ifc|$p|-i $ifc -p tcp -m conntrack --ctorigdstport $p --ctdir ORIGINAL -m comment --comment $TAG -j DROP"
        done
        echo "ip6tables|INPUT|$ifc|$INPUT_PORTS_V6|-i $ifc -p tcp -m multiport --dports $INPUT_PORTS_V6 -m comment --comment $TAG -j DROP"
    done
}

# tool_chain_usable TOOL CHAIN: the tool exists and the chain can be read
# (DOCKER-USER is missing when Docker is not running or uses nftables; ip6tables
# when the host has no IPv6 filtering). Needs privilege already set up.
tool_chain_usable() {
    command -v "$1" >/dev/null 2>&1 || return 1
    priv "$1" -w -S "$2" >/dev/null 2>&1
}

# container_for_port PORT -> the container that publishes it.
container_for_port() { case "$1" in 5432) echo cl-postgres ;; 6688) echo chainlink ;; esac; }

# published_public CONTAINER PORT -> 0 when Docker publishes the port on a
# non-loopback address. Plain docker, no root: the install user runs docker anyway.
published_public() {
    local a
    command -v docker >/dev/null 2>&1 || return 1
    for a in $(docker port "$1" "$2/tcp" 2>/dev/null); do
        case "$a" in 127.*|"[::1]"*|"::1"*) ;; *) return 0 ;; esac
    done
    return 1
}

# The Chainlink bridge (verdikta-ai) names the address the Chainlink container
# calls the adapter on. It is the host's OWN address on every install we know,
# so the call is local delivery arriving on a docker bridge and never touches the
# public interface. If it names an address that is NOT this host's (a DNS name
# through a load balancer, a NAT'd floating IP), the call leaves through the
# public NIC and comes back on it, and the INPUT drop for 8080 would cut
# Chainlink off from its adapter.
url_host() {
    local u="$1"
    u="${u#*://}"; u="${u%%/*}"; u="${u%%\?*}"; u="${u##*@}"
    case "$u" in
        \[*\]*) u="${u#\[}"; u="${u%%\]*}" ;;   # [v6]:port
        *) u="${u%:*}" ;;                       # host:port
    esac
    echo "$u"
}
# host_is_local HOST -> 0 local, 1 not local, 2 cannot tell
host_is_local() {
    local h="$1" locals a
    case "$h" in localhost|127.*|::1|host.docker.internal) return 0 ;; esac
    command -v getent >/dev/null 2>&1 && command -v ip >/dev/null 2>&1 || return 2
    locals=$(ip -o addr show 2>/dev/null | awk '{print $4}' | sed 's#/.*##')
    for a in $(getent ahosts "$h" 2>/dev/null | awk '{print $1}' | sort -u); do
        echo "$locals" | grep -qxF "$a" && return 0
    done
    return 1
}
# check_bridge PROBE(0|1) -> 0 fine, 1 a bridge host is not this machine's (or the probe failed), 2 could not check
check_bridge() {
    local urls url host base prc rc=0 hl
    command -v docker >/dev/null 2>&1 || { say "  bridge: docker not available; not checked"; return 2; }
    urls=$(docker exec cl-postgres psql -U postgres -d postgres -At -c "select url from bridge_types" 2>/dev/null)
    if [ -z "$urls" ]; then
        say "  bridge: could not read Chainlink's bridge URLs (cl-postgres not running, or no bridge yet); not checked"
        return 2
    fi
    while IFS= read -r url; do
        [ -z "$url" ] && continue
        host=$(url_host "$url")
        hl=0; host_is_local "$host" || hl=$?
        case "$hl" in
            0) say "  bridge $url: ${GREEN}$host is an address of this machine${NC}" ;;
            2) say "  bridge $url: ${YELLOW}cannot tell whether $host is local (getent/ip missing)${NC}"; continue ;;
            *) say "  bridge $url: ${RED}$host is NOT an address of this machine${NC}: Chainlink would call the adapter through the public interface, and the 8080 drop would cut it off"
               rc=1; continue ;;
        esac
        if [ "$1" = "1" ]; then
            base="${url%/evaluate}"
            prc=0
            docker exec chainlink sh -c 'if command -v curl >/dev/null 2>&1; then curl -fsS -m5 -o /dev/null "$1"; elif command -v wget >/dev/null 2>&1; then wget -q -T5 -O /dev/null "$1"; else exit 99; fi' _ "$base/version" >/dev/null 2>&1 || prc=$?
            case "$prc" in
                0)  say "  bridge probe: ${GREEN}chainlink reached $base/version${NC}" ;;
                99) say "  bridge probe: ${YELLOW}the chainlink image has neither curl nor wget; not probed${NC}" ;;
                *)  say "  bridge probe: ${RED}chainlink could NOT reach $base/version (exit $prc)${NC}"; rc=1 ;;
            esac
        fi
    done <<< "$urls"
    return $rc
}

print_rules() {
    local tool chain ifc ports spec verb="${1:--I}"
    echo "# Commands $ACTION runs (rules for a missing DOCKER-USER chain or ip6tables are skipped):"
    all_rules | while IFS='|' read -r tool chain ifc ports spec; do
        if [ "$verb" = "-I" ]; then
            echo "$tool -w -C $chain $spec || $tool -w -I $chain 1 $spec"
        else
            echo "$tool -w -D $chain $spec"
        fi
    done
}

############################################
# The systemd unit (plain iptables lines, idempotent, tolerant of n/a)
############################################
unit_exec_lines() {
    local tool chain ifc ports spec
    all_rules | while IFS='|' read -r tool chain ifc ports spec; do
        # "! tool -S chain" is true when the chain/tool is absent: skip the rule.
        echo "ExecStart=/bin/sh -c '! $tool -w -S $chain >/dev/null 2>&1 || $tool -w -C $chain $spec 2>/dev/null || $tool -w -I $chain 1 $spec'"
    done
    all_rules | while IFS='|' read -r tool chain ifc ports spec; do
        echo "ExecStop=-/bin/sh -c '$tool -w -D $chain $spec 2>/dev/null'"
    done
}

sandbox_after() {
    have_systemd || return 0
    if systemctl list-unit-files verdikta-sandbox.service 2>/dev/null | grep -q '^verdikta-sandbox.service'; then
        echo -n " verdikta-sandbox.service"
    fi
}

unit_text() {
    cat <<EOF
# Verdikta Arbiter - generated by arbiter-firewall.sh; re-run
# "$INSTALL_DIR/arbiter-firewall.sh enable" instead of editing.
#
# Closes the Chainlink Postgres (5432), Chainlink UI/API (6688), AI Node (3000)
# and External Adapter (8080) ports on the public interface(s):
# ${IFACES4:-none}. Traffic between the arbiter's own components arrives on
# docker0 / br-* / lo and is not touched. Every line is an idempotent iptables
# command; a missing DOCKER-USER chain or ip6tables is skipped. The sandbox
# manager only adds its own DOCKER-USER rules (never flushes the chain), so
# ordering after it is for tidiness, not correctness.
# "systemctl stop" removes the rules again.
[Unit]
Description=Verdikta Arbiter: close database, UI and AI ports on the public interface
Documentation=https://github.com/verdikta/verdikta-arbiter
After=network-online.target docker.service containerd.service$(sandbox_after)
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
$(unit_exec_lines)
SyslogIdentifier=$UNIT_NAME

[Install]
WantedBy=multi-user.target
EOF
}

############################################
# AI Node loopback marker + adapter URL
############################################
is_arbiter_install() { [ -d "$INSTALL_DIR/ai-node" ]; }

bind_ai_node_loopback() {
    local adapter_env="$INSTALL_DIR/external-adapter/.env" tmp url
    if ! is_arbiter_install; then
        say "  AI Node bind: ${YELLOW}$INSTALL_DIR has no ai-node/, not an arbiter install; left unchanged${NC}"
        return 0
    fi
    # The adapter must be able to reach a loopback-only AI Node: if its AI_NODE_URL
    # names any other address, leave the bind alone rather than break evaluations.
    if [ -f "$adapter_env" ]; then
        url=$(sed -n 's/^AI_NODE_URL=//p' "$adapter_env" | tail -1 | tr -d "\"' \r")
        case "$url" in
            ""|http://localhost|http://localhost:3000|http://localhost:3000/|http://127.0.0.1|http://127.0.0.1:3000|http://127.0.0.1:3000/) ;;
            *) warn "  AI Node bind left unchanged: external-adapter/.env has AI_NODE_URL=$url, which a loopback-only AI Node would not answer."
               warn "  Point it at http://127.0.0.1:3000 (or remove the line) and re-run: $INSTALL_DIR/arbiter-firewall.sh enable"
               return 0 ;;
        esac
    fi
    if [ ! -f "$MARKER" ]; then
        echo "AI Node binds 127.0.0.1 (set by arbiter-firewall.sh enable on $(date -u +%Y-%m-%dT%H:%M:%SZ); remove with: arbiter-firewall.sh disable)" > "$MARKER" 2>/dev/null \
            || { warn "  could not write $MARKER (AI Node bind unchanged)"; return 1; }
    fi
    # 127.0.0.1, not localhost: with a loopback-only listener, a resolver that
    # returns ::1 first must not matter. Only the installer's default is touched.
    if [ -f "$adapter_env" ] && grep -qE '^AI_NODE_URL=http://localhost:3000/?[[:space:]]*$' "$adapter_env"; then
        tmp=$(mktemp) || return 1
        sed -E 's|^AI_NODE_URL=http://localhost:3000/?[[:space:]]*$|AI_NODE_URL=http://127.0.0.1:3000|' "$adapter_env" > "$tmp" \
            && cat "$tmp" > "$adapter_env"
        rm -f "$tmp"
        say "  adapter: AI_NODE_URL -> http://127.0.0.1:3000 (takes effect when the adapter restarts)"
    fi
    say "  AI Node bind: ${GREEN}127.0.0.1${NC} from its next start (an upgrade restarts the arbiter anyway; otherwise: $INSTALL_DIR/stop-arbiter.sh && $INSTALL_DIR/start-arbiter.sh)"
}

release_ai_node_loopback() {
    if [ -f "$MARKER" ]; then
        rm -f "$MARKER"
        say "  AI Node bind: back to all interfaces from its next start"
    fi
}

############################################
# Rule application
############################################
# apply_rules: insert every applicable rule that is not there yet.
apply_rules() {
    local tool chain ifc ports spec rc=0 skipped=0 unprotected=0 rules c
    rules=$(all_rules)
    while IFS='|' read -r tool chain ifc ports spec; do
        [ -z "$tool" ] && continue
        if ! tool_chain_usable "$tool" "$chain"; then
            say "  $tool $chain ($ports on $ifc): ${YELLOW}skipped, $tool $chain not available here${NC}"
            skipped=$((skipped+1))
            c=$(container_for_port "$ports")
            if [ "$tool" = "iptables" ] && [ "$chain" = "DOCKER-USER" ] && [ -n "$c" ] && published_public "$c" "$ports"; then
                warn "  $ports is NOT protected: there is no iptables DOCKER-USER chain to hold the rule, but $c publishes it on a public address."
                unprotected=$((unprotected+1))
            fi
            continue
        fi
        # shellcheck disable=SC2086  # $spec is a word list on purpose
        if priv "$tool" -w -C "$chain" $spec >/dev/null 2>&1; then
            say "  $tool $chain ($ports on $ifc): already ${GREEN}closed${NC}"
        elif priv "$tool" -w -I "$chain" 1 $spec; then
            say "  $tool $chain ($ports on $ifc): ${GREEN}closed${NC}"
        else
            warn "  $tool $chain ($ports on $ifc): could not insert the rule"
            rc=1
        fi
    done <<< "$rules"
    APPLY_SKIPPED=$skipped
    APPLY_UNPROTECTED=$unprotected
    return $rc
}

# remove_rules: delete every rule carrying our comment tag, found by listing the
# chains (iptables -S), so it works without a default route and also cleans up
# rules left for a NIC that has since been renamed. Rules without the tag (for
# example ones typed in by hand) are never touched.
remove_rules() {
    local tool chain line spec rc=0 removed=0 listing
    for tool in iptables ip6tables; do
        command -v "$tool" >/dev/null 2>&1 || continue
        for chain in DOCKER-USER INPUT; do
            listing=$(priv "$tool" -w -S "$chain" 2>/dev/null | grep -- "--comment $TAG") || continue
            while IFS= read -r line; do
                [ -z "$line" ] && continue
                spec="${line#-A "$chain" }"
                spec="${spec//\"/}"
                # shellcheck disable=SC2086
                if priv "$tool" -w -D "$chain" $spec; then removed=$((removed+1)); else rc=1; fi
            done <<< "$listing"
        done
    done
    say "  removed $removed rule(s)"
    return $rc
}

need_iptables() {
    command -v iptables >/dev/null 2>&1 && return 0
    echo -e "${RED}iptables is not installed on this host; nothing to configure (install iptables or use your provider's firewall for 5432, 6688, 3000, 8080).${NC}" >&2
    exit 4
}

need_ifaces() {
    resolve_ifaces && return 0
    echo -e "${RED}Could not detect the public network interface (ip route get found no default route).${NC}" >&2
    echo -e "${YELLOW}Name it yourself:  $0 $ACTION --interface eth0${NC}" >&2
    exit 1
}

need_priv() {
    ensure_priv "$1" && return 0
    echo -e "${RED}Need root (or sudo) to change firewall rules.${NC}" >&2
    echo -e "${YELLOW}Run as root:  $INSTALL_DIR/arbiter-firewall.sh $ACTION${USER_IFACES:+ --interface ${USER_IFACES// / --interface }}${NC}" >&2
    exit 3
}

############################################
# Actions
############################################
case "$ACTION" in
print-unit)
    resolve_ifaces || IFACES4=""
    unit_text
    exit 0
    ;;

status)
    if [ "$PRINT_RULES" = "1" ]; then resolve_ifaces || true; ACTION=enable; print_rules -I; exit 0; fi
    need_iptables
    need_ifaces
    [ -z "$USER_IFACES" ] && add_unit_ifaces
    rc=0
    ensure_priv quiet || true
    if [ "$PRIV_OK" = "1" ]; then
        missing=0
        rules=$(all_rules)
        while IFS='|' read -r tool chain ifc ports spec; do
            [ -z "$tool" ] && continue
            if ! tool_chain_usable "$tool" "$chain"; then
                c=$(container_for_port "$ports")
                if [ "$tool" = "iptables" ] && [ "$chain" = "DOCKER-USER" ] && [ -n "$c" ] && published_public "$c" "$ports"; then
                    # No chain to hold the rule (Docker started later, or on nftables), yet the port is published publicly.
                    say "  $tool $chain ($ports on $ifc): ${RED}OPEN${NC} (no DOCKER-USER chain, but $c publishes $ports on a public address)"
                    missing=$((missing+1))
                else
                    say "  $tool $chain ($ports on $ifc): ${YELLOW}n/a ($tool $chain not available here)${NC}"
                fi
                continue
            fi
            # shellcheck disable=SC2086
            if priv "$tool" -w -C "$chain" $spec >/dev/null 2>&1; then
                say "  $tool $chain ($ports on $ifc): ${GREEN}closed${NC}"
            else
                say "  $tool $chain ($ports on $ifc): ${RED}OPEN${NC} (no DROP rule)"
                missing=$((missing+1))
            fi
        done <<< "$rules"
        [ "$missing" -gt 0 ] && rc=1
    else
        say "  rules: ${YELLOW}not verified${NC} (reading iptables needs root or passwordless sudo); trusting the unit state"
    fi

    if [ -f "$MARKER" ]; then
        say "  AI Node bind: ${GREEN}127.0.0.1${NC} (marker $MARKER)"
    elif is_arbiter_install; then
        say "  AI Node bind: ${YELLOW}all interfaces${NC} (arbiter-firewall.sh enable switches it to 127.0.0.1)"
    fi

    if ! have_systemd; then
        say "  $UNIT_NAME.service: ${YELLOW}systemd is not managing this host${NC}; the rules do not survive a reboot"
        [ "$rc" = "0" ] && rc=2
        exit $rc
    fi
    enabled=$(systemctl is-enabled "$UNIT_NAME.service" 2>/dev/null)
    active=$(systemctl is-active "$UNIT_NAME.service" 2>/dev/null)
    case "$enabled" in
        enabled|static|alias)
            if [ "$PRIV_OK" != "1" ] && [ "$active" != "active" ]; then
                # Rules could not be read (no root): an enabled unit that is not active
                # (failed at boot, or stopped) is the only evidence there is, and it says "open".
                say "  $UNIT_NAME.service: ${RED}$enabled but ${active:-unknown}${NC} - it did not apply the rules (journalctl -u $UNIT_NAME)"
                rc=1
            else
                say "  $UNIT_NAME.service: ${GREEN}$enabled${NC} (state now: ${active:-unknown}; re-applies the rules at boot)"
            fi ;;
        "")
            say "  $UNIT_NAME.service: ${RED}not installed${NC} - the rules are gone after a reboot (run: $INSTALL_DIR/arbiter-firewall.sh enable)"
            rc=1 ;;
        *)
            say "  $UNIT_NAME.service: ${RED}$enabled${NC} - the rules are gone after a reboot (run: $INSTALL_DIR/arbiter-firewall.sh enable)"
            rc=1 ;;
    esac
    exit $rc
    ;;

enable)
    if [ "$PRINT_RULES" = "1" ]; then resolve_ifaces || true; print_rules -I; exit 0; fi
    need_iptables
    need_ifaces
    if [ -z "$USER_IFACES" ]; then
        before="$IFACES4"; add_unit_ifaces
        [ "$before" != "$IFACES4" ] && say "  keeping the interface(s) of the installed unit: $IFACES4 (to change the set: disable, then enable --interface ...)"
    fi
    say "${BLUE}Closing ports 5432, 6688, 3000 and 8080 on: ${IFACES4}${NC}"
    need_priv prompt
    if [ "$IGNORE_BRIDGE" != "1" ]; then
        bridge_rc=0
        check_bridge 0 || bridge_rc=$?
        if [ "$bridge_rc" = "1" ]; then
            echo -e "${RED}Not closing the ports: Chainlink's bridge URL names an address that is not this machine's (above).${NC}" >&2
            echo -e "${YELLOW}Point the bridge at this host's own address (Chainlink UI > Bridges), or override with: $INSTALL_DIR/arbiter-firewall.sh enable --ignore-bridge-check${NC}" >&2
            exit 1
        fi
    fi
    apply_rules || { echo -e "${RED}Some rules could not be inserted; see above.${NC}" >&2; exit 1; }
    if [ "$APPLY_SKIPPED" -gt 0 ]; then
        warn "Some rules were skipped (DOCKER-USER missing: Docker not running or using nftables? ip6tables missing?)."
        warn "If Docker was stopped, start it and re-run: $INSTALL_DIR/arbiter-firewall.sh enable"
    fi

    bind_ai_node_loopback

    if ! have_systemd; then
        warn "systemd is not managing this host: the rules are active now but a reboot removes them."
        warn "Run  $INSTALL_DIR/arbiter-firewall.sh enable  from your init system at boot (it is idempotent)."
        [ "${APPLY_UNPROTECTED:-0}" -gt 0 ] && exit 1
        exit 2
    fi
    say "${BLUE}systemd unit $UNIT_FILE:${NC}"
    tmp=$(mktemp) || exit 1
    trap 'rm -f "$tmp"' EXIT
    unit_text > "$tmp"
    priv install -m 0644 "$tmp" "$UNIT_FILE" || { echo -e "${RED}Could not write $UNIT_FILE${NC}" >&2; exit 1; }
    priv systemctl daemon-reload || { echo -e "${RED}systemctl daemon-reload failed${NC}" >&2; exit 1; }
    # --now: the unit becomes active, so "systemctl stop" removes the rules.
    if ! priv systemctl enable --now "$UNIT_NAME.service" >/dev/null 2>&1; then
        echo -e "${RED}systemctl enable --now $UNIT_NAME.service failed${NC}" >&2
        exit 1
    fi
    say "${GREEN}Enabled: $UNIT_NAME.service re-applies the rules at every boot.${NC}"
    say "  Public access to 5432 / 6688 / 3000 / 8080 is closed on ${IFACES4}. The arbiter's own traffic is unaffected."
    say "  Chainlink UI from your machine:  ssh -L 6688:127.0.0.1:6688 <user>@<this-host>   then open http://localhost:6688"
    say "  Undo:                            $INSTALL_DIR/arbiter-firewall.sh disable"
    if [ "${APPLY_UNPROTECTED:-0}" -gt 0 ]; then
        echo -e "${RED}But ${APPLY_UNPROTECTED} published port(s) above are NOT protected (no DOCKER-USER chain). Start Docker and re-run enable, or close them in your provider's firewall.${NC}" >&2
        exit 1
    fi
    exit 0
    ;;

check-bridge)
    check_bridge "$PROBE"
    exit $?
    ;;

disable)
    if [ "$PRINT_RULES" = "1" ]; then resolve_ifaces || true; print_rules -D; exit 0; fi
    say "${BLUE}Reopening ports 5432, 6688, 3000 and 8080 (removing every rule tagged $TAG)...${NC}"
    need_priv prompt
    rc=0
    if have_systemd && systemctl list-unit-files "$UNIT_NAME.service" 2>/dev/null | grep -q "^$UNIT_NAME.service"; then
        # disable --now runs ExecStop (removes the rules); remove_rules below
        # also catches rules that were applied without the unit.
        priv systemctl disable --now "$UNIT_NAME.service" >/dev/null 2>&1 || true
        priv rm -f "$UNIT_FILE" || rc=1
        priv systemctl daemon-reload || rc=1
        say "  $UNIT_NAME.service disabled and removed"
    fi
    remove_rules || rc=1
    release_ai_node_loopback
    if [ "$rc" = "0" ]; then
        say "${GREEN}Firewall rules removed. The ports are open to the internet again.${NC}"
    else
        echo -e "${RED}Some steps failed; check: iptables -S | grep $TAG${NC}" >&2
    fi
    exit $rc
    ;;
esac
