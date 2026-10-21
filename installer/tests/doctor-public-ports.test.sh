#!/bin/bash
# arbiter-doctor.sh svc.public_ports (2026-10-21 port review: 5432, 6688, 3000
# and 8080 were reachable from the internet on the hosts it checked). The doctor WARNs
# when services bind public addresses and arbiter-firewall.sh's rules are not in
# place, PASSes when they are, and says what it checked: a host cannot
# truthfully test its own external reachability, so it looks at bind addresses
# and rules and tells the operator to confirm from another machine.
# Runs the doctor's REAL check_public_ports (and helpers) against stub ss /
# docker / arbiter-firewall.sh.
# Run: bash installer/tests/doctor-public-ports.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fns=$(awk '/^# listen_addrs PORT/{p=1} /^check_services\(\) \{/{p=0} p{print}' "$DOCTOR")
[ -n "$fns" ] && ok || bad "could not extract check_public_ports from $DOCTOR"
grep -q '^    check_public_ports$' "$DOCTOR" && ok || bad "check_services does not call check_public_ports"

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/install"
# ss: listeners come from $FW_SS (one "Local" column entry per line).
cat > "$T/bin/ss" <<'EOF'
#!/bin/bash
while read -r a; do [ -n "$a" ] && echo "LISTEN 0 511 $a 0.0.0.0:*"; done <<< "$FW_SS"
EOF
# docker port NAME PORT/tcp: $FW_PG for cl-postgres, $FW_CL for chainlink.
cat > "$T/bin/docker" <<'EOF'
#!/bin/bash
[ "$1" = "port" ] || exit 0
case "$2" in
  cl-postgres) printf '%s' "${FW_PG:-}" ;;
  chainlink) printf '%s' "${FW_CL:-}" ;;
esac
exit 0
EOF
chmod +x "$T/bin"/*
write_fw() {  # status exit code
    printf '#!/bin/bash\n[ "$1" = status ] && exit %s\nexit 99\n' "$1" > "$T/install/arbiter-firewall.sh"
    chmod +x "$T/install/arbiter-firewall.sh"
}

# check SS PG CL -> "<SEV> <id> <msg> | <hint>"; CAN_READ=0 makes the doctor think it
# cannot read iptables (no root, no passwordless sudo); the default says it can.
check() {
    FW_SS="$1" FW_PG="$2" FW_CL="$3" PATH="$T/bin:$PATH" INSTALL_DIR="$T/install" CAN_READ="${CAN_READ:-1}" bash -c '
        emit() { printf "%s %s %s | %s\n" "$1" "$2" "$3" "${4:-}"; }
        eval "$1"
        doctor_can_read_rules() { [ "$CAN_READ" = "1" ]; }
        check_public_ports
    ' _ "$fns" 2>&1
}

OLD_SS=$'0.0.0.0:3000\n*:8080\n0.0.0.0:22'          # an old install: AI Node and adapter on every interface
OLD_PG=$'0.0.0.0:5432\n[::]:5432'
OLD_CL=$'0.0.0.0:6688\n[::]:6688'
NEW_SS=$'127.0.0.1:3000\n*:8080\n0.0.0.0:22'        # a fresh install: loopback AI Node, adapter public by design
NEW_CL='127.0.0.1:6688'

# 1. An old install, no firewall: WARN naming all four ports and the command to run.
write_fw 1
out=$(check "$OLD_SS" "$OLD_PG" "$OLD_CL")
has   "old, no firewall: severity" "$out" "^WARN svc.public_ports"
has   "old, no firewall: ports"    "$out" "port(s) 5432, 6688, 3000, 8080 listen on public addresses"
has   "old, no firewall: hint"     "$out" "| Run (as root): $T/install/arbiter-firewall.sh enable"
has   "old, no firewall: tunnel"   "$out" "ssh -L 6688:127.0.0.1:6688"
has   "says what it checked"       "$out" "a host cannot test its own external reachability"
has   "tells how to confirm"       "$out" "nc -z -w5 <public-ip> <port>"

# 2. A fresh install, no firewall: only the adapter is left, and it is named.
out=$(check "$NEW_SS" "" "$NEW_CL")
has   "fresh, no firewall: WARN"   "$out" "^WARN svc.public_ports"
has   "fresh, no firewall: only 8080" "$out" "port(s) 8080 listen on public addresses"
hasnt "fresh: 5432 not named"      "$out" "5432"
hasnt "fresh: 6688 not named"      "$out" "6688,"

# 3. Firewall configured (status 0): PASS, still lists what is bound publicly.
write_fw 0
out=$(check "$OLD_SS" "$OLD_PG" "$OLD_CL")
has   "firewalled: PASS"           "$out" "^PASS svc.public_ports 5432/6688/3000/8080 are dropped on the public interface"
has   "firewalled: bound list"     "$out" "still bound on public addresses: 5432, 6688, 3000, 8080"
has   "firewalled: caveat"         "$out" "a host cannot test its own external reachability"
hasnt "firewalled: no WARN"        "$out" "^WARN"

# 3b. Same status 0 but the user could not read the rules: PASS must say so.
out=$(CAN_READ=0 check "$OLD_SS" "$OLD_PG" "$OLD_CL")
has   "unread rules: PASS"         "$out" "^PASS svc.public_ports"
has   "unread rules: caveat"       "$out" "The rules themselves were not read (that needs root)"
out=$(check "$OLD_SS" "$OLD_PG" "$OLD_CL")
hasnt "readable rules: no caveat"  "$out" "were not read"

# 4. Rules active but not persistent (status 2): WARN about the reboot.
write_fw 2
out=$(check "$NEW_SS" "" "$NEW_CL")
has   "no systemd: WARN"           "$out" "^WARN svc.public_ports .*nothing re-applies them after a reboot"

# 5. No iptables (status 4): WARN pointing at the provider firewall; PASS if nothing is public.
write_fw 4
out=$(check "$OLD_SS" "$OLD_PG" "$OLD_CL")
has   "no iptables: WARN"          "$out" "^WARN svc.public_ports .*iptables is not installed"
has   "no iptables: hint"          "$out" "provider's firewall"
out=$(check "127.0.0.1:3000" "" "$NEW_CL")
has   "no iptables, nothing public: PASS" "$out" "^PASS svc.public_ports no service listens on a public address"

# 6. arbiter-firewall.sh absent (an old install): WARN with the upgrade hint.
rm -f "$T/install/arbiter-firewall.sh"
out=$(check "$OLD_SS" "$OLD_PG" "$OLD_CL")
has   "script absent: WARN"        "$out" "arbiter-firewall.sh is not installed"
has   "script absent: hint"        "$out" "Run upgrade-arbiter.sh"

# 7. Address classification: loopback v4/v6 are private, wildcard v4/v6 are public.
write_fw 1
for a in "127.0.0.1:3000" "[::1]:3000"; do
    out=$(check "$a"$'\n127.0.0.1:8080' "" "$NEW_CL")
    hasnt "loopback $a is not exposed" "$out" "3000"
done
for a in "[::]:3000" "0.0.0.0:3000" "*:3000" "10.0.0.5:3000"; do
    out=$(check "$a" "" "$NEW_CL")
    has   "$a is exposed" "$out" "port(s) 3000 listen on public addresses"
done
# Docker not published at all (unpublished database) is not exposed.
out=$(check "127.0.0.1:3000" "" "$NEW_CL")
hasnt "unpublished 5432"           "$out" "5432"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
