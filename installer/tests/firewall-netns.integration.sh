#!/bin/bash
# Real-kernel check of arbiter-firewall.sh (opt-in: needs Docker, runs a
# privileged throwaway Ubuntu container; not part of the *.test.sh run).
#
# Four network namespaces stand in for the arbiter host's world:
#   ext   the internet          10.9.0.2 / fd00:9::2   (client of the public NIC)
#   host  the container's own   pub0 10.9.0.1 / fd00:9::1   = the PUBLIC interface
#         namespace             br0  10.8.0.1               = br-* (verdikta-network)
#                               br1  10.7.0.1               = docker0 (the default bridge)
#   ctr   the chainlink         10.8.0.2   on br0: serves 6688, is the Chainlink-like
#         container                        client of Postgres and of the adapter
#   pg    cl-postgres           10.7.0.2   on br1: serves 5432
# with Docker's own plumbing recreated by hand: a DOCKER-USER chain jumped to
# from FORWARD, DNAT of the published ports (5432 -> pg with `! -i br1`, 6688 ->
# ctr with `! -i br0`, as Docker writes them) and MASQUERADE for container egress.
# Chainlink reaches Postgres exactly as on a real host: container on br0 ->
# host-gateway address on docker0 (10.7.0.1:5432) -> DNAT -> forwarded br0 -> br1.
#
# Asserts, with the real iptables binary and real packets:
#   before: ext reaches 5432/6688 (DNAT'd to the container) and 3000/8080 (host)
#   after `enable`: none of the four is reachable from ext over IPv4 or IPv6,
#                   SSH-like port 22 still is; the Chainlink-like container still
#                   reaches Postgres through the host-gateway address and the
#                   adapter / AI Node through the host's PUBLIC address (the
#                   bridge URL), the host still reaches its own 3000 over lo, and
#                   a container reaching an
#                   EXTERNAL port 5432 still gets its replies back (--ctdir ORIGINAL;
#                   the audit's bare --ctorigdstport rule would drop them)
#   second enable adds nothing; the unit's ExecStart lines are idempotent;
#   `disable` reopens everything.
#
# Run: bash installer/tests/firewall-netns.integration.sh [ubuntu:24.04|ubuntu:20.04]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${FIREWALL_TEST_REPO:-$(cd "$HERE/../.." && pwd)}"

if [ "${1:-}" != "--inside" ]; then
    IMAGE="${1:-ubuntu:24.04}"
    command -v docker >/dev/null 2>&1 || { echo "docker not available; skipping"; exit 0; }
    exec docker run --rm --privileged -v "$REPO:/repo:ro" "$IMAGE" bash /repo/installer/tests/firewall-netns.integration.sh --inside
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq iptables iproute2 python3 >/dev/null 2>&1 || { echo "apt-get install failed"; exit 1; }
echo "iptables: $(iptables --version)"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
expect_open()   { if probe "$@"; then ok "reachable:     $LABEL"; else bad "should be reachable: $LABEL"; fi; }
expect_closed() { if probe "$@"; then bad "should be blocked:   $LABEL"; else ok "blocked:       $LABEL"; fi; }

