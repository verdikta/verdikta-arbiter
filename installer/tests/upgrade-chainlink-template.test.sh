#!/bin/bash
# An upgrade leaves the install with the checked-in Chainlink config template.
#
# upgrade-arbiter.sh replaces <install>/chainlink-node/ with the checkout's and then copies
# back what its preserve list names. Until 2026-11 that list said "*.toml". It was written on
# 2025-05-20 for the rendered job spec a single-arbiter install kept there
# (verdikta_job_spec.toml); config_template.toml was added three days later and matched it
# too. So every upgrade put the install's old template back over the new one, and an install
# kept the template of its first installation for good. Three things read the install's copy:
# the installed regenerate-chainlink-config.sh, the doctor's cfg.chainlink_template (it runs
# that script, and its hint is that script's --apply), and the installed
# update-rpc-endpoints.sh, which writes config.toml from it.
# Found on the class-5555 canaries on 2026-11-23, right after an upgrade had applied the
# checked-in template in full: the checkout's --check had nothing left, the installed one
# listed "[EVM.NodePool] SyncThreshold: 100 -> 10" against a template of 2026-09-10, and the
# doctor said "1 template setting(s) not applied". Its hint would have put back the value
# that made the fallback RPC flap (AGENTS.md §8).
#
# This runs the script's REAL upgrade_component and its REAL "Chainlink Node" call, under
# `set -e` and an ERR trap, on an install that holds an older copy of every file the checkout
# ships there, and then the REAL tools from the install root:
#   - every file the checkout ships in chainlink-node/ is byte-identical in the install;
#   - the installed regenerate-chainlink-config.sh --check and the checkout's say the same
#     about the same config.toml, and the doctor's REAL check_chainlink_template with them;
#   - the installed update-rpc-endpoints.sh writes the config.toml the checkout's writes;
#   - what the list was written for is still kept (the top-level rendered job spec), and the
#     rendered jobs still come from the checkout, where configure-node.sh writes them;
#   - no preserve list in the script names a file the repository ships.
# Run: bash installer/tests/upgrade-chainlink-template.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
TEMPLATE="$REPO/chainlink-node/config_template.toml"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()    { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
same()  { if cmp -s "$2" "$3"; then ok; else bad "$1: $2 differs from $3"; fi; }

# ── The real function, the real call, the doctor's real check ────────────────
fn=$(awk '/^upgrade_component\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
call=$(grep -E '^upgrade_component "\$REPO_CHAINLINK_NODE" "\$TARGET_CHAINLINK_NODE" ' "$S")
doctor_fn=$(awk '/^check_chainlink_template\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract upgrade_component from $S"
eq "one Chainlink Node call in $(basename "$S")" "$(printf '%s\n' "$call" | grep -c .)" "1"
[ -n "$doctor_fn" ] && ok || bad "could not extract check_chainlink_template from $DOCTOR"
# The tools the test runs from the install root are the ones an upgrade puts there.
for f in regenerate-chainlink-config.sh update-rpc-endpoints.sh; do
    grep -qE "^    $f \\\\\$" "$S" && ok || bad "$f is not in the upgrade's _util copy loop"
done
grep -q 'cp "\$INSTALLER_DIR/lib/"\*\.sh "\$TARGET_DIR/installer/lib/"' "$S" && ok || bad "the upgrade does not copy installer/lib to the install"

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
SRC="$T/checkout"; I="$T/install"; B="$T/bin"
mkdir -p "$SRC/chainlink-node" "$SRC/installer/util" "$SRC/installer/lib" "$I/installer/lib" "$B" "$T/cwd"

# docker: no container (the tools then read ~/.chainlink-<network>/config.toml), nothing running.
printf '#!/bin/bash\n[ "$1" = "ps" ] && exit 0\nexit 1\n' > "$B/docker"
chmod +x "$B/docker"

# ── A checkout: what the repository ships in chainlink-node/, and the tools ──
shipped=$(git -C "$REPO" ls-files -- chainlink-node 2>/dev/null | sed 's|^chainlink-node/||')
if [ -z "$shipped" ]; then          # not a git checkout: the files this test is about
    shipped=$(printf '%s\n' config_template.toml basicJobSpec README.md)
fi
has "the repository ships the template" "$shipped" '^config_template\.toml$'
while IFS= read -r f; do
    mkdir -p "$SRC/chainlink-node/$(dirname "$f")"
    cp "$REPO/chainlink-node/$f" "$SRC/chainlink-node/$f"
done <<< "$shipped"
cp "$ROOT/util/regenerate-chainlink-config.sh" "$ROOT/util/update-rpc-endpoints.sh" "$SRC/installer/util/"
cp "$ROOT/lib/chainlink-config.sh" "$ROOT/lib/prompts.sh" "$SRC/installer/lib/"
ENV_TEXT='NETWORK_TYPE="testnet"
DEPLOYMENT_NETWORK="base_sepolia"
NETWORK_NAME="Base Sepolia"
BASE_SEPOLIA_RPC_HTTP_URLS="http://127.0.0.1:9/old"
BASE_SEPOLIA_RPC_WS_URLS="ws://127.0.0.1:9/old"'
printf '%s\n' "$ENV_TEXT" > "$SRC/installer/.env"

# ── The template of an install made in September 2026 (16e1a6e), in what matters here:
# SyncThreshold 10, no FinalityDepth, no FinalizedBlockPollInterval, no MaxRunDuration.
stale_template() {
    sed -e 's/^SyncThreshold = .*/SyncThreshold = 10/' \
        -e '/^FinalityDepth = /d' -e '/^FinalizedBlockPollInterval = /d' \
        -e '/^\[JobPipeline\]$/d' -e '/^MaxRunDuration = /d' "$TEMPLATE"
}
stale_template > "$T/stale_template.toml"
cmp -s "$T/stale_template.toml" "$TEMPLATE" && bad "the old template this test builds is the checked-in one: nothing would be tested" || ok
grep -q '<EVM_NODES_BLOCK>' "$T/stale_template.toml" && ok || bad "the old template lost its nodes placeholder"
for k in 'SyncThreshold = 100' 'FinalityDepth = ' 'FinalizedBlockPollInterval = ' 'MaxRunDuration = '; do
    grep -q "^$k" "$TEMPLATE" && ok || bad "the checked-in template has no [$k]: update stale_template"
done

# render TEMPLATE -> a config.toml as setup-chainlink.sh writes it from TEMPLATE
render() {
    awk -v nodes='[[EVM.Nodes]]\nName="Base Sepolia-1"\nWSURL="wss://rpc.example.test/ws/KEY"\nHTTPURL="https://rpc.example.test/http/KEY"' '
        { gsub(/<CHAIN_ID>/, "84532"); gsub(/<TIP_CAP_DEFAULT>/, "2 gwei"); gsub(/<FEE_CAP_DEFAULT>/, "30 gwei") }
        /^<EVM_NODES_BLOCK>$/ { print nodes; next }
        { print }' "$1"
}

# ── An install made from an older checkout: an older copy of every shipped file, the
# old template, its own installer/.env, and two things only an install has.
old_install() {
    local f
    while IFS= read -r f; do
        mkdir -p "$I/chainlink-node/$(dirname "$f")"
        printf 'as an older checkout shipped %s\n' "$f" > "$I/chainlink-node/$f"
    done <<< "$shipped"
    cp "$T/stale_template.toml" "$I/chainlink-node/config_template.toml"
    mkdir -p "$I/chainlink-node/jobs"
    printf 'name = "arbiter 1, as first rendered"\n' > "$I/chainlink-node/jobs/verdikta_job_spec_arbiter_1.toml"
    # The single-arbiter era's rendered job spec (configure-node.sh until July 2025).
    printf 'name = "the one job of a 2025 install"\n' > "$I/chainlink-node/verdikta_job_spec.toml"
    printf '%s\n' "$ENV_TEXT" > "$I/installer/.env"
}

# run_upgrade CHECKOUT_CHAINLINK_NODE -> the real call, in an empty working directory
# (the function's patterns are globbed there too). upgrade_component empties the install's
# chainlink-node/: this refuses any path that is not inside this test's own directory.
run_upgrade() {
    case "$I" in "$T"/?*) ;; *) echo "refused: $I is not inside $T"; echo "rc=1"; return ;; esac
    REPO_CHAINLINK_NODE="$1" TARGET_CHAINLINK_NODE="$I/chainlink-node" bash -c '
        set -eu
        trap "echo TRAP-FIRED; exit 9" ERR
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$1"
        cd "$3"
        eval "$2"
        echo "REACHED-END"
    ' _ "$fn" "$call" "$T/cwd" 2>&1
    echo "rc=$?"
}

# The tools as the upgrade leaves them in the install root (its _util loop and lib copy).
install_tools() {
    cp "$ROOT/util/regenerate-chainlink-config.sh" "$ROOT/util/update-rpc-endpoints.sh" "$I/"
    cp "$ROOT/lib/chainlink-config.sh" "$ROOT/lib/prompts.sh" "$I/installer/lib/"
}
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
# check_installed HOME / check_checkout HOME -> --check's list and exit code, without the
# line that names the template's path (the one thing that differs between the two).
check_installed() { env HOME="$1" PATH="$B:$PATH" bash "$I/regenerate-chainlink-config.sh" --check 2>&1 | strip | grep -v 'compared with'; echo "rc=${PIPESTATUS[0]}"; }
check_checkout()  { env HOME="$1" PATH="$B:$PATH" bash "$SRC/installer/util/regenerate-chainlink-config.sh" --check --target-dir "$I" 2>&1 | strip | grep -v 'compared with'; echo "rc=${PIPESTATUS[0]}"; }
doctor() {
    env HOME="$1" PATH="$B:$PATH" INSTALL_DIR="$I" bash -c '
        emit() { printf "%s\t%s\t%s\t%s\n" "$@"; }
        eval "$1"
        check_chainlink_template
    ' _ "$doctor_fn" 2>&1
}
# rpc_update SCRIPT HOME -> the script, unattended, with two new endpoints nothing listens on.
rpc_update() {
    env HOME="$2" PATH="$B:$PATH" VA_RPC_HTTP_URLS="http://127.0.0.1:9/a;http://127.0.0.1:9/b" \
        VA_RPC_WS_URLS="ws://127.0.0.1:9/a;ws://127.0.0.1:9/b" VA_CONTINUE_ON_RPC_FAILURE=y \
        bash "$1" --unattended > "$2/update-rpc.out" 2>&1
    echo "rc=$?"
}
home() {   # home NAME CONFIG_TEXT -> a home whose ~/.chainlink-testnet/config.toml is CONFIG_TEXT
    mkdir -p "$T/$1/.chainlink-testnet"
    printf '%s\n' "$2" > "$T/$1/.chainlink-testnet/config.toml"
    echo "$T/$1"
}

# ── 1. A fresh checkout upgrades an install that holds the old template ──────
old_install
out=$(run_upgrade "$SRC/chainlink-node")
has   "upgrade: finished"   "$out" "REACHED-END"
hasnt "upgrade: no trap"    "$out" "TRAP-FIRED"
has   "upgrade: exit 0"     "$out" "rc=0"
same  "the install's template is the repository's" "$I/chainlink-node/config_template.toml" "$TEMPLATE"
while IFS= read -r f; do
    same "shipped file $f" "$I/chainlink-node/$f" "$SRC/chainlink-node/$f"
done <<< "$shipped"
# What "*.toml" was written for: the old top-level rendered job spec is still the install's.
eq "the 2025 rendered job spec is kept" "$(cat "$I/chainlink-node/verdikta_job_spec.toml" 2>/dev/null)" 'name = "the one job of a 2025 install"'

# ── 2. The installed tools now say what the checkout's say ───────────────────
install_tools
# (a) A node whose config.toml has every checked-in setting (the canaries on 2026-11-23,
#     where the installed --check listed "SyncThreshold: 100 -> 10" and the doctor warned).
H=$(home applied "$(render "$TEMPLATE")")
a=$(check_installed "$H"); b=$(check_checkout "$H")
has   "applied config: checkout has nothing left"  "$b" "rc=0"
has   "applied config: installed has nothing left" "$a" "rc=0"
hasnt "applied config: installed does not lower SyncThreshold" "$a" "SyncThreshold: 100 -> 10"
hasnt "applied config: FinalityDepth is not 'this node's own'"  "$a" "FinalityDepth: kept"
eq    "applied config: installed --check = checkout --check" "$a" "$b"
d=$(doctor "$H")
has   "applied config: doctor PASS" "$d" "^PASS	cfg.chainlink_template	config.toml has every template setting"
# (b) A node the template was never applied to: both list the same settings.
H=$(home never "$(render "$T/stale_template.toml")")
a=$(check_installed "$H"); b=$(check_checkout "$H")
has   "old config: checkout lists changes"  "$b" "rc=1"
has   "old config: SyncThreshold goes up"   "$b" "SyncThreshold: 10 -> 100"
eq    "old config: installed --check = checkout --check" "$a" "$b"
n=$(printf '%s\n' "$b" | grep -cE '^  \[.*: (added|removed|.* -> )')
d=$(doctor "$H")
has   "old config: doctor counts them" "$d" "^WARN	cfg.chainlink_template	$n template setting(s) not applied to config.toml"

# ── 3. update-rpc-endpoints.sh writes config.toml from the template it finds ─
H1=$(home rpc-installed "$(render "$TEMPLATE")"); H2=$(home rpc-checkout "$(render "$TEMPLATE")")
eq   "update-rpc (installed): exit 0" "$(rpc_update "$I/update-rpc-endpoints.sh" "$H1")" "rc=0"
eq   "update-rpc (checkout): exit 0"  "$(rpc_update "$SRC/installer/util/update-rpc-endpoints.sh" "$H2")" "rc=0"
same "update-rpc: the installed script writes the checkout's config.toml" "$H1/.chainlink-testnet/config.toml" "$H2/.chainlink-testnet/config.toml"
eq   "update-rpc: two RPC entries" "$(grep -c '^\[\[EVM.Nodes\]\]' "$H1/.chainlink-testnet/config.toml")" "2"
for k in 'SyncThreshold = 100' 'FinalityDepth = ' 'FinalizedBlockPollInterval = ' 'MaxRunDuration = '; do
    grep -q "^$k" "$H1/.chainlink-testnet/config.toml" && ok || bad "update-rpc from the install root wrote a config.toml without [$k]"
done

# ── 4. The rendered jobs come from the checkout, as before ───────────────────
# configure-node.sh renders them into the checkout's chainlink-node/jobs/ (git-ignored), and
# a regeneration during the upgrade leaves the new ones there: they must replace the install's.
old_install
mkdir -p "$SRC/chainlink-node/jobs"
printf 'name = "arbiter 1, regenerated"\n' > "$SRC/chainlink-node/jobs/verdikta_job_spec_arbiter_1.toml"
out=$(run_upgrade "$SRC/chainlink-node")
has  "with jobs: exit 0" "$out" "rc=0"
same "with jobs: the template is the repository's" "$I/chainlink-node/config_template.toml" "$TEMPLATE"
eq   "with jobs: the checkout's rendered job replaces the install's" \
     "$(cat "$I/chainlink-node/jobs/verdikta_job_spec_arbiter_1.toml" 2>/dev/null)" 'name = "arbiter 1, regenerated"'

# ── 5. No preserve list names a file the repository ships ───────────────────
# A preserved file is copied back over the checkout's, so a pattern that matches a shipped
# file freezes it at the version of the first install. Every upgrade_component call, against
# what git tracks at the top of that component.
frozen_files() {
    set -f      # the patterns are matched against names, never expanded against a directory
    local line var dir pats name p
    grep -E '^[[:space:]]*upgrade_component "\$REPO_[A-Z_]+" ' "$S" | while IFS= read -r line; do
        var=$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*upgrade_component "\$(REPO_[A-Z_]+)".*/\1/')
        dir=$(grep -E "^$var=\"\\\$REPO_ROOT/" "$S" | head -1 | sed -E 's/.*\$REPO_ROOT\/([^"]+)".*/\1/')
        pats=$(printf '%s\n' "$line" | sed -E 's/.*"([^"]*)"[[:space:]]*$/\1/')
        [ -n "$dir" ] || { echo "cannot tell which directory \$$var is"; continue; }
        for name in $(git -C "$REPO" ls-files -- "$dir" | sed "s|^$dir/||" | cut -d/ -f1 | sort -u); do
            for p in $pats; do
                # shellcheck disable=SC2254
                case "$name" in ($p) echo "$dir/$name is shipped and matches the preserve pattern '$p'" ;; esac
            done
        done
    done
}
if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    frozen=$(frozen_files)
    eq "no preserve pattern matches a shipped file" "$frozen" ""
    eq "every upgrade_component call was read" \
       "$(grep -cE '^[[:space:]]*upgrade_component "\$REPO_[A-Z_]+" ' "$S")" "$(grep -cE '^[[:space:]]*upgrade_component "' "$S")"
else
    echo "skip: not a git checkout, the shipped files of the other components were not listed"
fi

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
