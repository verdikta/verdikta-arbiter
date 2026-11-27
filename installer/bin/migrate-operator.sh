#!/bin/bash
#
# Verdikta Arbiter - move a node to an operator contract with request authorization
#
# An ArbiterOperator deployed before 2026-11-19 accepts a request from any address. It is
# not a proxy, so the check cannot be added to it: the node moves to a new contract. This
# script does the whole move, in the order that leaves no stake behind and can be continued
# after any failure:
#
#   1. plan         reads the chain: which of the node's jobs are registered, on which
#                   classes, at what fee, with how much stake; which node keys the old
#                   contract authorizes; whether the owner's key, ETH and wVDKA are enough.
#                   Builds the new contract. Nothing is sent. `--check` stops here.
#   2. deregister   every job id the keeper lists for the old contract; the stake returns.
#   3. drain        waits out the aggregator's response window, so that a round this node
#                   was already selected for can finish.
#   4. deploy       the hardened ArbiterOperator from this checkout, and authorizes on it the
#                   node keys the old contract authorized.
#   5. repoint      OPERATOR_ADDR in the install's installer/.contracts, this checkout's, and
#                   external-adapter/.env (each backed up first), then restarts the arbiter.
#   6. jobs         each job is replaced under its own id by this release's job on the new
#                   contract (job-template.cjs apply --move-to-operator). The job ids do not
#                   change.
#   7. register     the same job ids, on the same classes and at the same fee as before.
#   8. verify       the new contract's version, owner and node keys, the keeper's registry
#                   for both contracts, and a simulated request from an unapproved address,
#                   which must be refused.
#
# What it costs: gas for one deployment and two transactions per job. The stake goes out and
# back in. A registration is on (operator contract, job id), so each job starts again with
# the reputation of a new one: on mainnet that is the real cost, and the reason this is the
# owner's decision and not part of an upgrade. The node answers nothing from step 2 to step 7.
#
# The install must already run this release (upgrade-arbiter.sh first: it takes a node on an
# old contract as it is). Progress is kept in <install>/installer/.operator-migration with the
# plan beside it; run the script again to go on from where it stopped.
#
# Usage: migrate-operator.sh [--install-dir DIR] [--check] [--answers FILE | --unattended]
#   Unattended: VA_INSTALL_DIR, VA_MIGRATE_OPERATOR=y (required; the default is no),
#   VA_MIGRATE_DRAIN_SECONDS (default: the aggregator's responseTimeoutSeconds + 60).
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$INSTALLER_DIR")"
UTIL_DIR="$INSTALLER_DIR/util"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

ANSWERS_FILE=""; UNATTENDED_REQUESTED=false; TARGET_DIR_FLAG=""; CHECK_ONLY=false
while [ $# -gt 0 ]; do
    case "$1" in
        --answers|-a) shift; [ -z "${1:-}" ] && { echo "--answers requires a file argument"; exit 1; }; ANSWERS_FILE="$1"; shift ;;
        --unattended) UNATTENDED_REQUESTED=true; shift ;;
        --install-dir) shift; [ -z "${1:-}" ] && { echo "--install-dir requires a directory"; exit 1; }; TARGET_DIR_FLAG="$1"; shift ;;
        --check) CHECK_ONLY=true; shift ;;
        --help|-h) sed -n '2,44p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
    esac
done

if [ ! -f "$INSTALLER_DIR/lib/prompts.sh" ]; then
    echo "Error: prompts library not found at $INSTALLER_DIR/lib/prompts.sh"; exit 1
fi
# shellcheck disable=SC1091
source "$INSTALLER_DIR/lib/prompts.sh"
if [ -n "$ANSWERS_FILE" ]; then
    load_answers_file "$ANSWERS_FILE"
elif [ "$UNATTENDED_REQUESTED" = "true" ]; then
    export VERDIKTA_UNATTENDED=1
fi

say()  { echo -e "${BLUE}$*${NC}"; }
good() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
bad()  { echo -e "${RED}$*${NC}"; }

