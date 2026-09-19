#!/bin/bash
# create_installation_directory (setup-environment.sh) took VA_INSTALL_DIR
# literally: '$HOME/x' created a stray 'installer/$HOME/x' and an existing
# installation at ~/x was never detected or replaced (issue #57).
# Runs the REAL function with the real prompt library.
# Run: bash installer/tests/install-dir-expansion.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/setup-environment.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
funcs=$(awk '/^is_arbiter_installation\(\) \{/{p=1} /^create_installation_directory\(\) \{/{p=1} p{print} p && /^\}/{p=0}' "$S")
echo "$funcs" | grep -q '^create_installation_directory() {' && echo "$funcs" | grep -q '^is_arbiter_installation() {' && ok || bad "could not extract the functions"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
run() { # $1 = VA_INSTALL_DIR, $2 = VA_EXISTING_INSTALL_ACTION ('' = unset)
  rm -rf "$T/installer"; mkdir -p "$T/installer" "$T/home"
  ( cd "$T/installer" && export HOME="$T/home" INSTALLER_DIR="$T/installer" VERDIKTA_UNATTENDED=1 VA_INSTALL_DIR="$1" ${2:+VA_EXISTING_INSTALL_ACTION="$2"}
    source "$ROOT/lib/prompts.sh"; GREEN=; YELLOW=; BLUE=; RED=; NC=
    eval "$funcs"; create_installation_directory ) >"$T/out" 2>&1
  echo $?
}
# 1. '$HOME/x' lands in the real home; no literal directory; .env holds the absolute path.
rc=$(run '$HOME/verdikta-arbiter-node' '')
[ "$rc" = "0" ] && ok || bad "1: rc=$rc"
[ -d "$T/home/verdikta-arbiter-node/contracts" ] && ok || bad "1: not created under the real home"
[ ! -e "$T/installer/\$HOME" ] && ok || bad "1: a literal \$HOME directory was created under installer/"
grep -qxF "INSTALL_DIR=\"$T/home/verdikta-arbiter-node\"" "$T/installer/.env" && ok || bad "1: .env does not hold the absolute path: $(cat "$T/installer/.env")"
# 2. '~/x' too.
rm -rf "$T/home"; rc=$(run '~/x' '')
[ "$rc" = "0" ] && [ -d "$T/home/x/data" ] && ok || bad "2: ~/x not expanded (rc=$rc)"
# 3. An existing installation there + overwrite: removed and recreated.
rm -rf "$T/home"; mkdir -p "$T/home/verdikta-arbiter-node"
for f in start-arbiter.sh stop-arbiter.sh arbiter-status.sh old-marker; do : > "$T/home/verdikta-arbiter-node/$f"; done
rc=$(run '$HOME/verdikta-arbiter-node' overwrite)
[ "$rc" = "0" ] && ok || bad "3: rc=$rc"
grep -q 'contains an existing Verdikta arbiter installation' "$T/out" && ok || bad "3: the existing installation was not detected"
[ ! -e "$T/home/verdikta-arbiter-node/old-marker" ] && [ -d "$T/home/verdikta-arbiter-node/contracts" ] && ok || bad "3: the old installation was not removed and recreated"
# 4. Same, but cancel: exit 1 unattended, nothing removed.
rm -rf "$T/home"; mkdir -p "$T/home/verdikta-arbiter-node"
for f in start-arbiter.sh stop-arbiter.sh arbiter-status.sh old-marker; do : > "$T/home/verdikta-arbiter-node/$f"; done
rc=$(run '$HOME/verdikta-arbiter-node' cancel)
[ "$rc" = "1" ] && [ -e "$T/home/verdikta-arbiter-node/old-marker" ] && ok || bad "4: cancel should exit 1 and keep the installation (rc=$rc)"
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
