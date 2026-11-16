#!/bin/bash
# Node A6a: the values a code-review evaluation needs from Chainlink (design §11).
# The job's maxTaskDuration and bridge timeout are 840 s, and [JobPipeline]
# MaxRunDuration is at least 15 m: Chainlink 2.23.0's default of 10 m
# (core/config/docs/core.toml at tag v2.23.0) would end the run at 600 s, whatever
# the job says. installer/tests/job-timeouts.integration.sh measures that on the
# real binary; this test reads the files, on every machine.
# Run: bash installer/tests/job-timeouts-values.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
JOB="$REPO/chainlink-node/basicJobSpec"
CFG="$REPO/chainlink-node/config_template.toml"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# ── The job ──────────────────────────────────────────────────────────────────
grep -qE '^maxTaskDuration = "840s"$' "$JOB" && ok || bad "basicJobSpec: maxTaskDuration is not 840s"
# The one bridge task, and the only timeout in the job.
[ "$(grep -c 'timeout=' "$JOB")" = "1" ] && ok || bad "basicJobSpec: expected exactly one task timeout"
python3 - "$JOB" <<'PY' && ok || bad "basicJobSpec: the verdikta-ai bridge's timeout is not 840s"
import re, sys
text = open(sys.argv[1]).read()
sys.exit(0 if re.search(r'type="bridge"\s+name="verdikta-ai"\s+timeout="840s"\s*\n', text) else 1)
PY
grep -q '300s' "$JOB" && bad "basicJobSpec still names 300s" || ok

# ── Text mode: the template changed in those two values and nothing else ─────
# The hash is of the template before this node, with the two values blanked. A
# later template change needs its own review of what it does to text-mode jobs,
# and a new hash here.
NORMALIZED_BEFORE_A6A=d3534e1dd280a6f66b28609676a324d930e30d11207c663fd4f620edb0b35827
got=$(python3 - "$JOB" <<'PY'
import hashlib, re, sys
s = open(sys.argv[1]).read()
s = re.sub(r'^maxTaskDuration = "[^"]*"', 'maxTaskDuration = "N"', s, flags=re.M)
s = re.sub(r'timeout="[^"]*"(?: #[^\n]*)?', 'timeout="N"', s)
print(hashlib.sha256(s.encode()).hexdigest())
PY
)
[ "$got" = "$NORMALIZED_BEFORE_A6A" ] && ok || bad "basicJobSpec changed beyond the two timeouts (normalized sha256 $got)"

# ── The node ─────────────────────────────────────────────────────────────────
python3 - "$CFG" <<'PY' && ok || bad "config_template.toml: [JobPipeline] MaxRunDuration is missing or below 15m"
import re, sys
lines = open(sys.argv[1]).read().splitlines()
start = lines.index('[JobPipeline]')
body = []
for line in lines[start + 1:]:
    if line.startswith('['):
        break
    body.append(line)
values = [re.match(r'MaxRunDuration\s*=\s*"(\d+)m"$', l) for l in body if l.startswith('MaxRunDuration')]
sys.exit(0 if len(values) == 1 and values[0] and int(values[0].group(1)) >= 15 else 1)
PY
# The table comes before its sub-table, in one place.
[ "$(grep -c '^\[JobPipeline\]$' "$CFG")" = "1" ] && ok || bad "config_template.toml: [JobPipeline] appears other than once"
grep -n '^\[JobPipeline' "$CFG" | head -1 | grep -q '\[JobPipeline\]$' && ok || bad "config_template.toml: [JobPipeline] is not before [JobPipeline.HTTPRequest]"
# The default this rule was read from is 2.23.0's: a new image needs it read again.
for f in "$ROOT/bin/setup-chainlink.sh" "$ROOT/bin/setup-docker.sh"; do
    images=$(grep -oE 'smartcontract/chainlink:[0-9.]+' "$f" | sort -u)
    [ "$images" = "smartcontract/chainlink:2.23.0" ] && ok || bad "$(basename "$f") runs $images: read that release's MaxRunDuration default and timeout semantics again, then change this pin"
done

# ── The rest of the 840 s: the EA agrees with the job ────────────────────────
grep -qE 'DEFAULT_SERVER_TIMEOUT_MS = 840000;' "$REPO/external-adapter/src/utils/serverTimeout.js" && ok || bad "the EA's SERVER_TIMEOUT default is not the job's 840 s"
grep -qE 'DEFAULT_DEADLINE_MS = 780000;' "$REPO/external-adapter/src/codeReview/time.js" && ok || bad "the EA's deadline is not the job's 840 s less the commit reserve"
grep -qE 'COMMIT_RESERVE_MS = 60000;' "$REPO/external-adapter/src/codeReview/time.js" && ok || bad "the commit reserve is not 60 s"

# ── A fresh install and an upgrade take these files and this tool ────────────
grep -q 'chainlink-node/config_template.toml' "$ROOT/bin/setup-chainlink.sh" && ok || bad "setup-chainlink.sh does not render config_template.toml"
grep -q 'JOB_SPEC_FILE="$LOCAL_CHAINLINK_NODE_DIR/basicJobSpec"' "$ROOT/bin/configure-node.sh" && ok || bad "configure-node.sh does not render basicJobSpec"
[ -x "$ROOT/util/apply-job-timeouts.sh" ] && ok || bad "installer/util/apply-job-timeouts.sh is missing or not executable"
grep -qE '^[[:space:]]+apply-job-timeouts\.sh( \\|; do)$' "$ROOT/bin/upgrade-arbiter.sh" && ok || bad "apply-job-timeouts.sh is not in the upgrade's _util copy loop"
grep -q 'apply-job-timeouts.sh' "$ROOT/bin/install.sh" && ok || bad "install.sh does not deploy apply-job-timeouts.sh"
grep -q 'VA_UPGRADE_JOB_TIMEOUTS' "$ROOT/bin/validate-answers.sh" && ok || bad "validate-answers.sh does not check VA_UPGRADE_JOB_TIMEOUTS"
grep -q 'VA_UPGRADE_JOB_TIMEOUTS' "$ROOT/config/unattended.env.example" && ok || bad "unattended.env.example does not name VA_UPGRADE_JOB_TIMEOUTS"
grep -q 'VA_UPGRADE_JOB_TIMEOUTS' "$ROOT/docs/installation/unattended.md" && ok || bad "unattended.md does not name VA_UPGRADE_JOB_TIMEOUTS"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