# ── The install ──────────────────────────────────────────────────────────────
DEFAULT_INSTALL_DIR="$HOME/verdikta-arbiter-node"
if [ -n "$TARGET_DIR_FLAG" ]; then
    TARGET_DIR="$TARGET_DIR_FLAG"
elif unattended_mode; then
    TARGET_DIR="${VA_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
else
    prompt_value "Enter the installation directory [$DEFAULT_INSTALL_DIR]: " TARGET_DIR VA_INSTALL_DIR
    TARGET_DIR="${TARGET_DIR:-$DEFAULT_INSTALL_DIR}"
fi
TARGET_DIR="${TARGET_DIR/#\~/$HOME}"
CONTRACTS_FILE="$TARGET_DIR/installer/.contracts"
ENV_FILE="$TARGET_DIR/installer/.env"
ADAPTER_ENV="$TARGET_DIR/external-adapter/.env"
OPERATOR_DIR="$TARGET_DIR/arbiter-operator"
STATE_FILE="$TARGET_DIR/installer/.operator-migration"
PLAN_FILE="$TARGET_DIR/installer/.operator-migration.plan.json"
BUILD_DIR="$TARGET_DIR/contracts/operator-migration-build"

for needed in "$CONTRACTS_FILE" "$ENV_FILE" "$ADAPTER_ENV" "$TARGET_DIR/unregister-oracle.sh" "$TARGET_DIR/register-oracle.sh" \
              "$TARGET_DIR/start-arbiter.sh" "$TARGET_DIR/stop-arbiter.sh"; do
    if [ ! -f "$needed" ]; then
        bad "Error: $needed not found. $TARGET_DIR is not a complete arbiter installation."; exit 1
    fi
done
if [ ! -f "$TARGET_DIR/job-template.cjs" ] || [ ! -d "$OPERATOR_DIR/scripts" ]; then
    bad "Error: this installation does not run this release yet (no job-template.cjs in $TARGET_DIR)."
    bad "Run installer/bin/upgrade-arbiter.sh first: it takes a node on an old operator contract as it is. Nothing was changed."
    exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
# shellcheck disable=SC1090
source "$CONTRACTS_FILE"
case "${DEPLOYMENT_NETWORK:-}" in
    base_mainnet) WRAPPED_VERDIKTA_ADDRESS="0x1EA68D018a11236E07D5647175DAA8ca1C3D0280"; RPC_URLS="${BASE_MAINNET_RPC_HTTP_URLS:-${BASE_MAINNET_RPC_URL:-}}" ;;
    base_sepolia) WRAPPED_VERDIKTA_ADDRESS="0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1"; RPC_URLS="${BASE_SEPOLIA_RPC_HTTP_URLS:-${BASE_SEPOLIA_RPC_URL:-}}" ;;
    *) bad "Error: installer/.env names no supported DEPLOYMENT_NETWORK. Nothing was changed."; exit 1 ;;
esac
if [ -z "${PRIVATE_KEY:-}" ]; then
    bad "Error: installer/.env holds no PRIVATE_KEY (the operator contract owner's key). Nothing was changed."; exit 1
fi

