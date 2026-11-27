#!/bin/bash
# installer/bin/migrate-operator.sh, the real script, against a fake install and stubbed
# tools: every step in order, a failure at each step, and the run that continues after it.
# Nothing here touches a chain or a Chainlink node. What the stubbed tools really do is
# tested elsewhere: the chain reads in operator-migration.test.cjs, the job move in
# job-template.test.cjs, deregistration in arbiter-operator/scripts/lib/registry.test.js.
# The stubs are driven by STUB_* variables: the script has variables of its own named PLAN_RC,
# MODE_RC and so on, and assigning one that came from the environment changes what a child sees.
# Run: bash installer/tests/migrate-operator.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
OLD=0x1111111111111111111111111111111111111111
NEW=0x9999999999999999999999999999999999999999
OTHER=0x5555555555555555555555555555555555555555
AGG=0x3333333333333333333333333333333333333333
J1=aaaaaaaa1111bbbb2222cccc33334444; J2=bbbbbbbb1111bbbb2222cccc33334444; J3=cccccccc1111bbbb2222cccc33334444

# ── A fake checkout: the real script and prompts library, stubs for everything it runs ──
REPO="$T/repo"
mkdir -p "$REPO/installer/bin" "$REPO/installer/lib" "$REPO/installer/util" "$REPO/arbiter-operator/scripts/lib" "$REPO/arbiter-operator/contracts/test" "$T/bin"
cp "$ROOT/bin/migrate-operator.sh" "$REPO/installer/bin/"
cp "$ROOT/lib/prompts.sh" "$REPO/installer/lib/"
echo '// sources' > "$REPO/arbiter-operator/contracts/ArbiterOperator.sol"
echo '// fixture' > "$REPO/arbiter-operator/contracts/test/Fixture.sol"
echo '{}' > "$REPO/arbiter-operator/package.json"; echo '{}' > "$REPO/arbiter-operator/deployment-addresses.json"
echo '// config' > "$REPO/arbiter-operator/hardhat.config.js"; echo '// deploy' > "$REPO/arbiter-operator/scripts/deploy.js"
echo '// lib' > "$REPO/arbiter-operator/scripts/lib/registry.js"
cat > "$REPO/arbiter-operator/scripts/operator-migration.js" <<'STUB'
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, `migration ${args.join(' ')} network=${process.env.HARDHAT_NETWORK}\n`);
if (args[0] === 'plan') {
  if (process.env.PLAN_JSON) fs.writeFileSync(args[args.indexOf('--out') + 1], process.env.PLAN_JSON);
  process.exit(Number(process.env.STUB_PLAN_RC || 0));
}
if (args[0] === 'deployed') process.exit(Number(process.env.STUB_DEPLOYED_RC || 0));
if (args[0] === 'verify') process.exit(Number(process.env.STUB_VERIFY_RC || 0));
process.exit(99);
STUB
cat > "$REPO/arbiter-operator/scripts/setAuthorizedSenders.js" <<'STUB'
require('fs').appendFileSync(process.env.CALLS, `senders ${process.argv.slice(2).join(' ')}\n`);
process.exit(Number(process.env.STUB_SENDERS_RC || 0));
STUB
cat > "$REPO/installer/util/job-template.cjs" <<'STUB'
const fs = require('fs');
const [command, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, `jobs ${command} ${rest.join(' ')} mode=${process.env.VERDIKTA_OPERATOR_MODE_JSON || ''}\n`);
if (command === 'mode') { if (process.env.MODE_OUT) console.log(process.env.MODE_OUT); process.exit(Number(process.env.STUB_MODE_RC || 0)); }
if (command === 'check') process.exit(Number((process.env.VERDIKTA_OPERATOR_MODE_JSON || '').includes('legacy') ? (process.env.STUB_PLAN_CHECK_RC || 0) : (process.env.STUB_MOVED_CHECK_RC || 0)));
if (command === 'apply') process.exit(Number(process.env.STUB_APPLY_RC || 0));
process.exit(99);
STUB
echo '// check' > "$REPO/installer/util/check-request-authorization.cjs"
for name in unregister register; do
    cat > "$REPO/installer/util/$name-oracle.sh" <<STUB
