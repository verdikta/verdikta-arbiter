#!/bin/bash
# ai-node/start.sh binds loopback only when asked (2026-10-21 port audit: the
# AI Node listened on every interface with no authentication, in front of the
# operator's LLM keys). Two switches: AI_NODE_HOST in the environment, or the
# <install-dir>/.ai-node-loopback marker that arbiter-firewall.sh enable and a
# fresh install write. Neither = no -H flag, exactly as before. The marker
# lives outside ai-node/ so a component upgrade never removes it.
# Runs the real start.sh against stub npm/node/ps/build.sh. `ps` and `kill` are
# stubbed because start.sh terminates every next-server process it finds.
# Run: bash installer/tests/ai-node-loopback-bind.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
I="$T/install"; B="$T/bin"; H="$T/home"
mkdir -p "$I/ai-node" "$B" "$H"
cp "$ROOT/ai-node/start.sh" "$I/ai-node/start.sh"
printf '#!/bin/bash\nexit 0\n' > "$I/ai-node/build.sh"
printf '#!/bin/bash\nprintf "%%s\\n" "$*" > "%s/npm.args"\n' "$T" > "$B/npm"
printf '#!/bin/bash\necho v20.18.1\n' > "$B/node"
printf '#!/bin/bash\nexit 0\n' > "$B/ps"          # nothing to terminate
chmod +x "$I/ai-node"/*.sh "$B"/*

# start [ENV=VAL]... -> the arguments npm was started with (script output in $T/start.out)
start() {
    rm -f "$T/npm.args" "$I/ai-node/ai-node.pid"
    ( cd "$I/ai-node" && env -i HOME="$H" PATH="$B:/usr/bin:/bin" "$@" bash -c 'kill() { :; }; export -f kill; bash ./start.sh' > "$T/start.out" 2>&1 )
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$T/npm.args" ] && break; sleep 0.1; done
    cat "$T/npm.args" 2>/dev/null | tr -d '\n'
}

# 1. Neither switch: unchanged behaviour, no -H.
eq  "default"            "$(start)" "run start"
eq  "default: no message" "$(grep -c 'listens on' "$T/start.out")" 0

# 2. The marker (a file in the install dir, one level above ai-node/).
echo "AI Node binds 127.0.0.1" > "$I/.ai-node-loopback"
eq  "marker"             "$(start)" "run start -- -H 127.0.0.1"
has "marker: message"    "$(cat "$T/start.out")" "AI Node listens on 127.0.0.1 only"

# 3. AI_NODE_HOST wins over the marker (explicit override).
eq  "AI_NODE_HOST"       "$(start AI_NODE_HOST=0.0.0.0)" "run start -- -H 0.0.0.0"
rm -f "$I/.ai-node-loopback"
eq  "AI_NODE_HOST alone" "$(start AI_NODE_HOST=10.1.2.3)" "run start -- -H 10.1.2.3"
eq  "AI_NODE_HOST ipv6"  "$(start AI_NODE_HOST=::1)" "run start -- -H ::1"

# 4. A value that is not an address is ignored with a warning, never passed on.
eq  "bad AI_NODE_HOST"   "$(start 'AI_NODE_HOST=1.2.3.4; touch /tmp/pwned')" "run start"
has "bad AI_NODE_HOST: warning" "$(cat "$T/start.out")" "ignoring AI_NODE_HOST"

# 5. The dev fallback and AI_NODE_MODE=dev bind the same way.
echo x > "$I/.ai-node-loopback"
eq  "dev mode"           "$(start AI_NODE_MODE=dev)" "run dev -- -H 127.0.0.1"
printf '#!/bin/bash\nexit 1\n' > "$I/ai-node/build.sh"
eq  "dev-fallback"       "$(start)" "run dev -- -H 127.0.0.1"
has "dev-fallback: mode" "$(cat "$I/ai-node/.run-mode")" "dev-fallback"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
