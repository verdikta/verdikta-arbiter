#!/bin/bash
# arbiter-doctor.sh job.template and op.request_authorization: the node's live jobs against
# this release's template (FAIL when one is stale: it answers nothing), and whether the
# operator contract has request authorization (WARN when it does not: the jobs guard it, and
# the hint names the migration). Runs the doctor's REAL check_job_template against a stub
# job-template.cjs. Nothing of the tool's output is printed: a job's tasks hold the
# adapter's credential.
# Run: bash installer/tests/doctor-job-template.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^check_job_template\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract check_job_template from $DOCTOR"
grep -q '^check_job_template$' "$DOCTOR" && ok || bad "the doctor does not call check_job_template"
echo "$fn" | grep -q 'job-template.cjs" apply\|"$tool" apply' && bad "the doctor's check changes jobs" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
cat > "$T/install/job-template.cjs" <<'STUB'
if (process.argv[2] !== 'check') { console.error('STUB: unexpected ' + process.argv.slice(2).join(' ')); process.exit(99); }
console.log(process.env.STUB_OUT || '');
process.exit(Number(process.env.STUB_RC || 0));
STUB
run() {  # STUB_RC STUB_OUT
    STUB_RC="$1" STUB_OUT="$2" INSTALL_DIR="$T/install" bash -c '
        emit() { printf "%s\t%s\t%s\t%s\n" "$@"; }
        eval "$1"
        check_job_template
    ' _ "$fn" 2>&1
}
V1_OK="All 10 job(s) are this release's: the operator contract checks each requester itself (request authorization v1)."
LEGACY_OK="All 10 job(s) are this release's: the operator contract predates request authorization, so each job asks the ReputationKeeper 0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0 about the requester."
STALE="  stale: Verdikta AI Arbiter 1 (aaaaaaaa-0000-0000-0000-000000000001): its bridge task sends no service credential SECRET-TASK-TEXT
  stale: Verdikta AI Arbiter 2 (aaaaaaaa-0000-0000-0000-000000000002): its tasks differ from this release's template
2 of 10 job(s) are not this release's (the operator contract predates request authorization, so each job asks the ReputationKeeper 0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0 about the requester)."

out=$(run 0 "$V1_OK")
has   "v1, current: jobs PASS"     "$out" "^PASS	job.template	every job is this release's"
has   "v1, current: operator PASS" "$out" "^PASS	op.request_authorization	the operator contract checks each requester itself (v1)"
[ "$(echo "$out" | wc -l | tr -d ' ')" = "2" ] && ok || bad "v1, current: expected two findings: $out"

out=$(run 0 "$LEGACY_OK")
has   "legacy, current: jobs PASS" "$out" "^PASS	job.template"
has   "legacy, current: operator WARN, not FAIL" "$out" "^WARN	op.request_authorization	the operator contract predates request authorization"
has   "legacy, current: names the migration" "$out" "migrate-operator.sh --check"
has   "legacy, current: names the cost" "$out" "new job's reputation"
hasnt "legacy, current: no failure" "$out" "^FAIL\|^CRIT"

out=$(run 1 "$STALE")
has   "stale: FAIL with the count" "$out" "^FAIL	job.template	2 job(s) are not this release's"
has   "stale: says what it means"  "$out" "answers nothing"
has   "stale: the fix keeps the ids" "$out" "replace them under their own job ids (nothing on chain): node $T/install/job-template.cjs apply"
has   "stale: operator still reported" "$out" "^WARN	op.request_authorization"
hasnt "stale: none of the tool's own lines" "$out" "SECRET-TASK-TEXT\|Verdikta AI Arbiter 1"

out=$(run 2 "Could not measure the jobs: the node at http://localhost:6688 did not answer GET /v2/jobs")
has   "unmeasured: INFO" "$out" "^INFO	job.template	could not measure"
hasnt "unmeasured: nothing said of the operator" "$out" "op.request_authorization"
hasnt "unmeasured: not a failure" "$out" "^FAIL"

rm "$T/install/job-template.cjs"
out=$(run 0 "")
has   "not installed: INFO" "$out" "^INFO	job.template	job-template.cjs not installed"

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
