#!/bin/bash
# Fresh installs no longer expose the database and the Chainlink UI (2026-10-21
# port review: 5432 and 6688 were published on every interface). setup-docker.sh creates cl-postgres WITHOUT a host port; setup-chainlink.sh
# points secrets.toml at cl-postgres:5432 (reached over verdikta-network by
# container name -- NOT host.docker.internal, which is the docker0 gateway, so a
# loopback-only publish of 5432 would cut Chainlink off from its database) and
# publishes 6688 on 127.0.0.1; install.sh marks the AI Node for a loopback bind
# and offers the firewall. Runs the real scripts against a stub docker.
# Run: bash installer/tests/fresh-install-binds.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
# A copy of the installer tree the scripts can source .env and lib/prompts.sh from.
mkdir -p "$T/installer/bin" "$T/installer/lib" "$T/installer/config" "$T/installer/util" "$T/chainlink-node" "$T/bin" "$T/home" "$T/install"
cp "$ROOT/bin/setup-docker.sh" "$ROOT/bin/setup-chainlink.sh" "$T/installer/bin/"
cp "$ROOT/lib/prompts.sh" "$T/installer/lib/"
cp "$ROOT/util/docker-pull-helper.sh" "$T/installer/util/"
cp "$ROOT/../chainlink-node/config_template.toml" "$T/chainlink-node/" 2>/dev/null || echo 'ChainID = "<CHAIN_ID>"' > "$T/chainlink-node/config_template.toml"
cat > "$T/installer/.env" <<EOF
INSTALL_DIR="$T/install"
NETWORK_TYPE="testnet"
NETWORK_NAME="Base Sepolia"
DEPLOYMENT_NETWORK="base_sepolia"
BASE_SEPOLIA_RPC_HTTP_URLS="https://rpc.example/v1/key"
BASE_SEPOLIA_RPC_WS_URLS="wss://rpc.example/ws/key"
EOF
echo 'INFURA_API_KEY=""' > "$T/installer/.api_keys"
echo 'POSTGRES_PASSWORD="pgpass123"' > "$T/installer/.postgres"

# Fake docker: daemon up, nothing exists yet, everything else succeeds; every call is logged.
cat > "$T/bin/docker" <<EOF
#!/bin/bash
echo "\$*" >> "$T/docker.calls"
case "\$*" in
  "info") exit 0 ;;
  "network inspect"*) exit 1 ;;
  "ps -q --filter"*) echo abc123 ;;
