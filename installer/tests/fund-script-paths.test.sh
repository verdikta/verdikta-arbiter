#!/bin/bash
# fund-chainlink-keys.sh / recover-chainlink-funds.sh must find installer/.env and
# installer/.contracts from their INSTALLED location ($INSTALL_DIR/<script>) — issue #33.
# Evaluates each script's real POSSIBLE_LOCATIONS array with SCRIPT_DIR = the install dir
# and cwd elsewhere (so "$(pwd)/installer" cannot rescue it).
# Run: bash installer/tests/fund-script-paths.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
for script in fund-chainlink-keys.sh recover-chainlink-funds.sh; do
    T=$(mktemp -d); mkdir -p "$T/installer"
    : > "$T/installer/.env"; : > "$T/installer/.contracts"
    locations=$(awk '/^POSSIBLE_LOCATIONS=\(/{p=1} p{print} p&&/^\)/{exit}' "$ROOT/bin/$script")
    found=$(cd / && SCRIPT_DIR="$T" INSTALLER_DIR="$(dirname "$T")" bash -c "$locations
for location in \"\${POSSIBLE_LOCATIONS[@]}\"; do if [ -f \"\$location/.env\" ]; then echo \"\$location\"; break; fi; done")
    if [ "$found" = "$T/installer" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $script found [$found], wanted $T/installer"; fi
done
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
