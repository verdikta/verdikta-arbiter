#!/bin/bash
# update-rpc-endpoints.sh WRITES the installer/.env it finds, so its search must
# stay inside the tree the script runs from — issue #40: from the install root
# it looked one level above first, took a stray $HOME/installer/.env, and the
# installation's own .env (read by upgrade-arbiter.sh and the registration
# scripts) kept the old endpoints while the script reported success.
# Evaluates the script's real search block and save_env_var in each layout.
# Run: bash installer/tests/update-rpc-env-search.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/util/update-rpc-endpoints.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

search_block=$(awk '/^ENV_FILE=""$/{p=1} p{print} p&&/^done$/{exit}' "$SCRIPT")
save_fn=$(awk '/^save_env_var\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$SCRIPT")
[ -n "$search_block" ] || bad "could not extract the env search block"
[ -n "$save_fn" ] || bad "could not extract save_env_var"

# Resolve the way the script does, so /var -> /private/var (macOS) cannot fake a mismatch.
canon() { readlink -f "$1" 2>/dev/null || echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
# Prints the ENV_FILE the script's own search selects when it lives in $1.
find_env() { (cd / && SCRIPT_DIR="$1" bash -c "$search_block
printf '%s' \"\$ENV_FILE\""); }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
env_of() { mkdir -p "$(dirname "$1")"; printf 'DEPLOYMENT_NETWORK="base_sepolia"\nBASE_SEPOLIA_RPC_HTTP_URLS="%s"\n' "$2" > "$1"; }

# 1. Install root, with a stray installer/.env AND a stray .env one level above it.
INSTALL="$T/home/verdikta-arbiter-node"
env_of "$INSTALL/installer/.env" "https://old.example/real"
env_of "$T/home/installer/.env" "https://old.example/stray"
env_of "$T/home/.env" "https://old.example/home"
got=$(find_env "$INSTALL")
[ "$got" = "$(canon "$INSTALL/installer/.env")" ] && ok || bad "install root selected [$got]"

# 2. The install root's installer/util/ copy.
mkdir -p "$INSTALL/installer/util"
got=$(find_env "$INSTALL/installer/util")
[ "$got" = "$(canon "$INSTALL/installer/.env")" ] && ok || bad "installed installer/util selected [$got]"

# 3. The repo's installer/util/.
env_of "$T/repo/installer/.env" "https://old.example/repo"
mkdir -p "$T/repo/installer/util"
got=$(find_env "$T/repo/installer/util")
[ "$got" = "$(canon "$T/repo/installer/.env")" ] && ok || bad "repo installer/util selected [$got]"

# 4. Nothing in the script's own tree: the files above the root are NOT an answer.
BARE="$T/bare/verdikta-arbiter-node"
mkdir -p "$BARE"
env_of "$T/bare/installer/.env" "https://old.example/stray"
env_of "$T/bare/.env" "https://old.example/home"
got=$(find_env "$BARE")
[ -z "$got" ] && ok || bad "bare install root reached outside its tree: [$got]"

# 5. A symlinked installer/.env: the update lands in the link's target and the link survives.
LINKED="$T/linked/verdikta-arbiter-node"
env_of "$T/linked/secrets/arbiter.env" "https://old.example/target"
mkdir -p "$LINKED/installer"
ln -s "$T/linked/secrets/arbiter.env" "$LINKED/installer/.env"
got=$(find_env "$LINKED")
[ "$got" = "$(canon "$T/linked/secrets/arbiter.env")" ] && ok || bad "symlinked env resolved to [$got]"
bash -c "$save_fn
save_env_var BASE_SEPOLIA_RPC_HTTP_URLS 'https://new.example/a;https://new.example/b' \"\$1\"" _ "$got"
[ -L "$LINKED/installer/.env" ] && ok || bad "the installer/.env symlink was replaced by a regular file"
grep -q '^BASE_SEPOLIA_RPC_HTTP_URLS="https://new.example/a;https://new.example/b"$' "$T/linked/secrets/arbiter.env" \
    && ok || bad "the link's target did not receive the update"
[ "$(grep -c '^BASE_SEPOLIA_RPC_HTTP_URLS=' "$T/linked/secrets/arbiter.env")" = "1" ] && ok || bad "the old value was not replaced"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