# probe NETNS|host ADDR PORT -> 0 when a TCP connect succeeds within 2 s
probe() {
    local ns="$1" addr="$2" port="$3" pre=()
    LABEL="$ns -> $addr:$port"
    [ "$ns" != "host" ] && pre=(ip netns exec "$ns")
    "${pre[@]}" python3 -c 'import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 2).close()' "$addr" "$port" 2>/dev/null
}
# listen NETNS|host PORT [ADDR]: a daemon that accepts and closes
listen() {
    local ns="$1" port="$2" addr="${3:-0.0.0.0}" pre=()
    [ "$ns" != "host" ] && pre=(ip netns exec "$ns")
    "${pre[@]}" python3 -c '
import socket, sys
fam = socket.AF_INET6 if ":" in sys.argv[2] else socket.AF_INET
s = socket.socket(fam, socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if fam == socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
s.bind((sys.argv[2], int(sys.argv[1]))); s.listen(16)
while True:
    c, _ = s.accept(); c.close()' "$port" "$addr" &
}

# ── topology ────────────────────────────────────────────────────────────────
ip netns add ext; ip netns add ctr; ip netns add pg
ip link add pub0 type veth peer name ext0; ip link set ext0 netns ext
ip link add br0 type veth peer name c0;   ip link set c0 netns ctr
ip link add br1 type veth peer name p0;   ip link set p0 netns pg
ip addr add 10.9.0.1/24 dev pub0; ip addr add fd00:9::1/64 dev pub0 nodad; ip link set pub0 up
ip addr add 10.8.0.1/24 dev br0;  ip link set br0 up
ip addr add 10.7.0.1/24 dev br1;  ip link set br1 up
ip -n ext addr add 10.9.0.2/24 dev ext0; ip -n ext addr add fd00:9::2/64 dev ext0 nodad
ip -n ext link set ext0 up; ip -n ext link set lo up
ip -n ctr addr add 10.8.0.2/24 dev c0; ip -n ctr link set c0 up; ip -n ctr link set lo up
ip -n ctr route add default via 10.8.0.1
ip -n pg addr add 10.7.0.2/24 dev p0; ip -n pg link set p0 up; ip -n pg link set lo up
ip -n pg route add default via 10.7.0.1
sysctl -qw net.ipv4.ip_forward=1
sysctl -qw net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0 2>/dev/null

# Docker's plumbing, as dockerd writes it.
iptables -N DOCKER-USER; iptables -A DOCKER-USER -j RETURN
iptables -I FORWARD -j DOCKER-USER
# Docker's DOCKER chain is reached with `-m addrtype --dst-type LOCAL`: only traffic
# addressed to the host itself is DNAT'd, never a container's outbound connection.
iptables -t nat -A PREROUTING -m addrtype --dst-type LOCAL -p tcp ! -i br1 --dport 5432 -j DNAT --to-destination 10.7.0.2:5432
iptables -t nat -A PREROUTING -m addrtype --dst-type LOCAL -p tcp ! -i br0 --dport 6688 -j DNAT --to-destination 10.8.0.2:6688
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 ! -o br0 -j MASQUERADE
iptables -t nat -A POSTROUTING -s 10.7.0.0/24 ! -o br1 -j MASQUERADE
ip6tables -N DOCKER-USER 2>/dev/null; ip6tables -A DOCKER-USER -j RETURN 2>/dev/null; ip6tables -I FORWARD -j DOCKER-USER 2>/dev/null

# Listeners: the container (cl-postgres, chainlink), the host processes, SSH-like 22,
# and an "external service" on 5432 for the reply-direction check.
listen pg 5432; listen ctr 6688
listen host 3000; listen host 8080; listen host 22
listen host 8080 ::; listen host 3000 :: 2>/dev/null
listen ext 5432
sleep 1

# ── before ──────────────────────────────────────────────────────────────────
echo "== before enable: everything is open (the audit's finding)"
for p in 5432 6688 3000 8080 22; do probe ext 10.9.0.1 $p && ok "reachable:     ext -> 10.9.0.1:$p" || bad "ext -> 10.9.0.1:$p should be open before"; done
probe ext fd00:9::1 8080 && ok "reachable:     ext -> [fd00:9::1]:8080" || bad "v6 8080 should be open before"
echo "== the legitimate paths work before too (so a later failure is the rules' doing)"
expect_open   ctr 10.7.0.1 5432          # Chainlink -> host-gateway (docker0) -> DNAT -> Postgres
expect_open   ctr 10.9.0.1 8080          # Chainlink -> adapter through the host's PUBLIC address (the bridge URL)

# ── enable ──────────────────────────────────────────────────────────────────
mkdir -p /tmp/inst/ai-node; cp "$REPO/installer/util/arbiter-firewall.sh" /tmp/inst/; chmod +x /tmp/inst/arbiter-firewall.sh
echo "== default-route detection on real iproute2 output"
detected=$(bash /tmp/inst/arbiter-firewall.sh print-unit | grep -m1 'ExecStart=' | sed -E 's/.* -i ([^ ]+) .*/\1/')
default_dev=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
[ -n "$detected" ] && [ "$detected" = "$default_dev" ] && ok "detected NIC '$detected' = default-route NIC" || bad "detected '$detected' vs default route '$default_dev'"

echo "== enable --interface pub0 (no systemd in the container: exit 2 after applying)"
VERDIKTA_UNATTENDED=1 bash /tmp/inst/arbiter-firewall.sh enable --interface pub0 --install-dir /tmp/inst; rc=$?
[ "$rc" = 2 ] && ok "enable applied the rules, exit 2 (no systemd)" || bad "enable exit $rc, expected 2"
echo "== after enable"
for p in 5432 6688 3000 8080; do expect_closed ext 10.9.0.1 $p; done
expect_closed ext fd00:9::1 8080
expect_closed ext fd00:9::1 3000
expect_open   ext 10.9.0.1 22
echo "== the arbiter's own traffic keeps working"
expect_open   ctr 10.7.0.1 5432          # Chainlink -> Postgres: host-gateway address, DNAT'd, forwarded br0 -> br1
expect_open   ctr 10.9.0.1 8080          # Chainlink -> adapter via the host's public address: local delivery arriving on br0
expect_open   ctr 10.9.0.1 3000
expect_open   ctr 10.8.0.1 8080          # ... and via the bridge address
expect_open   host 127.0.0.1 3000        # adapter -> AI Node over lo
expect_open   host ::1 8080
echo "== reply direction: a container reaching an external service on 5432"
expect_open   ctr 10.9.0.2 5432
echo "   (the audit's bare rule, for contrast)"
iptables -I DOCKER-USER 1 -i pub0 -p tcp -m conntrack --ctorigdstport 5432 -j DROP
probe ctr 10.9.0.2 5432 && bad "the bare --ctorigdstport rule should drop the replies (the contrast is not demonstrating anything)" || ok "bare --ctorigdstport rule WOULD drop the replies; ours does not"
iptables -D DOCKER-USER -i pub0 -p tcp -m conntrack --ctorigdstport 5432 -j DROP
expect_open   ctr 10.9.0.2 5432

echo "== idempotency"
before=$(iptables -S | grep -c verdikta-arbiter-ports); before6=$(ip6tables -S | grep -c verdikta-arbiter-ports)
VERDIKTA_UNATTENDED=1 bash /tmp/inst/arbiter-firewall.sh enable --interface pub0 --install-dir /tmp/inst >/dev/null; rc=$?
after=$(iptables -S | grep -c verdikta-arbiter-ports); after6=$(ip6tables -S | grep -c verdikta-arbiter-ports)
[ "$before" = 3 ] && [ "$before" = "$after" ] && [ "$before6" = "$after6" ] && ok "second enable added nothing (v4 $before, v6 $before6 tagged rules)" || bad "rule counts $before/$after, v6 $before6/$after6"
echo "== the systemd unit's ExecStart lines, run as sh -c, twice"
bash /tmp/inst/arbiter-firewall.sh print-unit --interface pub0 | grep '^ExecStart=' | sed 's/^ExecStart=//' > /tmp/exec.lines
while IFS= read -r l; do eval "$l" || bad "unit line failed: $l"; done < /tmp/exec.lines
while IFS= read -r l; do eval "$l" || bad "unit line failed (2nd run): $l"; done < /tmp/exec.lines
[ "$(iptables -S | grep -c verdikta-arbiter-ports)" = "$before" ] && ok "unit lines are idempotent ($(wc -l < /tmp/exec.lines) lines)" || bad "unit lines duplicated rules"
echo "== iptables -S of the result"
iptables -S DOCKER-USER; iptables -S INPUT | grep verdikta; ip6tables -S INPUT | grep verdikta

# ── disable ─────────────────────────────────────────────────────────────────
echo "== disable"
VERDIKTA_UNATTENDED=1 bash /tmp/inst/arbiter-firewall.sh disable --install-dir /tmp/inst >/dev/null; rc=$?
[ "$rc" = 0 ] && ok "disable exit 0" || bad "disable exit $rc"
[ "$(iptables -S | grep -c verdikta-arbiter-ports)" = 0 ] && [ "$(ip6tables -S | grep -c verdikta-arbiter-ports)" = 0 ] && ok "no tagged rules left" || bad "tagged rules left"
iptables -S DOCKER-USER | grep -q -- '-j RETURN' && ok "Docker's own DOCKER-USER rule untouched" || bad "DOCKER-USER RETURN rule gone"
for p in 5432 6688 3000 8080; do expect_open ext 10.9.0.1 $p; done

echo "pass=$pass fail=$fail"; [ "$fail" = 0 ]