#!/bin/bash
echo "$name \$* all=\${VA_DEREGISTER_ALL_REGISTERED:-} agg=\${VA_AGGREGATOR_ADDRESS:-} classes=\${VA_CLASS_IDS:-} fee=\${VA_ORACLE_FEE_ETH:-} ids=\${VA_REGISTER_JOB_IDS:-} operator=\$(grep -o '0x[0-9a-fA-F]\{40\}' installer/.contracts | head -1)" >> "\$CALLS"
n=\$(cat "\$CALLS.$name" 2>/dev/null || echo 0); echo \$((n+1)) > "\$CALLS.$name"
rc_var=STUB_\$(echo "${name}_RC_\$((n+1))" | tr '[:lower:]' '[:upper:]')
exit "\${!rc_var:-0}"
STUB
done
cat > "$T/bin/npm" <<'STUB'
#!/bin/bash
echo "npm $* in=$(basename "$PWD")" >> "$CALLS"; exit "${STUB_NPM_RC:-0}"
STUB
cat > "$T/bin/npx" <<'STUB'
#!/bin/bash
echo "npx $* in=$(basename "$PWD") key=$(grep -c PRIVATE_KEY .env 2>/dev/null)" >> "$CALLS"
case "$*" in
    "hardhat compile") exit "${STUB_COMPILE_RC:-0}" ;;
    "hardhat run scripts/deploy.js"*) [ "${STUB_DEPLOY_RC:-0}" = "0" ] && echo "ArbiterOperator deployed to ${STUB_DEPLOY_ADDRESS-0x9999999999999999999999999999999999999999}"; exit "${STUB_DEPLOY_RC:-0}" ;;
esac
exit 99
STUB
chmod +x "$T/bin/npm" "$T/bin/npx"

plan_json() {  # GROUPS-JSON [PROBLEMS-JSON] [REGISTERED-JOBS]
    printf '{"operator":"%s","operatorOwner":"0xOwner","aggregator":"%s","keeper":"0xKeeper","senders":["0xKey1","0xKey2"],"jobs":%s,"groups":%s,"orphans":[],"unregistered":[],"tokenBalance":"0","refund":"300","stakeNeeded":"300","ethBalance":"1","ethNeeded":"0.001","responseTimeoutSeconds":300,"problems":%s,"notes":[]}' \
        "$OLD" "$AGG" "${3:-[1,2,3]}" "$1" "${2:-[]}"
}
ONE_GROUP="[{\"classes\":\"128,131\",\"feeEth\":\"0.00002\",\"jobIds\":[\"$J1\",\"$J2\",\"$J3\"]}]"
TWO_GROUPS="[{\"classes\":\"133\",\"feeEth\":\"0.0001\",\"jobIds\":[\"$J1\"]},{\"classes\":\"128\",\"feeEth\":\"0.00002\",\"jobIds\":[\"$J2\",\"$J3\"]}]"
LEGACY="{\"mode\":\"legacy\",\"keeper\":\"0x2222222222222222222222222222222222222222\"}"

# new_install — a node on the old operator, upgraded to this release.
new_install() {
    rm -rf "$T/install" "$T/calls"* "$REPO/installer/.contracts"
    I="$T/install"
    mkdir -p "$I/installer" "$I/external-adapter" "$I/arbiter-operator/scripts" "$I/arbiter-operator/node_modules"
    printf 'OPERATOR_ADDR="%s"\nNODE_ADDRESS="0xKey1"\nJOB_ID_1_NO_HYPHENS="%s"\nJOB_ID_2_NO_HYPHENS="%s"\nJOB_ID_3_NO_HYPHENS="%s"\nJOB_ID_NO_HYPHENS="%s"\nAGGREGATOR_ADDRESS="%s"\nCLASSES_ID="128,131"\n' \
        "$OLD" "$J1" "$J2" "$J3" "$J1" "$AGG" > "$I/installer/.contracts"
    printf 'DEPLOYMENT_NETWORK="base_sepolia"\nPRIVATE_KEY=SECRETKEY\nBASE_SEPOLIA_RPC_HTTP_URLS="https://rpc.invalid/SECRETRPC"\n' > "$I/installer/.env"
    printf 'PORT=8080\nOPERATOR_ADDR=%s\nEA_API_TOKEN=tokentokentokentokentokentokentoken\n' "$OLD" > "$I/external-adapter/.env"
    chmod 600 "$I/external-adapter/.env"
    cp "$I/installer/.contracts" "$REPO/installer/.contracts"
    for name in start stop; do printf '#!/bin/bash\necho "%s-arbiter" >> "$CALLS"\nexit "${STUB_%s_RC:-0}"\n' "$name" "$(echo "$name" | tr '[:lower:]' '[:upper:]')" > "$I/$name-arbiter.sh"; done
    for file in unregister-oracle.sh register-oracle.sh job-template.cjs; do echo '# installed' > "$I/$file"; done
}
run() {  # [options…] — runs the real script; the caller's environment drives the stubs
    CALLS="$T/calls" PATH="$T/bin:$PATH" HOME="$T/home" MODE_OUT="${MODE_OUT-$LEGACY}" PLAN_JSON="${PLAN_JSON-$(plan_json "$ONE_GROUP")}" \
        bash "$REPO/installer/bin/migrate-operator.sh" --install-dir "$T/install" "$@" 2>&1
    echo "rc=$?"
}
calls() { cat "$T/calls" 2>/dev/null; }
order() { calls | awk '{print $1 ($1=="jobs" || $1=="migration" || $1=="npx" ? ":" $2 ($1=="npx" ? ":" $3 : "") : "")}' | tr '\n' ' '; }
state() { cat "$T/install/installer/.operator-migration" 2>/dev/null; }

