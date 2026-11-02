#!/bin/bash
# The AI Node and the External Adapter pin @verdikta/common to one exact
# release (the stake-attestation prerelease 1.9.0-attest.1 carries the
# code-review gates, and the two must agree on it). install-adapter.sh used to
# run `npm install @verdikta/common@$VERDIKTA_COMMON_VERSION` (default latest)
# after `npm install`, and upgrade-arbiter.sh reinstalled @latest in the source
# checkout, so either replaced the pin with an older release. This test runs
# the REAL blocks of both scripts against a stub npm and checks that an exact
# pin is kept while a range still follows the preference, as before.
# Run: bash installer/tests/common-pin.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$ROOT/bin/install-adapter.sh"
UPGRADE="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/installer/util"
cp "$ROOT/util/common-pin.js" "$T/installer/util/"
# Stub npm: records every call, succeeds.
cat > "$T/bin/npm" <<'STUB'
#!/bin/bash
echo "npm $*" >> "$NPM_LOG"
exit 0
STUB
chmod +x "$T/bin/npm"

component() { # component DIR SPEC — a package.json pinning @verdikta/common to SPEC
    mkdir -p "$1"
    printf '{ "name": "c", "dependencies": { "@verdikta/common": "%s" } }\n' "$2" > "$1/package.json"
}

# --- the helper itself
for spec in 1.9.0-attest.1 1.8.0 2.0.0-rc.1+build.5; do
    component "$T/p" "$spec"
    out=$(node "$ROOT/util/common-pin.js" "$T/p"); rc=$?
    [ "$rc" = 0 ] && [ "$out" = "$spec" ] && ok || bad "common-pin: exact $spec → rc=$rc out=$out"
done
for spec in '^1.7.0' '~1.8.0' latest attest '>=1.8.0' '1.x' '1.9.0 || 1.8.0'; do
    component "$T/p" "$spec"
    node "$ROOT/util/common-pin.js" "$T/p" >/dev/null && bad "common-pin: range [$spec] counted as a pin" || ok
done
node "$ROOT/util/common-pin.js" "$T/none" >/dev/null && bad "common-pin: no package.json counted as a pin" || ok

# --- the same-version check: the AI Node, the adapter and the code runner pin one release
agree_repo() { # agree_repo DIR AI EA RUNNER (a spec of "-" leaves that component out)
    rm -rf "$1"; mkdir -p "$1"
    [ "$2" = - ] || component "$1/ai-node" "$2"
    [ "$3" = - ] || component "$1/external-adapter" "$3"
    [ "$4" = - ] || component "$1/code-runner" "$4"
}
agree_repo "$T/r" 1.9.0-attest.1 1.9.0-attest.1 1.9.0-attest.1
out=$(node "$ROOT/util/common-pin.js" --agree "$T/r"); rc=$?
[ "$rc" = 0 ] && [ "$out" = 1.9.0-attest.1 ] && ok || bad "agree: three equal pins → rc=$rc out=$out"
agree_repo "$T/r" 1.9.0-attest.1 1.9.0-attest.1 1.9.0-attest.2
out=$(node "$ROOT/util/common-pin.js" --agree "$T/r" 2>&1); rc=$?
[ "$rc" = 1 ] && ok || bad "agree: the code runner on another release passed (rc=$rc)"
has "agree: names the disagreeing component" "$out" "code-runner:1.9.0-attest.2"
agree_repo "$T/r" 1.9.0-attest.1 1.9.0-attest.1 '^1.9.0'
node "$ROOT/util/common-pin.js" --agree "$T/r" >/dev/null 2>&1 && bad "agree: a range in the code runner passed" || ok
agree_repo "$T/r" 1.9.0-attest.1 1.9.0-attest.1 -
node "$ROOT/util/common-pin.js" --agree "$T/r" >/dev/null 2>&1 && bad "agree: a missing code runner passed" || ok
# and the real repository agrees
out=$(node "$ROOT/util/common-pin.js" --agree "$ROOT/.."); rc=$?
[ "$rc" = 0 ] && ok || bad "agree: this repository's components disagree: $out"