if [ -d "$HOME/.nvm" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm use 20.18.1 >/dev/null 2>&1 || true
fi
for tool in node npm npx python3; do
    command -v "$tool" >/dev/null 2>&1 || { bad "Error: $tool is not available. Nothing was changed."; exit 1; }
done

# ── State ────────────────────────────────────────────────────────────────────
STEP=""; OLD_OPERATOR=""; NEW_OPERATOR=""; DEREGISTERED_AT=""
if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
fi
save_state() {
    local tmp="$STATE_FILE.tmp.$$"
    ( umask 077
      { echo "STEP=\"$STEP\""; echo "OLD_OPERATOR=\"$OLD_OPERATOR\""; echo "NEW_OPERATOR=\"$NEW_OPERATOR\""; echo "DEREGISTERED_AT=\"$DEREGISTERED_AT\""; } > "$tmp" ) \
        && mv "$tmp" "$STATE_FILE"
}
# stopped STEP-NAME REASON HOW-TO-GO-BACK — the one way this script ends on a failure.
stopped() {
    echo
    bad "MIGRATION STOPPED at \"$1\": $2"
    warn "Done so far: ${STEP:-nothing}. Old operator: ${OLD_OPERATOR:-?}. New operator: ${NEW_OPERATOR:-not deployed}."
    warn "To go on: fix the cause and run this script again; it continues from here."
    [ -n "${3:-}" ] && warn "To go back instead: $3"
    exit 1
}
plan_value() { python3 - "$PLAN_FILE" "$1" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
value = plan
for part in sys.argv[2].split('.'):
    value = value[part]
print(','.join(str(v) for v in value) if isinstance(value, list) else value)
PY
}
# set_operator FILE ADDRESS — every OPERATOR_ADDR line, its quoting kept.
set_operator() {
    python3 - "$1" "$2" <<'PY'
import os, re, stat, sys, tempfile
path, address = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
new, count = re.subn(r'(?m)^(\s*(?:export\s+)?OPERATOR_ADDR=)(["\']?)0x[0-9a-fA-F]{40}\2\s*$', lambda m: f'{m.group(1)}{m.group(2)}{address}{m.group(2)}', text)
if count == 0:
    sys.exit(3)
fd, tmp = tempfile.mkstemp(prefix='.operator-', dir=os.path.dirname(os.path.abspath(path)))
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(new)
os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
os.replace(tmp, path)
PY
}
operator_in() { python3 - "$1" <<'PY'
import re, sys
m = re.search(r'(?m)^\s*(?:export\s+)?OPERATOR_ADDR=["\']?(0x[0-9a-fA-F]{40})', open(sys.argv[1], encoding='utf-8').read())
print(m.group(1) if m else '')
PY
}
same_address() { [ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" ]; }

# The node's own job ids, from installer/.contracts.
NODE_JOB_IDS=()
while IFS= read -r id; do [ -n "$id" ] && NODE_JOB_IDS+=("$id"); done < <(
    grep -E '^JOB_ID(_[0-9]+)?_NO_HYPHENS=' "$CONTRACTS_FILE" | cut -d= -f2- | tr -d '"' | grep -oE '[a-f0-9]{32}' | awk '!seen[$0]++')

# This release's scripts and the key's environment, where the registration scripts keep theirs.
prepare_operator_dir() {
    mkdir -p "$OPERATOR_DIR/scripts/lib" || return 1
    cp "$REPO_ROOT/arbiter-operator/scripts/"*.js "$OPERATOR_DIR/scripts/" || return 1
    cp "$REPO_ROOT/arbiter-operator/scripts/lib/"*.js "$OPERATOR_DIR/scripts/lib/" || return 1
    cp "$UTIL_DIR/unregister-oracle.sh" "$TARGET_DIR/unregister-oracle.sh" && cp "$UTIL_DIR/register-oracle.sh" "$TARGET_DIR/register-oracle.sh" || return 1
    cp "$UTIL_DIR/job-template.cjs" "$UTIL_DIR/check-request-authorization.cjs" "$TARGET_DIR/" || return 1
    ( umask 077
      { echo "PRIVATE_KEY=$PRIVATE_KEY"
        [ -n "${INFURA_API_KEY:-}" ] && echo "INFURA_API_KEY=$INFURA_API_KEY"
        [ -n "${BASE_MAINNET_RPC_URL:-}" ] && echo "BASE_MAINNET_RPC_URL=$BASE_MAINNET_RPC_URL"
        [ -n "${BASE_MAINNET_RPC_HTTP_URLS:-}" ] && echo "BASE_MAINNET_RPC_HTTP_URLS=$BASE_MAINNET_RPC_HTTP_URLS"
        [ -n "${BASE_SEPOLIA_RPC_URL:-}" ] && echo "BASE_SEPOLIA_RPC_URL=$BASE_SEPOLIA_RPC_URL"
        [ -n "${BASE_SEPOLIA_RPC_HTTP_URLS:-}" ] && echo "BASE_SEPOLIA_RPC_HTTP_URLS=$BASE_SEPOLIA_RPC_HTTP_URLS"
        true; } > "$OPERATOR_DIR/.env" ) || return 1
    chmod 600 "$OPERATOR_DIR/.env"
    if [ ! -d "$OPERATOR_DIR/node_modules" ]; then
        ( cd "$OPERATOR_DIR" && npm install --legacy-peer-deps ) || return 1
    fi
}
migration_js() { ( cd "$OPERATOR_DIR" && HARDHAT_NETWORK="$DEPLOYMENT_NETWORK" node scripts/operator-migration.js "$@" ); }

echo
say "Verdikta Arbiter - operator contract migration"
say "Installation: $TARGET_DIR   Network: $DEPLOYMENT_NETWORK"

# ── 1. Plan ──────────────────────────────────────────────────────────────────
if [ -z "$STEP" ]; then
    MODE_RC=0
    MODE_JSON=$(REQUEST_AUTH_RPC_URLS="$RPC_URLS" node "$UTIL_DIR/job-template.cjs" mode --install-dir "$TARGET_DIR") || MODE_RC=$?
    if [ "$MODE_RC" -ne 0 ]; then
        bad "Could not tell which operator contract this node has. Nothing was changed."; exit 1
    fi
    case "$MODE_JSON" in
        *'"mode":"v1"'*)
            good "This node's operator contract ($OPERATOR_ADDR) already has request authorization: there is nothing to migrate."
            exit 0 ;;
        *'"mode":"legacy"'*) ;;
        *) bad "Could not read the operator's description. Nothing was changed."; exit 1 ;;
    esac
    OLD_OPERATOR="$OPERATOR_ADDR"
    if [ -z "${AGGREGATOR_ADDRESS:-}" ]; then
        bad "installer/.contracts names no aggregator (AGGREGATOR_ADDRESS). Nothing was changed."; exit 1
    fi
    if [ "${#NODE_JOB_IDS[@]}" -eq 0 ]; then
        bad "installer/.contracts names no job id. Nothing was changed."; exit 1
    fi

    say "Reading the chain (nothing is sent)..."
    prepare_operator_dir || { bad "Could not prepare $OPERATOR_DIR. Nothing was changed."; exit 1; }
    PLAN_TMP="$PLAN_FILE.tmp.$$"
    PLAN_RC=0
    migration_js plan --operator "$OLD_OPERATOR" --aggregator "$AGGREGATOR_ADDRESS" --wrappedverdikta "$WRAPPED_VERDIKTA_ADDRESS" \
        --jobids "${NODE_JOB_IDS[@]}" --out "$PLAN_TMP" || PLAN_RC=$?
    if [ ! -s "$PLAN_TMP" ]; then
        rm -f "$PLAN_TMP"; bad "The chain could not be read (exit $PLAN_RC). Nothing was changed."; exit 1
    fi
    mv "$PLAN_TMP" "$PLAN_FILE"; chmod 600 "$PLAN_FILE"
    python3 - "$PLAN_FILE" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(f"  Old operator contract : {p['operator']}  (owner {p['operatorOwner']})")