# 1. A node that already has request authorization: nothing to do, nothing read or run.
new_install
out=$(MODE_OUT='{"mode":"v1"}' VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "v1: says so"   "$out" "already has request authorization"
has   "v1: exit 0"    "$out" "rc=0"
[ "$(order)" = "jobs:mode " ] && ok || bad "v1: ran more than the mode read: $(order)"

# 2. The operator cannot be told: stop, nothing changed.
new_install
out=$(STUB_MODE_RC=1 MODE_OUT= VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "unknown operator: nothing changed" "$out" "Nothing was changed"
has   "unknown operator: exit 1"          "$out" "rc=1"
hasnt "unknown operator: no plan"         "$(calls)" "migration plan"

# 3. --check: the plan is shown, nothing is sent, no state is left.
new_install
out=$(VERDIKTA_UNATTENDED=1 run --check)
has   "check: shows what is registered" "$out" "Registered: 3 job(s) on classes \[128,131\] at 0.00002 ETH"
has   "check: shows the stake"          "$out" "300 wVDKA comes back, 300 goes in again"
has   "check: shows the wait"           "$out" "300 s (the aggregator's response window) + 60 s"
has   "check: can run"                  "$out" "The migration can run. Nothing was changed"
has   "check: exit 0"                   "$out" "rc=0"
has   "check: the plan names the node's jobs" "$(calls)" "migration plan --operator $OLD --aggregator $AGG --wrappedverdikta 0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1 --jobids $J1 $J2 $J3 --out"
has   "check: the jobs were measured as the legacy operator's" "$(calls)" "jobs check --install-dir $T/install --wait 30 mode=$LEGACY"
hasnt "check: nothing deregistered" "$(calls)" "^unregister"
hasnt "check: nothing built"        "$(calls)" "^npx"
[ ! -e "$T/install/installer/.operator-migration" ] && [ ! -e "$T/install/installer/.operator-migration.plan.json" ] && ok || bad "check: left state behind"
hasnt "check: the key is not printed" "$out" "SECRETKEY\|SECRETRPC"

# 4. A plan with a problem, jobs that are not this release's, a decline, an old install: each ends before anything is sent.
new_install
out=$(STUB_PLAN_RC=1 PLAN_JSON="$(plan_json "$ONE_GROUP" '["job x is locked on the keeper until 2026-12-01"]')" VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "problem: shown"         "$out" "PROBLEM: job x is locked"
has   "problem: cannot run"    "$out" "cannot run as things are"
has   "problem: exit 1"        "$out" "rc=1"
hasnt "problem: nothing deregistered" "$(calls)" "^unregister"
[ -z "$(state)" ] && ok || bad "problem: left state behind"
new_install
out=$(STUB_PLAN_RC=2 PLAN_JSON= VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "unreadable chain: says so" "$out" "The chain could not be read (exit 2). Nothing was changed"
new_install
out=$(STUB_PLAN_CHECK_RC=1 VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "stale jobs: upgrade first" "$out" "are not this release's (exit 1).*upgrade-arbiter.sh first. Nothing was changed"
hasnt "stale jobs: nothing deregistered" "$(calls)" "^unregister"
new_install
out=$(VERDIKTA_UNATTENDED=1 run)
has   "no answer, unattended: not migrated" "$out" "Not migrated. Nothing was changed"
has   "no answer, unattended: exit 0"       "$out" "rc=0"
hasnt "no answer, unattended: nothing deregistered" "$(calls)" "^unregister"
hasnt "no answer, unattended: nothing built"        "$(calls)" "^npx"
new_install
out=$(printf 'n\n' | run)
has   "interactive n: not migrated" "$out" "Not migrated"
new_install; rm "$T/install/job-template.cjs"
out=$(VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "old install: upgrade first" "$out" "does not run this release yet"
[ -z "$(calls)" ] && ok || bad "old install: something ran: $(calls)"
new_install
out=$(STUB_NPM_RC=0 STUB_COMPILE_RC=1 VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "build fails: before anything is sent" "$out" "The contract did not build. Nothing was changed"
hasnt "build fails: nothing deregistered" "$(calls)" "^unregister"
[ -z "$(state)" ] && ok || bad "build fails: left state behind"
[ ! -e "$T/install/contracts/operator-migration-build/.env" ] && ok || bad "build fails: left the key in the build directory"

# 5. The whole migration, unattended.
new_install
printf 'OPERATOR_ADDR="%s"\n' "$OTHER" > "$REPO/installer/.contracts"   # a checkout used for another node
out=$(VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
has   "full: complete" "$out" "Migration complete"
has   "full: exit 0"   "$out" "rc=0"
want="jobs:mode migration:plan jobs:check npm npx:hardhat:compile unregister migration:deployed npx:hardhat:run senders stop-arbiter start-arbiter jobs:apply jobs:check register migration:verify "
[ "$(order | sed 's/npx:hardhat:run migration:deployed/migration:deployed npx:hardhat:run/')" = "$want" ] || [ "$(order)" = "jobs:mode migration:plan jobs:check npm npx:hardhat:compile unregister npx:hardhat:run migration:deployed senders stop-arbiter start-arbiter jobs:apply jobs:check register migration:verify " ] \
    && ok || bad "full: steps out of order: $(order)"
c=$(calls)
has   "full: deregisters everything the keeper lists" "$c" "unregister --unattended all=y agg=$AGG .*operator=$OLD"
has   "full: builds without the test fixtures" "$( [ -e "$T/install/contracts/operator-migration-build/contracts/test" ] && echo fixtures || echo clean )" "clean"
has   "full: deploys with the key in the build's own env" "$c" "npx hardhat run scripts/deploy.js --network base_sepolia in=operator-migration-build key=1"
has   "full: the deployment is checked" "$c" "migration deployed --new-operator $NEW"
has   "full: the old contract's node keys are carried over" "$c" "senders --operator $NEW --nodes 0xKey1,0xKey2"
has   "full: jobs moved as a v1 operator's" "$c" "jobs apply --install-dir $T/install --move-to-operator --wait 240 mode={\"mode\":\"v1\"}"
has   "full: registers on the new operator, same classes and fee, every job" "$c" "register --unattended .*agg=$AGG classes=128,131 fee=0.00002 ids= operator=$NEW"
has   "full: verifies both contracts" "$c" "migration verify --operator $OLD --new-operator $NEW --aggregator $AGG --senders 0xKey1,0xKey2 --jobids $J1 $J2 $J3"
grep -q "^OPERATOR_ADDR=\"$NEW\"$" "$T/install/installer/.contracts" && ok || bad "full: installer/.contracts not repointed: $(cat "$T/install/installer/.contracts")"
grep -q "^OPERATOR_ADDR=$NEW$" "$T/install/external-adapter/.env" && ok || bad "full: the adapter's .env not repointed (or its quoting changed)"
grep -q "^PREVIOUS_OPERATOR_ADDR=\"$OLD\"$" "$T/install/installer/.contracts" && ok || bad "full: the old operator is not recorded"
grep -q "^OPERATOR_ADDR=\"$OLD\"" "$T/install/installer/.contracts.before-operator-migration" && grep -q "^OPERATOR_ADDR=$OLD" "$T/install/external-adapter/.env.before-operator-migration" && ok || bad "full: no backups of the repointed files"
grep -q "$OTHER" "$REPO/installer/.contracts" && ok || bad "full: a checkout's .contracts for another node was changed"
[ "$(grep -c JOB_ID "$T/install/installer/.contracts")" = "4" ] && grep -q "$J2" "$T/install/installer/.contracts" && ok || bad "full: the job ids changed"
# GNU first: on Linux `stat -f` is the file system's status and succeeds.
perm=$(stat -c '%a' "$T/install/external-adapter/.env" 2>/dev/null || stat -f '%Lp' "$T/install/external-adapter/.env")
[ "$perm" = "600" ] && ok || bad "full: the adapter's .env is $perm, was 600"
[ -z "$(state)" ] && ok || bad "full: the state file is still there: $(state)"
ls "$T/install/installer/".operator-migration.done.*.json >/dev/null 2>&1 && ok || bad "full: no record of what was registered"
[ ! -e "$T/install/contracts/operator-migration-build/.env" ] && ok || bad "full: left the key in the build directory"
hasnt "full: the key is not printed" "$out" "SECRETKEY\|SECRETRPC"
# Run again: the node is described as v1 now; here the stub still says legacy, and a second
# run would start a new plan, so only the absence of leftover state is checked above.

# 5b. A checkout whose own .contracts is this node's is repointed with it (configure-node.sh reads it).
new_install
out=$(VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
grep -q "^OPERATOR_ADDR=\"$NEW\"$" "$REPO/installer/.contracts" && ok || bad "the checkout's own .contracts for this node was not repointed"

# 6. Jobs registered on separate classes go back as they were: one registration per group, its jobs named.
new_install
out=$(PLAN_JSON="$(plan_json "$TWO_GROUPS")" VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
has   "two groups: complete" "$out" "Migration complete"
c=$(calls)
[ "$(echo "$c" | grep -c '^register ')" = "2" ] && ok || bad "two groups: expected two registrations: $c"
has   "two groups: the code class with its own job and fee" "$c" "register .*classes=133 fee=0.0001 ids=$J1 "
has   "two groups: the rest" "$c" "register .*classes=128 fee=0.00002 ids=$J2,$J3 "
# A single group that is not every job of the node names its jobs too.
new_install
out=$(PLAN_JSON="$(plan_json "[{\"classes\":\"128\",\"feeEth\":\"0.00002\",\"jobIds\":[\"$J1\",\"$J2\"]}]")" VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
has   "subset: jobs named" "$(calls)" "register .*classes=128 fee=0.00002 ids=$J1,$J2 "
has   "subset: verify expects those two" "$(calls)" "migration verify .*--jobids $J1 $J2 network"
# Nothing registered at all: the node still moves; nothing is deregistered or registered.
new_install
out=$(PLAN_JSON="$(plan_json '[]' '[]' '[]')" VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y run)
has   "unregistered node: complete" "$out" "Migration complete"
hasnt "unregistered node: no deregistration" "$(calls)" "^unregister"
hasnt "unregistered node: no registration"   "$(calls)" "^register"
has   "unregistered node: verify without jobs" "$(calls)" "migration verify --operator $OLD --new-operator $NEW --aggregator $AGG --senders 0xKey1,0xKey2 network"

# 7. A failure at each step: the run stops by name, says how to go on and how to go back,
#    and the next run continues without repeating what is done.
fail_then_resume() {  # NAME STOPPED-AT STEP-LEFT ENV-OF-THE-FAILURE NOT-REPEATED-PATTERN…
    local name="$1" at="$2" left="$3" failure="$4"; shift 4
    new_install
    out=$(env $failure VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 bash -c "$(declare -f run plan_json); T='$T' REPO='$REPO' LEGACY='$LEGACY' ONE_GROUP='$ONE_GROUP' OLD='$OLD' AGG='$AGG' run")
    has   "$name: stopped by name" "$out" "MIGRATION STOPPED at \"$at\""
    has   "$name: exit 1"          "$out" "rc=1"
    has   "$name: says how to go on" "$out" "run this script again"
    has   "$name: state kept"      "$(state)" "STEP=\"$left\""
    [ -s "$T/install/installer/.operator-migration.plan.json" ] && ok || bad "$name: the plan was not kept"
    : > "$T/calls"
    out=$(VERDIKTA_UNATTENDED=1 VA_MIGRATE_DRAIN_SECONDS=0 run)   # no VA_MIGRATE_OPERATOR: a continuation is not asked again
    has   "$name, resumed: says it continues" "$out" "Continuing a migration that stopped after \"$left\""
    has   "$name, resumed: complete" "$out" "Migration complete"
    has   "$name, resumed: exit 0"   "$out" "rc=0"
    for pattern in "$@"; do hasnt "$name, resumed: not repeated ($pattern)" "$(calls)" "$pattern"; done
    hasnt "$name, resumed: no new plan" "$(calls)" "migration plan"
    [ -z "$(state)" ] && ok || bad "$name, resumed: state left: $(state)"
}
fail_then_resume "deregistration" deregister planned      "STUB_UNREGISTER_RC_1=1"
fail_then_resume "deployment"     deploy     deregistered "STUB_DEPLOY_RC=1"        "^unregister"
fail_then_resume "deployment check" deploy   deregistered "STUB_DEPLOYED_RC=1"      "^unregister" "hardhat run scripts/deploy.js"
fail_then_resume "node keys"      authorize  deployed     "STUB_SENDERS_RC=1"       "^unregister" "hardhat run scripts/deploy.js"
fail_then_resume "restart"        restart    repointed    "STUB_START_RC=1"         "^unregister" "hardhat run" "^senders"
fail_then_resume "job move"       jobs       restarted    "STUB_APPLY_RC=1"         "^unregister" "hardhat run" "^senders" "arbiter$"
fail_then_resume "job check"      jobs       restarted    "STUB_MOVED_CHECK_RC=1"   "^unregister" "hardhat run" "^senders" "arbiter$"
fail_then_resume "registration"   register   jobs         "STUB_REGISTER_RC_1=1"    "^unregister" "hardhat run" "^senders" "arbiter$" "jobs apply"
fail_then_resume "verification"   verify     registered   "STUB_VERIFY_RC=1"        "^unregister" "hardhat run" "^senders" "arbiter$" "jobs apply" "^register"

# 8. Until the node is repointed, the way back is the old operator, untouched; a failed
#    deployment leaves every file as it was.
new_install
out=$(STUB_DEPLOY_RC=1 VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
has   "failed deploy: the way back" "$out" "To go back instead: run $T/install/register-oracle.sh (the old operator and its jobs are untouched)"
grep -q "^OPERATOR_ADDR=\"$OLD\"$" "$T/install/installer/.contracts" && grep -q "^OPERATOR_ADDR=$OLD$" "$T/install/external-adapter/.env" && ok || bad "failed deploy: a file was repointed"
hasnt "failed deploy: the arbiter was not restarted" "$(calls)" "arbiter$"
# A deployment whose output names no address is not taken for one.
new_install
out=$(STUB_DEPLOY_ADDRESS="somewhere" VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
has   "no address: stopped" "$out" "MIGRATION STOPPED at \"deploy\".*names no contract address"
has   "no address: nothing recorded as deployed" "$(state)" 'NEW_OPERATOR=""'
# The plan is the only record of the classes once the jobs are deregistered: without it the script does not guess.
new_install
out=$(STUB_DEPLOY_RC=1 VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=0 run)
rm "$T/install/installer/.operator-migration.plan.json"; : > "$T/calls"
out=$(VERDIKTA_UNATTENDED=1 run)
has   "plan lost: says so" "$out" "plan.json is missing"
has   "plan lost: exit 1"  "$out" "rc=1"
[ -z "$(calls)" ] && ok || bad "plan lost: something ran: $(calls)"

# 9. The wait after deregistration is the aggregator's window plus a minute, counted from the deregistration.
grep -q 'DRAIN="${VA_MIGRATE_DRAIN_SECONDS:-$(( $(plan_value responseTimeoutSeconds) + 60 ))}"' "$ROOT/bin/migrate-operator.sh" && ok || bad "the default wait is not the aggregator's response window + 60 s"
new_install
start=$(date +%s)
out=$(VERDIKTA_UNATTENDED=1 VA_MIGRATE_OPERATOR=y VA_MIGRATE_DRAIN_SECONDS=3 run)
[ $(( $(date +%s) - start )) -ge 3 ] && ok || bad "a 3 s wait did not wait"
has   "wait: said" "$out" "Step 3: waiting"

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
