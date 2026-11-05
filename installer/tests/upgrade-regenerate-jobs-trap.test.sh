#!/bin/bash
# The ERR trap has a blind spot (node A6a). Without errtrace it does not fire
# inside a function, but errexit still does: a failing plain command in a function
# ends the upgrade with no trap at all, so no "Upgrade failed!" and no restart of an
# arbiter the upgrade stopped (measured on bash 5.2 and 3.2). regenerate_job_specs
# read `$?` after such commands, so a failed unregister-oracle.sh or configure-node.sh
# never reached its own handling. check_chainlink_config had the same hole.
#
# This test runs the script's REAL functions, called as the script calls them, under
# `set -e` and a real ERR trap, with each step failing in turn. It also pins that a
# template diff of the two job timeouts alone no longer offers the costly path.
# Run: bash installer/tests/upgrade-regenerate-jobs-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn_of() { awk -v name="$1" '$0 == name "() {" {p=1} p{print} p&&/^}$/{exit}' "$S"; }
regen=$(fn_of regenerate_job_specs)
check_template=$(fn_of check_job_spec_template)
without_timeouts=$(fn_of job_template_without_timeouts)
# Its python heredoc has a `}` in the first column, so this one is taken up to its call.
check_config=$(awk '/^check_chainlink_config\(\) \{$/{p=1} /^# Call the config check function/{p=0} p{print}' "$S")
capture=$(fn_of run_echo_capture)
call_template=$(grep -nE '^[[:space:]]*(JOB_TEMPLATE_RC=0|check_job_spec_template)' "$S" | head -3)
[ -n "$regen" ] && ok || bad "could not extract regenerate_job_specs"
[ -n "$check_template" ] && ok || bad "could not extract check_job_spec_template"
[ -n "$without_timeouts" ] && ok || bad "could not extract job_template_without_timeouts"
[ -n "$check_config" ] && ok || bad "could not extract check_chainlink_config"
[ -n "$capture" ] && ok || bad "could not extract run_echo_capture"

# The two calls read the exit code; a bare call would die in silence.
grep -qE '^check_job_spec_template \|\| JOB_TEMPLATE_RC=\$\?$' "$S" && ok || bad "check_job_spec_template is not called with || rc=\$?: $call_template"
grep -qE '^check_chainlink_config \|\| CHAINLINK_CONFIG_RC=\$\?$' "$S" && ok || bad "check_chainlink_config is not called with || rc=\$?"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
I="$T/install"; SRC="$T/src"; REPO_NODE="$T/repo-node"; TARGET_NODE="$I/chainlink-node"; BIN="$T/bin"; HOME_DIR="$T/home"
mkdir -p "$I/installer" "$SRC/bin" "$REPO_NODE" "$TARGET_NODE" "$BIN" "$HOME_DIR/.chainlink-testnet"
for tool in unregister-oracle.sh register-oracle.sh start-arbiter.sh stop-arbiter.sh; do
    cat > "$I/$tool" <<STUB
#!/bin/bash
echo "STUB-$tool"
exit "\${${tool%%[-.]*}_RC:-0}"
STUB
    chmod +x "$I/$tool"
done
cat > "$SRC/bin/configure-node.sh" <<'STUB'
#!/bin/bash
echo "STUB-CONFIGURE"
exit "${CONF_RC:-0}"
STUB
cat > "$BIN/docker" <<'STUB'
#!/bin/bash
case "$1" in
  ps) if [ "${2:-}" = "-a" ] || [ "${DOCKER_RUNNING:-1}" = 1 ]; then echo "abc chainlink"; fi ;;
  start) echo "STUB-DOCKER-START"; exit "${DOCKER_START_RC:-0}" ;;
esac
STUB
chmod +x "$BIN/docker"
cat > "$BIN/curl" <<'STUB'
#!/bin/bash
exit "${CURL_RC:-0}"
STUB
chmod +x "$BIN/curl"
cat > "$BIN/cp" <<'STUB'
#!/bin/bash
case "${2:-}" in
  *installer/.contracts) [ -n "${CP_CONTRACTS_FAILS:-}" ] && { echo "cp: cannot write $2" >&2; exit 1; } ;;
esac
exec /bin/cp "$@"
STUB
chmod +x "$BIN/cp"

contracts() { printf 'AGGREGATOR_ADDRESS="0xAGG"\nCLASSES_ID="128"\n' > "$I/installer/.contracts"; }

