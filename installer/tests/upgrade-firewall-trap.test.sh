#!/bin/bash
# upgrade-arbiter.sh offers to close ports 5432/6688/3000/8080 on the public
# interface (2026-10-21 port audit) through arbiter-firewall.sh. Like the
# start-at-boot block (#97) it runs under `set -e` with `trap cleanup_on_error
# ERR`, and `arbiter-firewall.sh status --quiet` exits 1 on every install that
# still needs the fix, so the exit codes must be read with `|| rc=$?`. This test
# runs the script's REAL block under the real trap semantics against a stub
# arbiter-firewall.sh and checks that it survives every exit code, asks with the
# right defaults (interactive: yes; UNATTENDED: no unless
# VA_UPGRADE_HARDEN_PORTS=y, so an unattended upgrade never changes networking
# silently), and tells the operator how to undo it.
# Run: bash installer/tests/upgrade-firewall-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

# The block, from its comment header to the line before the next section.
block=$(awk '/^# Close the database \/ UI \/ AI ports on the public interface/{p=1} /^# Optional: Fund or top-off Chainlink keys/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the port-hardening block from $S"
echo "$block" | grep -q 'arbiter-firewall.sh" status --quiet' && ok || bad "block does not read status --quiet"
echo "$block" | grep -q 'arbiter-firewall.sh" enable' && ok || bad "block does not call enable"
grep -qE '^    arbiter-firewall.sh( \\|; do)$' "$S" && ok || bad "arbiter-firewall.sh is not in the _util copy loop"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
# Stub: `status --quiet` exits with $STATUS_RC, `enable` with $ENABLE_RC.
cat > "$T/install/arbiter-firewall.sh" <<'STUB'
#!/bin/bash
case "$1" in
  status) exit "${STATUS_RC:-1}" ;;
  enable) echo "STUB-ENABLE-CALLED"; exit "${ENABLE_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/install/arbiter-firewall.sh"

# run STATUS_RC ENABLE_RC UNATTENDED(1|0) [ANSWER] [VA_UPGRADE_HARDEN_PORTS]
# — the block, exactly as the script runs it: errexit on, the ERR trap armed.
# Interactive runs get the answer on stdin (empty = just Enter).
run() {
    local answer="${4-}" key="${5:-}"
    printf '%s\n' "$answer" | \
    STATUS_RC="$1" ENABLE_RC="$2" VERDIKTA_UNATTENDED="$3" VA_UPGRADE_HARDEN_PORTS="$key" TARGET_DIR="$T/install" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        [ -z "$VA_UPGRADE_HARDEN_PORTS" ] && unset VA_UPGRADE_HARDEN_PORTS
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "PORTS_HARDENED=${PORTS_HARDENED:-0}"
        echo "REACHED-END"
    ' _ "$ROOT" "$block" 2>&1
    echo "rc=$?"
}

# 1. Unattended, not configured (status 1), no VA_UPGRADE_HARDEN_PORTS: the
#    networking is NOT changed. This is the default for every unattended upgrade.
out=$(run 1 0 1)
hasnt "unattended default: enable"   "$out" "STUB-ENABLE-CALLED"
has   "unattended default: explains" "$out" "ssh -L 6688:127.0.0.1:6688"
has   "unattended default: key named" "$out" "VA_UPGRADE_HARDEN_PORTS=y"
has   "unattended default: answered no" "$out" "(y/n): n  \[unattended: VA_UPGRADE_HARDEN_PORTS\]"
has   "unattended default: later hint" "$out" "Close the ports later with:.*arbiter-firewall.sh enable"
has   "unattended default: not hardened" "$out" "PORTS_HARDENED=0"
has   "unattended default: finished" "$out" "REACHED-END"
hasnt "unattended default: trap"     "$out" "TRAP-FIRED"
has   "unattended default: exit 0"   "$out" "rc=0"