print(f"  Aggregator / keeper   : {p['aggregator']} / {p['keeper']}")
print(f"  Node keys to carry over: {len(p['senders'])}")
for g in p['groups']:
    print(f"  Registered: {len(g['jobIds'])} job(s) on classes [{g['classes']}] at {g['feeEth']} ETH")
print(f"  Stake: {p['refund']} wVDKA comes back, {p['stakeNeeded']} goes in again; the owner holds {p['tokenBalance']} now")
print(f"  Gas: up to {p['ethNeeded']} ETH at the current price; the owner holds {p['ethBalance']}")
print(f"  Wait after deregistration: {p['responseTimeoutSeconds']} s (the aggregator's response window) + 60 s")
for note in p['notes']:
    print(f"  Note: {note}")
for problem in p['problems']:
    print(f"  PROBLEM: {problem}")
PY
    if [ "$PLAN_RC" -ne 0 ]; then
        rm -f "$PLAN_FILE"; bad "The migration cannot run as things are (above). Nothing was changed."; exit 1
    fi

    # The jobs must already be this release's on the old contract: the same tool moves them.
    JOBS_RC=0
    REQUEST_AUTH_RPC_URLS="$RPC_URLS" VERDIKTA_OPERATOR_MODE_JSON="$MODE_JSON" node "$TARGET_DIR/job-template.cjs" check --install-dir "$TARGET_DIR" --wait 30 || JOBS_RC=$?
    if [ "$JOBS_RC" -ne 0 ]; then
        rm -f "$PLAN_FILE"
        bad "The node's jobs could not be measured, or are not this release's (exit $JOBS_RC): start the arbiter, or run upgrade-arbiter.sh first. Nothing was changed."
        exit 1
    fi

    if [ "$CHECK_ONLY" = "true" ]; then
        rm -f "$PLAN_FILE"; good "The migration can run. Nothing was changed (--check)."; exit 0
    fi
    echo
    warn "This deregisters the node's jobs, deploys a new operator contract and registers the same job ids on it."
    warn "The node answers nothing until it is done, and each job starts again with a new job's reputation."
    if ! ask_yes_no "Migrate this node to a new operator contract now?" "n" VA_MIGRATE_OPERATOR n; then
        rm -f "$PLAN_FILE"; warn "Not migrated. Nothing was changed."; exit 0
    fi

    say "Building the new operator contract from this checkout (nothing on chain yet)..."
    rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR/scripts" \
        && cp -r "$REPO_ROOT/arbiter-operator/contracts" "$BUILD_DIR/" && rm -rf "$BUILD_DIR/contracts/test" \
        && cp "$REPO_ROOT/arbiter-operator/hardhat.config.js" "$REPO_ROOT/arbiter-operator/package.json" "$REPO_ROOT/arbiter-operator/deployment-addresses.json" "$BUILD_DIR/" \
        && cp "$REPO_ROOT/arbiter-operator/scripts/deploy.js" "$BUILD_DIR/scripts/" \
        || { rm -f "$PLAN_FILE"; bad "Could not copy the contract sources to $BUILD_DIR. Nothing was changed."; exit 1; }
    [ -f "$REPO_ROOT/arbiter-operator/package-lock.json" ] && cp "$REPO_ROOT/arbiter-operator/package-lock.json" "$BUILD_DIR/"
    cp "$OPERATOR_DIR/.env" "$BUILD_DIR/.env" && chmod 600 "$BUILD_DIR/.env"
    if ! ( cd "$BUILD_DIR" && npm install --legacy-peer-deps && npx hardhat compile ); then
        rm -f "$PLAN_FILE" "$BUILD_DIR/.env"; bad "The contract did not build. Nothing was changed."; exit 1
    fi
    STEP="planned"; save_state || { bad "Could not write $STATE_FILE. Nothing was changed."; exit 1; }
