#!/bin/bash
# arbiter-doctor.sh cfg.chainlink_finality: WARN when the Chainlink config.toml
# lacks the July 2026 finality settings (apply-chainlink-finality-tolerance.sh
# --check exit 1), PASS when they are in place. txm.no_live_rpc_nodes then names
# the command that fixes it, or points at the RPCs when the settings are already
# there: on 2026-11-09 the old hint ("regenerate config.toml from the updated
# template") sent an operator looking for a template that applies the setting.
# cfg.chainlink_template counts the template settings not yet on the node.
# Runs the doctor's REAL check_chainlink_finality, check_chainlink_template and
# no_live_rpc_hint against stub tools.
# Run: bash installer/tests/doctor-chainlink-finality.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fns=$(awk '/^# July 2026 incident: without these two settings/{p=1} /^check_config\(\) \{/{p=0} p{print}' "$DOCTOR")
[ -n "$fns" ] && ok || bad "could not extract check_chainlink_finality from $DOCTOR"
grep -q '^    check_chainlink_finality$' "$DOCTOR" && ok || bad "check_config does not call check_chainlink_finality"
grep -q '^    check_chainlink_template$' "$DOCTOR" && ok || bad "check_config does not call check_chainlink_template"
grep -q "txm.no_live_rpc_nodes 'No live RPC nodes available' CRIT \"\$(no_live_rpc_hint)\"" "$DOCTOR" && ok || bad "txm.no_live_rpc_nodes does not use no_live_rpc_hint"
grep -q 'regenerate config.toml from the updated template' "$DOCTOR" "$ROOT/util/remote-doctor.sh" && bad "a doctor still gives the old hint" || ok
grep -q 'apply-chainlink-finality-tolerance.sh --check' "$ROOT/util/remote-doctor.sh" && ok || bad "remote-doctor's hint does not name the command"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
cat > "$T/install/apply-chainlink-finality-tolerance.sh" <<'STUB'
#!/bin/bash
[ "$1" = "--check" ] || { echo "STUB: unexpected $*" >&2; exit 99; }
echo "noise the doctor must not print"; exit "${CHECK_RC:-1}"
STUB
chmod +x "$T/install/apply-chainlink-finality-tolerance.sh"

# run CHECK_RC -> the emitted finding, then HINT=<no_live_rpc_hint>
run() {
    CHECK_RC="$1" INSTALL_DIR="$T/install" bash -c '
        emit() { printf "%s\t%s\t%s\t%s\n" "$@"; }
        eval "$1"
        check_chainlink_finality
        echo "HINT=$(no_live_rpc_hint)"
    ' _ "$fns" 2>&1
}

out=$(run 1)
has   "missing: WARN"      "$out" "^WARN	cfg.chainlink_finality	Chainlink config.toml lacks the July 2026 finality settings"
has   "missing: fix cmd"   "$out" "$T/install/apply-chainlink-finality-tolerance.sh --apply"
has   "missing: hint"      "$out" "HINT=TxManager cannot broadcast. config.toml lacks the July 2026 finality settings"
has   "missing: hint cmd"  "$out" "HINT=.*apply-chainlink-finality-tolerance.sh --apply"
hasnt "missing: quiet"     "$out" "noise the doctor must not print"

out=$(run 0)
has   "in place: PASS"     "$out" "^PASS	cfg.chainlink_finality	NoNewFinalizedHeadsThreshold='0s', EnforceRepeatableRead=false"
has   "in place: hint RPC" "$out" "HINT=.*finality settings are in place, so the RPCs themselves are failing"
hasnt "in place: no apply" "$out" "HINT=.*--apply"

out=$(run 2)
has   "unreadable: WARN"   "$out" "^WARN	cfg.chainlink_finality	could not read the Chainlink config.toml"
has   "unreadable: hint"   "$out" "HINT=.*apply-chainlink-finality-tolerance.sh --check"

rm "$T/install/apply-chainlink-finality-tolerance.sh"
out=$(run 1)
has   "not installed: INFO" "$out" "^INFO	cfg.chainlink_finality	apply-chainlink-finality-tolerance.sh not installed"
has   "not installed: hint" "$out" "HINT=.*--check (--apply adds them)"

# cfg.chainlink_template: the template's settings not yet on the node, counted
# without the node's own extra settings ("kept").
cat > "$T/install/regenerate-chainlink-config.sh" <<'STUB'
#!/bin/bash
[ "$1" = "--check" ] || { echo "STUB: unexpected $*" >&2; exit 99; }
echo "Chainlink config /x/config.toml"
if [ "${TPL_RC:-1}" = 1 ]; then
    echo '  [[EVM]] NoNewFinalizedHeadsThreshold: added "0s"'
    echo '  [EVM.NodePool] NewHeadsPollInterval: "30s" -> "8s"'
    echo '  [[EVM]] FinalityDepth: removed (was 5; inert since the July 2026 finality fix (cde657a))'
    echo '  [JobPipeline] MaxRunDuration: kept "15m" (this node'"'"'s own; the template does not set it)'
fi
exit "${TPL_RC:-1}"
STUB
chmod +x "$T/install/regenerate-chainlink-config.sh"
tpl() {
    TPL_RC="$1" INSTALL_DIR="$T/install" bash -c '
        emit() { printf "%s\t%s\t%s\t%s\n" "$@"; }
        eval "$1"
        check_chainlink_template
    ' _ "$fns" 2>&1
}
out=$(tpl 1)
has   "template behind: WARN"  "$out" "^WARN	cfg.chainlink_template	3 template setting(s) not applied to config.toml"
has   "template behind: fix"   "$out" "$T/install/regenerate-chainlink-config.sh --apply"
out=$(tpl 0)
has   "template applied: PASS" "$out" "^PASS	cfg.chainlink_template	config.toml has every template setting"
out=$(tpl 2)
has   "template unknown: INFO" "$out" "^INFO	cfg.chainlink_template	could not compare"
rm "$T/install/regenerate-chainlink-config.sh"
out=$(tpl 1)
has   "template tool missing: INFO" "$out" "^INFO	cfg.chainlink_template	regenerate-chainlink-config.sh not installed"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