# 2. Unattended with VA_UPGRADE_HARDEN_PORTS=y: enable runs, the undo command is printed.
out=$(run 1 0 1 "" y)
has   "opted in: enable called"  "$out" "STUB-ENABLE-CALLED"
has   "opted in: hardened"       "$out" "PORTS_HARDENED=1"
has   "opted in: undo command"   "$out" "Turn it off again with: .*arbiter-firewall.sh disable"
has   "opted in: finished"       "$out" "REACHED-END"
hasnt "opted in: trap"           "$out" "TRAP-FIRED"
# ... and an explicit n stays n.
out=$(run 1 0 1 "" n)
hasnt "opted out: enable"        "$out" "STUB-ENABLE-CALLED"
has   "opted out: finished"      "$out" "REACHED-END"

# 3. Interactive: Enter takes the default (yes); n declines.
out=$(run 1 0 0 "")
has   "interactive Enter: enable called" "$out" "STUB-ENABLE-CALLED"
has   "interactive Enter: hardened"      "$out" "PORTS_HARDENED=1"
out=$(run 1 0 0 "n")
hasnt "interactive n: enable"            "$out" "STUB-ENABLE-CALLED"
has   "interactive n: hint"              "$out" "Close the ports later with:"
has   "interactive n: finished"          "$out" "REACHED-END"

# 4. enable fails: warn, say what to run, carry on — never "Upgrade failed!".
out=$(run 1 3 1 "" y)
has   "no sudo: warning"     "$out" "could not close the ports (needs root or passwordless sudo)"
has   "no sudo: hint"        "$out" "arbiter-firewall.sh enable"
has   "no sudo: not hardened" "$out" "PORTS_HARDENED=0"
has   "no sudo: finished"    "$out" "REACHED-END"
hasnt "no sudo: trap"        "$out" "TRAP-FIRED"
out=$(run 1 1 1 "" y)
has   "failed: warning"      "$out" "could not close the ports (exit 1)"
has   "failed: finished"     "$out" "REACHED-END"
hasnt "failed: trap"         "$out" "TRAP-FIRED"

# 5. No systemd (2): rules are active, the operator is told they do not persist.
out=$(run 1 2 1 "" y)
has   "no systemd: message"  "$out" "a reboot removes them"
has   "no systemd: hardened" "$out" "PORTS_HARDENED=1"
has   "no systemd: finished" "$out" "REACHED-END"
hasnt "no systemd: trap"     "$out" "TRAP-FIRED"

# 6. Already closed (0) or closed-but-not-persistent (2): nothing to ask or run.
for rc in 0 2; do
    out=$(run $rc 0 1 "" y)
    hasnt "status $rc: enable"   "$out" "STUB-ENABLE-CALLED"
    hasnt "status $rc: prompt"   "$out" "VA_UPGRADE_HARDEN_PORTS"
    has   "status $rc: finished" "$out" "REACHED-END"
    hasnt "status $rc: trap"     "$out" "TRAP-FIRED"
done

# 7. No iptables (4): point at the provider firewall, do not ask, do not fail.
out=$(run 4 0 1 "" y)
has   "no iptables: message"  "$out" "iptables is not installed"
hasnt "no iptables: enable"   "$out" "STUB-ENABLE-CALLED"
has   "no iptables: finished" "$out" "REACHED-END"
hasnt "no iptables: trap"     "$out" "TRAP-FIRED"

# 8. A host without the script (a very old install): the block is skipped.
mv "$T/install/arbiter-firewall.sh" "$T/install/fw.off"
out=$(run 1 0 1 "" y)
has   "script absent: finished" "$out" "REACHED-END"
hasnt "script absent: prompt"   "$out" "VA_UPGRADE_HARDEN_PORTS"
mv "$T/install/fw.off" "$T/install/arbiter-firewall.sh"

# The pattern itself: no `set +e` around the two calls, both read with ||.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"   "$code" "set +e"
has   "status read with ||"  "$block" 'status --quiet || FIREWALL_STATUS_RC=\$?'
has   "enable read with ||"  "$block" 'enable || FIREWALL_RC=\$?'
has   "unattended default is no" "$block" 'VA_UPGRADE_HARDEN_PORTS "n"'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