else
    say "Continuing a migration that stopped after \"$STEP\" (old operator $OLD_OPERATOR${NEW_OPERATOR:+, new operator $NEW_OPERATOR})."
    if [ ! -s "$PLAN_FILE" ]; then
        bad "$PLAN_FILE is missing: it holds which jobs were registered, on which classes. Without it this script cannot go on."
        bad "Register by hand with $TARGET_DIR/register-oracle.sh, then remove $STATE_FILE."; exit 1
    fi
    if [ "$CHECK_ONLY" = "true" ]; then warn "--check: a migration is in progress; nothing was done."; exit 0; fi
    prepare_operator_dir || stopped "$STEP" "could not prepare $OPERATOR_DIR"
fi
AGGREGATOR="$(plan_value aggregator)"
SENDERS="$(plan_value senders)"
REGISTERED_COUNT=$(python3 -c 'import json,sys; print(sum(len(g["jobIds"]) for g in json.load(open(sys.argv[1]))["groups"]))' "$PLAN_FILE")
ALL_REGISTERED_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["jobs"]))' "$PLAN_FILE")
BACK_TO_OLD="run $TARGET_DIR/register-oracle.sh (the old operator and its jobs are untouched), then remove $STATE_FILE and $PLAN_FILE."

# ── 2. Deregister ────────────────────────────────────────────────────────────
if [ "$STEP" = "planned" ]; then
    if [ "$ALL_REGISTERED_COUNT" -gt 0 ]; then
        say "Step 2: deregistering every job id the keeper lists for $OLD_OPERATOR..."
        ( cd "$TARGET_DIR" && VA_DEREGISTER_ALL_REGISTERED=y VA_DEREGISTER_ORACLE=y VA_DEREGISTER_CONFIRM=y VA_AGGREGATOR_ADDRESS="$AGGREGATOR" \
            bash "$TARGET_DIR/unregister-oracle.sh" --unattended ) \
            || stopped "deregister" "unregister-oracle.sh failed; jobs it did not reach are still registered" "$BACK_TO_OLD"
    else
        say "Step 2: nothing is registered for $OLD_OPERATOR; nothing to deregister."
    fi
    STEP="deregistered"; DEREGISTERED_AT="$(date +%s)"; save_state