esac
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$T/bin/curl"
printf '#!/bin/bash\nexit 0\n' > "$T/bin/sleep"
chmod +x "$T/bin"/*

runit() {  # script name
    ( cd "$T" && env HOME="$T/home" PATH="$T/bin:$PATH" VERDIKTA_UNATTENDED=1 bash "$T/installer/bin/$1" </dev/null >"$T/$1.out" 2>&1 )
}

# 1. setup-docker.sh: cl-postgres has no host port; the compose file matches.
runit setup-docker.sh; rc=$?
[ "$rc" = 0 ] && ok || bad "setup-docker.sh exit $rc: $(tail -5 "$T/setup-docker.sh.out")"
pg_run=$(grep '^run --name cl-postgres' "$T/docker.calls")
[ -n "$pg_run" ] && ok || bad "no 'docker run --name cl-postgres' call: $(cat "$T/docker.calls")"
hasnt "cl-postgres: no host port" "$pg_run" " -p "
hasnt "cl-postgres: no 5432" "$pg_run" "5432"
has   "cl-postgres: restart policy kept" "$pg_run" "--restart unless-stopped"
has   "cl-postgres: log options kept" "$pg_run" "--log-opt max-size=100m"
has   "cl-postgres joins verdikta-network" "$(cat "$T/docker.calls")" "network connect verdikta-network cl-postgres"
compose="$T/install/docker/docker-compose.yml"
[ -f "$compose" ] && ok || bad "compose file not written"
hasnt "compose: 5432 not published" "$(cat "$compose")" "5432:5432"
has   "compose: chainlink on loopback" "$(cat "$compose")" '"127.0.0.1:6688:6688"'
hasnt "compose: no public 6688" "$(cat "$compose")" '"6688:6688"'

# 2. setup-chainlink.sh: loopback publish, database by container name.
: > "$T/docker.calls"
runit setup-chainlink.sh; rc=$?
[ "$rc" = 0 ] && ok || bad "setup-chainlink.sh exit $rc: $(tail -8 "$T/setup-chainlink.sh.out")"
cl_run=$(grep '^run .*--name chainlink' "$T/docker.calls")
[ -n "$cl_run" ] && ok || bad "no 'docker run --name chainlink' call: $(cat "$T/docker.calls")"
has   "chainlink: 6688 on loopback" "$cl_run" " -p 127.0.0.1:6688:6688 "
hasnt "chainlink: no public 6688"   "$cl_run" " -p 6688:6688"
has   "chainlink: network kept"     "$cl_run" "--network verdikta-network"
has   "chainlink: restart policy kept" "$cl_run" "--restart unless-stopped"
has   "chainlink: add-host kept"    "$cl_run" "--add-host=host.docker.internal:host-gateway"
secrets="$T/home/.chainlink-testnet/secrets.toml"
[ -f "$secrets" ] && ok || bad "secrets.toml not written at $secrets"
has   "secrets: database by container name" "$(cat "$secrets")" "@cl-postgres:5432/postgres"
hasnt "secrets: not host.docker.internal"  "$(cat "$secrets")" "host.docker.internal"
# setup-docker.sh (run above) generated the database password and wrote it to .postgres
pgpass=$(. "$T/installer/.postgres"; echo "$POSTGRES_PASSWORD")
{ [ -n "$pgpass" ] && grep -q "postgres:$pgpass@cl-postgres" "$secrets"; } && ok || bad "secrets.toml does not carry the password from .postgres"

# 3. The pieces that are too heavy to run: install.sh and install-adapter.sh.
inst=$(cat "$ROOT/bin/install.sh")
has   "install.sh: marker written"   "$inst" 'echo "AI Node binds 127.0.0.1 (fresh install default'
has   "install.sh: marker path"      "$inst" '> "$INSTALL_DIR/.ai-node-loopback"'
has   "install.sh: copies the firewall script" "$inst" 'for _hardening in arbiter-firewall.sh apply-chainlink-loopback.sh'
has   "install.sh: firewall offer, unattended default y" "$inst" 'VA_INSTALL_FIREWALL y'
has   "install.sh: reads the exit code with ||" "$inst" 'arbiter-firewall.sh" enable || FIREWALL_RC=\$?'
adapter=$(cat "$ROOT/bin/install-adapter.sh")
has   "install-adapter.sh: 127.0.0.1" "$adapter" 'AI_NODE_URL=http://127.0.0.1:3000'
hasnt "install-adapter.sh: no localhost URL" "$adapter" 'AI_NODE_URL=http://localhost:3000'
# the throwaway AI Node starts of install phases 3 and 4 are loopback too, not just the final one
has   "install-ai-node.sh: test start on loopback" "$(cat "$ROOT/bin/install-ai-node.sh")" 'npm run start -- -H 127.0.0.1 &'
has   "install-adapter.sh: test start on loopback" "$adapter" 'AI_NODE_HOST=127.0.0.1 ./start.sh'
# the marker line comes before the first start of any service in install.sh
m=$(grep -n '\.ai-node-loopback"' "$ROOT/bin/install.sh" | head -1 | cut -d: -f1)
s=$(grep -n '^    "\$INSTALL_DIR/start-arbiter.sh"$' "$ROOT/bin/install.sh" | head -1 | cut -d: -f1)
{ [ -n "$m" ] && [ -n "$s" ] && [ "$m" -lt "$s" ]; } && ok || bad "marker (line ${m:-?}) is not written before start-arbiter.sh runs (line ${s:-?})"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