# regen_run — calls check_job_spec_template exactly as the script does, with the prompt answered.
regen_run() {
    ( cd "$T" && PATH="$BIN:$PATH" TARGET_DIR="$I" SCRIPT_DIR="$SRC/bin" INSTALLER_DIR="$SRC" \
      REPO_CHAINLINK_NODE="$REPO_NODE" TARGET_CHAINLINK_NODE="$TARGET_NODE" JOBS_ALREADY_REGENERATED=0 \
      VERDIKTA_UNATTENDED=1 VA_UPGRADE_REGENERATE_JOBS="${ANSWER:-y}" \
      REGEN="$regen" TEMPLATE="$check_template" WITHOUT="$without_timeouts" CAPTURE="$capture" ROOT="$ROOT" \
      bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        source "$ROOT/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$CAPTURE"
        eval "$WITHOUT"
        eval "$REGEN"
        eval "$TEMPLATE"
        JOB_TEMPLATE_RC=0
        check_job_spec_template || JOB_TEMPLATE_RC=$?
        echo "REACHED-END rc=$JOB_TEMPLATE_RC regenerated=$JOBS_ALREADY_REGENERATED failed=[${JOB_REGEN_FAILED:-}]"
      ' 2>&1 )
    echo "rc=$?"
}

# ── A template diff of the timeouts alone: no costly path ────────────────────
cp "$REPO/chainlink-node/basicJobSpec" "$REPO_NODE/basicJobSpec"
python3 - "$REPO_NODE/basicJobSpec" "$TARGET_NODE/basicJobSpec" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
s = re.sub(r'^maxTaskDuration = "[^"]*"', 'maxTaskDuration = "300s"', s, flags=re.M)
s = re.sub(r'timeout="[^"]*"', 'timeout="300s" # increase timeout to 300s', s)
open(sys.argv[2], 'w').write(s)
PY
contracts
out=$(regen_run)
hasnt "timeouts only: no deregistration"  "$out" "STUB-unregister"
hasnt "timeouts only: no configure-node"  "$out" "STUB-CONFIGURE"
hasnt "timeouts only: no re-registration" "$out" "STUB-register"
hasnt "timeouts only: no question"        "$out" "VA_UPGRADE_REGENERATE_JOBS"
has   "timeouts only: says what happens"  "$out" "apply-job-timeouts"
has   "timeouts only: end"                "$out" "REACHED-END rc=0 regenerated=0"
hasnt "timeouts only: trap"               "$out" "TRAP-FIRED"

# ── Any other template change still offers the path, and the rule holds in it ─
printf '# another change\n' >> "$REPO_NODE/basicJobSpec"
# A node registered in parts: this path would register every new job on one class. Refused untouched.
printf 'AGGREGATOR_ADDRESS="0xAGG"\nCLASSES_ID="134"\nREGISTRATION_SPLIT="true"\n' > "$I/installer/.contracts"
out=$(ANSWER=y regen_run)
hasnt "split: no deregistration"  "$out" "STUB-unregister"
hasnt "split: no configure-node"  "$out" "STUB-CONFIGURE"
hasnt "split: no re-registration" "$out" "STUB-register"
has   "split: reported"           "$out" "failed=\[.*separate classes"
hasnt "split: trap"               "$out" "TRAP-FIRED"
contracts
out=$(ANSWER=n regen_run)
has   "other change, declined: asked"  "$out" "VA_UPGRADE_REGENERATE_JOBS"
hasnt "other change, declined: nothing runs" "$out" "STUB-unregister"
has   "other change, declined: end"    "$out" "REACHED-END rc=0 regenerated=0"

contracts
out=$(regen_run)
has   "regen: deregisters"  "$out" "STUB-unregister"
has   "regen: configures"   "$out" "STUB-CONFIGURE"
has   "regen: re-registers" "$out" "STUB-register"
has   "regen: end"          "$out" "REACHED-END rc=0 regenerated=1 failed=\[\]"
hasnt "regen: trap"         "$out" "TRAP-FIRED"

# Deregistration fails: the jobs and the stake on them stay; the upgrade finishes and says so.
contracts
out=$(unregister_RC=1 regen_run)
has   "dereg fails: end"        "$out" "REACHED-END rc=0 regenerated=0"
has   "dereg fails: reported"   "$out" "failed=\[.*deregist"
hasnt "dereg fails: no configure" "$out" "STUB-CONFIGURE"
hasnt "dereg fails: no trap"    "$out" "TRAP-FIRED"
has   "dereg fails: exit 0 from the block" "$out" "rc=0"

# configure-node fails: reported, the arbiter stopped for the rest of the upgrade.
contracts
out=$(CONF_RC=1 regen_run)
has   "configure fails: end"      "$out" "REACHED-END rc=0 regenerated=0"
has   "configure fails: reported" "$out" "failed=\[.*configure-node"
# configure-node.sh deletes the old jobs first: registering from the old .contracts would lock stake on jobs that are gone.
has   "configure fails: no promise about the old jobs" "$out" "the old jobs may already be deleted"
has   "configure fails: warns off the old file" "$out" "Do not register from it"
hasnt "configure fails: no advice to re-register the old ids" "$out" "re-register them"
hasnt "configure fails: no re-registration" "$out" "STUB-register"
has   "configure fails: stops the arbiter" "$out" "STUB-stop-arbiter"
hasnt "configure fails: no trap"  "$out" "TRAP-FIRED"

# The new job ids cannot be copied into the install: registering from the old file would lock stake on jobs that no longer exist.
contracts
printf 'JOB_ID_1="new-job"\n' > "$SRC/.contracts"
out=$(CP_CONTRACTS_FAILS=1 regen_run)
rm -f "$SRC/.contracts"
has   "contracts copy fails: end"      "$out" "REACHED-END rc=0 regenerated=0"
has   "contracts copy fails: reported" "$out" "failed=\[.*\.contracts"
hasnt "contracts copy fails: no re-registration" "$out" "STUB-register"
has   "contracts copy fails: stops the arbiter" "$out" "STUB-stop-arbiter"
hasnt "contracts copy fails: no trap"  "$out" "TRAP-FIRED"

# Re-registration fails: the new jobs are in, and the operator is told to register them.
contracts
out=$(register_RC=1 regen_run)
has   "register fails: end"      "$out" "REACHED-END rc=0 regenerated=1"
has   "register fails: reported" "$out" "failed=\[.*register-oracle"
hasnt "register fails: no trap"  "$out" "TRAP-FIRED"

# stop-arbiter fails at the end: not fatal, and the upgrade goes on.
contracts
out=$(stop_RC=1 regen_run)
has   "stop fails: end"     "$out" "REACHED-END"
hasnt "stop fails: no trap" "$out" "TRAP-FIRED"

# Chainlink cannot be started for the regeneration.
contracts
out=$(DOCKER_RUNNING=0 DOCKER_START_RC=1 regen_run)
has   "chainlink down: end"        "$out" "REACHED-END"
has   "chainlink down: reported"   "$out" "failed=\[.*"
hasnt "chainlink down: no configure" "$out" "STUB-CONFIGURE"
hasnt "chainlink down: no trap"    "$out" "TRAP-FIRED"

# ── check_chainlink_config ───────────────────────────────────────────────────
config_run() {
    ( cd "$T" && HOME="$HOME_DIR" NETWORK_TYPE=testnet TARGET_DIR="$I" INSTALLER_DIR="$SRC" REPO_CHAINLINK_NODE="$REPO_NODE" \
      VERDIKTA_UNATTENDED=1 VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG="${CONFIG_ANSWER:-y}" PATH="${FAKE_PATH:-$PATH}" \
      FN="$check_config" ROOT="$ROOT" \
      bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        source "$ROOT/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$FN"
        CHAINLINK_CONFIG_RC=0
        check_chainlink_config || CHAINLINK_CONFIG_RC=$?
        echo "REACHED-END rc=$CHAINLINK_CONFIG_RC"
      ' 2>&1 )
    echo "rc=$?"
}
cat > "$I/installer/.env" <<'EOF'
NETWORK_CHAIN_ID="84532"
NETWORK_NAME="Base Sepolia"
DEPLOYMENT_NETWORK="base_sepolia"
BASE_SEPOLIA_RPC_HTTP_URLS="https://rpc.example.test"
BASE_SEPOLIA_RPC_WS_URLS="wss://rpc.example.test"
EOF
cp "$REPO/chainlink-node/config_template.toml" "$REPO_NODE/config_template.toml"
printf '[Log]\nLevel = "error"\n' > "$HOME_DIR/.chainlink-testnet/config.toml"
out=$(config_run)
has   "regenerate: end"    "$out" "REACHED-END rc=0"
grep -q 'ChainID=84532' "$HOME_DIR/.chainlink-testnet/config.toml" && ok || bad "regenerate: the config was not written"
ls "$HOME_DIR"/.chainlink-testnet/config.toml.backup.* >/dev/null 2>&1 && ok || bad "regenerate: no backup"
hasnt "regenerate: trap"   "$out" "TRAP-FIRED"

# The render fails (a python3 that exits 1): the config is left as it was, and the upgrade goes on.
mkdir -p "$T/badpy"; printf '#!/bin/bash\nexit 1\n' > "$T/badpy/python3"; chmod +x "$T/badpy/python3"
printf '[Log]\nLevel = "error"\n' > "$HOME_DIR/.chainlink-testnet/config.toml"
cp "$HOME_DIR/.chainlink-testnet/config.toml" "$T/config.was"
out=$(FAKE_PATH="$T/badpy:$PATH" config_run)
has   "render fails: end"       "$out" "REACHED-END rc=1"
cmp -s "$HOME_DIR/.chainlink-testnet/config.toml" "$T/config.was" && ok || bad "render fails: the config was changed"
hasnt "render fails: no trap"   "$out" "TRAP-FIRED"

# The backup fails (a cp that cannot write): no half-replace.
mkdir -p "$T/badcp"; printf '#!/bin/bash\nexit 1\n' > "$T/badcp/cp"; chmod +x "$T/badcp/cp"
out=$(FAKE_PATH="$T/badcp:$PATH" config_run)
has   "backup fails: end"     "$out" "REACHED-END rc=1"
hasnt "backup fails: no trap" "$out" "TRAP-FIRED"
cmp -s "$HOME_DIR/.chainlink-testnet/config.toml" "$T/config.was" && ok || bad "backup fails: the config was changed"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