fi

# ── 3. Drain ─────────────────────────────────────────────────────────────────
if [ "$STEP" = "deregistered" ] && [ "$ALL_REGISTERED_COUNT" -gt 0 ]; then
    DRAIN="${VA_MIGRATE_DRAIN_SECONDS:-$(( $(plan_value responseTimeoutSeconds) + 60 ))}"
    case "$DRAIN" in ''|*[!0-9]*) DRAIN=360 ;; esac
    UNTIL=$(( ${DEREGISTERED_AT:-$(date +%s)} + DRAIN ))
    while :; do
        LEFT=$(( UNTIL - $(date +%s) ))
        [ "$LEFT" -gt 0 ] || break
        say "Step 3: waiting $LEFT s more for rounds this node was already selected for..."
        sleep "$(( LEFT > 30 ? 30 : LEFT ))"
    done
fi

# ── 4. Deploy, and authorize the node keys ───────────────────────────────────
if [ "$STEP" = "deregistered" ]; then
    if [ -z "$NEW_OPERATOR" ]; then
        say "Step 4: deploying the new operator contract..."
        [ -f "$BUILD_DIR/scripts/deploy.js" ] || stopped "deploy" "the build in $BUILD_DIR is gone; remove $STATE_FILE only after re-registering the old operator" "$BACK_TO_OLD"
        cp "$OPERATOR_DIR/.env" "$BUILD_DIR/.env" && chmod 600 "$BUILD_DIR/.env"
        DEPLOY_LOG="$BUILD_DIR/deploy_output.log"
        ( cd "$BUILD_DIR" && npx hardhat run scripts/deploy.js --network "$DEPLOYMENT_NETWORK" ) > "$DEPLOY_LOG" 2>&1 \
            || { cat "$DEPLOY_LOG"; stopped "deploy" "the deployment failed (above)" "$BACK_TO_OLD"; }
        cat "$DEPLOY_LOG"
        NEW_OPERATOR=$(grep 'ArbiterOperator deployed to' "$DEPLOY_LOG" | awk '{print $NF}' | tail -1)
        [[ "$NEW_OPERATOR" =~ ^0x[a-fA-F0-9]{40}$ ]] || { NEW_OPERATOR=""; stopped "deploy" "the deployment's output names no contract address; if a contract was deployed, its address is in the transaction above" "$BACK_TO_OLD"; }
        save_state
    fi
    migration_js deployed --new-operator "$NEW_OPERATOR" \
        || stopped "deploy" "the contract at $NEW_OPERATOR is not this release's operator owned by this key" "$BACK_TO_OLD"
    good "New operator contract: $NEW_OPERATOR"
    STEP="deployed"; save_state