# --- install-adapter.sh: the common-library block, from its header to the verify step
block=$(awk '/^# Install Verdikta Common Library$/{p=1} /^# Verify Verdikta Common installation/{p=0} p{print}' "$INSTALL")
[ -n "$block" ] && ok || bad "could not extract the common block from $INSTALL"
echo "$block" | grep -q 'common-pin.js' && ok || bad "install block does not consult common-pin.js"

run_install() { # run_install SPEC [VERDIKTA_COMMON_VERSION]
    component "$T/adapter" "$1"
    : > "$T/npm.log"
    PATH="$T/bin:$PATH" NPM_LOG="$T/npm.log" INSTALLER_DIR="$T/installer" ADAPTER_DIR="$T/adapter" \
    VERDIKTA_COMMON_VERSION="${2:-}" \
    bash -c '
        set -e
        GREEN= YELLOW= RED= BLUE= NC=
        [ -n "$VERDIKTA_COMMON_VERSION" ] || unset VERDIKTA_COMMON_VERSION
        cd "$ADAPTER_DIR"
        eval "$1"
        echo "REACHED-END"
    ' _ "$block" 2>&1
    echo "rc=$?"
    echo "NPM: $(cat "$T/npm.log")"
}

out=$(run_install 1.9.0-attest.1)
has   "install pinned: kept"            "$out" "pinned to 1.9.0-attest.1"
hasnt "install pinned: no latest"       "$out" "install @verdikta/common@latest"
hasnt "install pinned: no install"      "$out" "npm install @verdikta/common"
has   "install pinned: finished"        "$out" "REACHED-END"

out=$(run_install 1.9.0-attest.1 beta)
hasnt "install pinned, beta pref: kept" "$out" "npm install @verdikta/common"

out=$(run_install '^1.7.0')
has   "install range: follows latest"   "$out" "npm install @verdikta/common@latest"
has   "install range: finished"         "$out" "REACHED-END"

out=$(run_install '^1.7.0' beta)
has   "install range: follows the preference" "$out" "npm install @verdikta/common@beta"

# --- upgrade-arbiter.sh: the dev-folder reinstall, under errexit and the ERR trap
ublock=$(awk '/^# Force reinstall in DEV AI Node/{p=1} /^echo -e "\$\{GREEN\}@verdikta\/common force-reinstalled in dev folder/{p=0} p{print}' "$UPGRADE")
[ -n "$ublock" ] && ok || bad "could not extract the dev reinstall block from $UPGRADE"
[ "$(echo "$ublock" | grep -c 'node "$UTIL_DIR/common-pin.js"')" = 2 ] && ok || bad "upgrade block does not consult common-pin.js for both components"

run_upgrade() { # run_upgrade AI_SPEC EA_SPEC
    component "$T/repo/ai-node" "$1"
    component "$T/repo/external-adapter" "$2"
    : > "$T/npm.log"
    PATH="$T/bin:$PATH" NPM_LOG="$T/npm.log" UTIL_DIR="$T/installer/util" SCRIPT_DIR="$T" \
    REPO_AI_NODE="$T/repo/ai-node" REPO_EXTERNAL_ADAPTER="$T/repo/external-adapter" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$1"
        echo "REACHED-END"
    ' _ "$ublock" 2>&1
    echo "rc=$?"
    echo "NPM: $(cat "$T/npm.log" | tr '\n' ';')"
}

out=$(run_upgrade 1.9.0-attest.1 1.9.0-attest.1)
hasnt "upgrade pinned: no latest"        "$out" "@verdikta/common@latest"
hasnt "upgrade pinned: no uninstall"     "$out" "npm uninstall @verdikta/common"
has   "upgrade pinned: installs the pin" "$out" "npm install @verdikta/common@1.9.0-attest.1 --save-exact"
has   "upgrade pinned: finished"         "$out" "REACHED-END"
hasnt "upgrade pinned: trap"             "$out" "TRAP-FIRED"

out=$(run_upgrade '^1.7.0' '^1.7.0')
has   "upgrade range: reinstalls latest" "$out" "npm install @verdikta/common@latest"
has   "upgrade range: finished"          "$out" "REACHED-END"
hasnt "upgrade range: trap"              "$out" "TRAP-FIRED"

echo "common-pin: $pass passed, $fail failed"
[ "$fail" = 0 ]
