#!/bin/bash
# arbiter-doctor.sh's health-call checks (v2 keeper; verdikta-dispatcher TODO item 16):
# cfg.health_chains (each registered job has its hash-chain file, 0600) and svc.health_jobs (each has
# a current Chainlink health job, from apply-health-jobs.sh --check, stubbed here; the tool has its
# own test). Runs the doctor's REAL check_health_calls.
# Run: bash installer/tests/doctor-health-calls.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^check_health_calls\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract check_health_calls from $DOCTOR"
grep -q '^check_health_calls$' "$DOCTOR" && ok || bad "the doctor does not call check_health_calls"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
I="$T/i"; D="$I/health-chains"; mkdir -p "$D"
K1=0x$(printf 'a%.0s' $(seq 1 64)); K2=0x$(printf 'b%.0s' $(seq 1 64))
chain() { printf '{"version":1,"key":"%s","chains":[{"seed":"0x01","length":100000,"head":"0x02"}]}' "$1" > "$D/$1.json"; chmod 600 "$D/$1.json"; }
record() { printf '{"version":1,"keeper":"0x%s","chainId":84532,"jobs":{"job1":"%s","job2":"%s"}}' "$(printf 'c%.0s' $(seq 1 40))" "$K1" "$K2" > "$D/registrations.json"; }
cat > "$I/apply-health-jobs.sh" <<'STUB'
#!/bin/bash
exit "${HEALTH_CHECK_RC:-0}"
STUB
chmod +x "$I/apply-health-jobs.sh"

run() {
    INSTALL_DIR="$I" FN="$fn" bash -c '
        emit() { echo "$1 $2 :: $3 :: ${4:-}"; }
        eval "$FN"
        check_health_calls
    ' 2>&1
}

out=$(run)
has "nothing recorded: info" "$out" "INFO cfg.health_chains"
hasnt "nothing recorded: no job check" "$out" "svc.health_jobs"

record; chain "$K1"; chain "$K2"
out=$(run)
has "all there: chains pass" "$out" "PASS cfg.health_chains :: 2 registered job"
has "all there: says to back up" "$out" "Back up"
has "all there: health jobs pass" "$out" "PASS svc.health_jobs"

rm "$D/$K2.json"
out=$(run)
has "a chain file missing: critical" "$out" "CRIT cfg.health_chains :: job job2: no hash-chain file"
chain "$K2"; chmod 644 "$D/$K2.json"
out=$(run)
has "a chain file readable by others: critical" "$out" "job job2: hash-chain file readable by others"
chain "$K2"
printf '{"chains": []}' > "$D/$K1.json"; chmod 600 "$D/$K1.json"
out=$(run)
has "an empty chain file: critical" "$out" "job job1: hash-chain file holds no chain"
chain "$K1"

out=$(HEALTH_CHECK_RC=1 run)
has "a health job missing: critical" "$out" "CRIT svc.health_jobs"
has "a health job missing: names the fix" "$out" "apply-health-jobs.sh --apply"
out=$(HEALTH_CHECK_RC=2 run)
has "cannot check: warning" "$out" "WARN svc.health_jobs"
rm "$I/apply-health-jobs.sh"
out=$(run)
has "tool not installed: warning" "$out" "WARN svc.health_jobs :: apply-health-jobs.sh not installed"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