fi
if [ "$STEP" = "deployed" ]; then
    say "Step 4: authorizing the node's keys on the new operator..."
    ( cd "$OPERATOR_DIR" && HARDHAT_NETWORK="$DEPLOYMENT_NETWORK" node scripts/setAuthorizedSenders.js --operator "$NEW_OPERATOR" --nodes "$SENDERS" ) \
        || stopped "authorize" "setAuthorizedSenders failed" "$BACK_TO_OLD"
    STEP="authorized"; save_state
fi

# ── 5. Repoint, restart ──────────────────────────────────────────────────────
BACKUP_SUFFIX="before-operator-migration"
if [ "$STEP" = "authorized" ]; then
    say "Step 5: pointing the node at $NEW_OPERATOR..."
    for file in "$CONTRACTS_FILE" "$ADAPTER_ENV" "$INSTALLER_DIR/.contracts"; do
        [ -f "$file" ] || continue
        same_address "$(operator_in "$file")" "$NEW_OPERATOR" && continue
        # This checkout's copy is changed only if it is this node's: it is what configure-node.sh reads.
        if [ "$file" = "$INSTALLER_DIR/.contracts" ] && ! same_address "$(operator_in "$file")" "$OLD_OPERATOR"; then continue; fi
        [ -f "$file.$BACKUP_SUFFIX" ] || cp -p "$file" "$file.$BACKUP_SUFFIX" || stopped "repoint" "could not back up $file"
        set_operator "$file" "$NEW_OPERATOR" || stopped "repoint" "could not set OPERATOR_ADDR in $file (its backup is $file.$BACKUP_SUFFIX)" \
            "restore each *.$BACKUP_SUFFIX file, restart the arbiter, then $BACK_TO_OLD"
        good "  $file"
    done
    if ! grep -q '^PREVIOUS_OPERATOR_ADDR=' "$CONTRACTS_FILE"; then echo "PREVIOUS_OPERATOR_ADDR=\"$OLD_OPERATOR\"" >> "$CONTRACTS_FILE"; fi
    STEP="repointed"; save_state
fi
AFTER_REPOINT="restore the *.$BACKUP_SUFFIX files beside installer/.contracts and external-adapter/.env, restart the arbiter, run 'node $TARGET_DIR/job-template.cjs apply --move-to-operator', then $BACK_TO_OLD"
if [ "$STEP" = "repointed" ]; then
    say "Step 5: restarting the arbiter (the adapter signs its commitments for the operator it starts with)..."
    ( cd "$TARGET_DIR" && bash "$TARGET_DIR/stop-arbiter.sh" ) || warn "stop-arbiter.sh reported a problem; starting anyway."
    ( cd "$TARGET_DIR" && bash "$TARGET_DIR/start-arbiter.sh" ) || stopped "restart" "start-arbiter.sh failed" "$AFTER_REPOINT"
    STEP="restarted"; save_state
fi

# ── 6. Jobs ──────────────────────────────────────────────────────────────────
if [ "$STEP" = "restarted" ]; then
    say "Step 6: moving each job, under its own id, to the new operator..."
    APPLY_RC=0
    REQUEST_AUTH_RPC_URLS="$RPC_URLS" VERDIKTA_OPERATOR_MODE_JSON='{"mode":"v1"}' \
        node "$TARGET_DIR/job-template.cjs" apply --install-dir "$TARGET_DIR" --move-to-operator --wait "${VERDIKTA_JOB_CHECK_WAIT:-240}" || APPLY_RC=$?
    [ "$APPLY_RC" -eq 0 ] || stopped "jobs" "the jobs were not all moved (job-template.cjs exit $APPLY_RC)" "$AFTER_REPOINT"
    CHECK_RC=0
    REQUEST_AUTH_RPC_URLS="$RPC_URLS" VERDIKTA_OPERATOR_MODE_JSON='{"mode":"v1"}' node "$TARGET_DIR/job-template.cjs" check --install-dir "$TARGET_DIR" || CHECK_RC=$?
    [ "$CHECK_RC" -eq 0 ] || stopped "jobs" "the node does not show this release's jobs on the new operator (exit $CHECK_RC)" "$AFTER_REPOINT"
    STEP="jobs"; save_state
fi

# ── 7. Register ──────────────────────────────────────────────────────────────
if [ "$STEP" = "jobs" ]; then
    GROUPS_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["groups"]))' "$PLAN_FILE")
    if [ "$GROUPS_COUNT" -eq 0 ]; then
        say "Step 7: no job of this node was registered; registering nothing."
    fi
    for (( g = 0; g < GROUPS_COUNT; g++ )); do
        CLASSES=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["groups"][int(sys.argv[2])]["classes"])' "$PLAN_FILE" "$g")
        FEE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["groups"][int(sys.argv[2])]["feeEth"])' "$PLAN_FILE" "$g")
        IDS=$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["groups"][int(sys.argv[2])]["jobIds"]))' "$PLAN_FILE" "$g")
        say "Step 7: registering $(echo "$IDS" | tr ',' '\n' | wc -l | tr -d ' ') job(s) on classes [$CLASSES] at $FEE ETH..."
        # Jobs are named only when they are not all of the node's: naming a subset marks the
        # registration as split (REGISTRATION_SPLIT), which is right exactly then.
        JOB_SELECTION=""
        if [ "$GROUPS_COUNT" -gt 1 ] || [ "$(echo "$IDS" | tr ',' '\n' | wc -l | tr -d ' ')" -lt "${#NODE_JOB_IDS[@]}" ] || [ "${REGISTRATION_SPLIT:-}" = "true" ]; then
            JOB_SELECTION="$IDS"
        fi
        ( cd "$TARGET_DIR" && VA_REGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS="$AGGREGATOR" VA_REGISTER_CONTINUE_IF_ALREADY=y VA_CLASS_IDS="$CLASSES" \
            VA_ORACLE_FEE_ETH="$FEE" VA_REGISTER_JOB_IDS="$JOB_SELECTION" bash "$TARGET_DIR/register-oracle.sh" --unattended ) \
            || stopped "register" "register-oracle.sh failed for classes [$CLASSES]; jobs already registered are skipped on the next run" \
               "there is no need to: the node is on the new operator, and only this registration is missing"
    done
    STEP="registered"; save_state
fi

# ── 8. Verify ────────────────────────────────────────────────────────────────
if [ "$STEP" = "registered" ]; then
    say "Step 8: verifying..."
    EXPECTED=()
    while IFS= read -r id; do [ -n "$id" ] && EXPECTED+=("$id"); done < <(python3 -c 'import json,sys; [print(i) for g in json.load(open(sys.argv[1]))["groups"] for i in g["jobIds"]]' "$PLAN_FILE")
    migration_js verify --operator "$OLD_OPERATOR" --new-operator "$NEW_OPERATOR" --aggregator "$AGGREGATOR" --senders "$SENDERS" \
        ${EXPECTED[@]+--jobids "${EXPECTED[@]}"} \
        || stopped "verify" "the end state does not hold (above)" "there is no need to: fix what is named and run this script again"
    DONE_AT="$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$PLAN_FILE" "$TARGET_DIR/installer/.operator-migration.done.$DONE_AT.json"
    rm -f "$STATE_FILE" "$BUILD_DIR/.env"
    echo
    good "Migration complete."
    good "  Operator contract : $NEW_OPERATOR (request authorization v1)"
    good "  Previous contract : $OLD_OPERATOR (PREVIOUS_OPERATOR_ADDR in installer/.contracts; nothing is registered on it)"
    good "  Jobs              : ${#NODE_JOB_IDS[@]}, the same job ids; $REGISTERED_COUNT registered as before"
    say "The record of what was registered is installer/.operator-migration.done.$DONE_AT.json."
    say "Check the node with: $TARGET_DIR/arbiter-doctor.sh"
fi
exit 0
