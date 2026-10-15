#!/bin/bash
# ai-node/build.sh makes the production build that start.sh serves with
# `next start`, and stamps it with a fingerprint of what it was built from.
# `--if-needed` (start.sh, install.sh) must rebuild exactly when the code,
# dependencies or Node changed — a stale build would serve old models.ts or an
# old @verdikta/common — and never for runtime-only changes (.env.local).
# Runs the real script against a stub `next` in a throwaway directory.
# Run: bash installer/tests/ai-node-build-fingerprint.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2], wanted [$3]"; fi; }

SLEEPER=""
T=$(mktemp -d); trap '[ -n "$SLEEPER" ] && kill "$SLEEPER" 2>/dev/null; rm -rf "$T"' EXIT
A="$T/ai-node"
mkdir -p "$A/src/config" "$A/node_modules/.bin" "$A/node_modules/@verdikta/common"
cp "$ROOT/ai-node/build.sh" "$A/"
echo '{"name":"stub"}' > "$A/package.json"
echo 'export const modelConfig = {};' > "$A/src/config/models.ts"
echo '{"version":"1.7.0"}' > "$A/node_modules/@verdikta/common/package.json"
echo '{"lockfileVersion":3}' > "$A/node_modules/.package-lock.json"
echo 'JUSTIFIER_MODEL=OpenAI:gpt-5-nano' > "$A/.env.local"
# Stub next: logs its arguments; FAKE_NEXT_FAIL=1 makes the build fail.
cat > "$A/node_modules/.bin/next" <<'EOF'
#!/bin/bash
echo "$*" >> "$(dirname "$0")/../../next-calls.log"
[ "${FAKE_NEXT_FAIL:-0}" = 1 ] && exit 1
mkdir -p .next && echo "id$RANDOM" > .next/BUILD_ID
EOF
chmod +x "$A/node_modules/.bin/next" "$A/build.sh"

calls() { wc -l < "$A/next-calls.log" 2>/dev/null | tr -d ' ' || echo 0; }
b() { HOME="$T" "$A/build.sh" "$@" >/dev/null 2>&1; echo $?; }
: > "$A/next-calls.log"

# 1. No build yet: --check says so, --if-needed builds.
eq "check without a build" "$(b --check)" 1
eq "if-needed builds" "$(b --if-needed)" 0
eq "next called once" "$(calls)" 1
grep -qx 'build --no-lint' "$A/next-calls.log" && ok || bad "lint not skipped by default: $(cat "$A/next-calls.log")"
[ -s "$A/.next/VERDIKTA_BUILD_FINGERPRINT" ] && ok || bad "no fingerprint stamp written"
[ -e "$A/.build-in-progress" ] && bad "lock left behind" || ok

# 2. Nothing changed: no rebuild; runtime-only and ignored files don't count.
eq "if-needed when current" "$(b --if-needed)" 0
eq "check when current" "$(b --check)" 0
echo 'LOG_LEVEL=debug' >> "$A/.env.local"
cp "$A/src/config/models.ts" "$A/src/config/models.ts.backup"
touch "$A/src/config/models.ts"
eq "env/backup/mtime changes need no build" "$(b --if-needed)$(calls)" 01

# 3. Each build input invalidates the stamp.
echo "  openai: [ { name: 'gpt-6' } ]," >> "$A/src/config/models.ts"
eq "models.ts change rebuilds" "$(b --check)$(b --if-needed)$(calls)" 102
echo '{"version":"1.8.0"}' > "$A/node_modules/@verdikta/common/package.json"
eq "@verdikta/common change rebuilds" "$(b --if-needed)$(calls)" 03
echo '{"lockfileVersion":3,"x":1}' > "$A/node_modules/.package-lock.json"
eq "dependency tree change rebuilds" "$(b --if-needed)$(calls)" 04
rm "$A/.next/BUILD_ID"   # what `next dev` does to a production .next
eq "missing BUILD_ID rebuilds" "$(b --if-needed)$(calls)" 05

# 4. Plain ./build.sh always builds; AI_NODE_BUILD_LINT=1 keeps lint.
AI_NODE_BUILD_LINT=1 b >/dev/null
eq "forced build" "$(calls)" 6
eq "lint kept on request" "$(tail -1 "$A/next-calls.log")" "build"

# 5. A failed build leaves no stamp, so the next start retries.
echo "// edit" >> "$A/src/config/models.ts"
eq "failed build exits 1" "$(FAKE_NEXT_FAIL=1 b --if-needed)" 1
[ -e "$A/.next/VERDIKTA_BUILD_FINGERPRINT" ] && bad "stamp kept after a failed build" || ok
eq "check after failure" "$(b --check)" 1

# 6. Refuses while the AI Node runs (next build rewrites .next under it) or
#    another build holds the lock; a dead pid in either file is ignored.
sleep 60 & SLEEPER=$!
echo "$SLEEPER" > "$A/ai-node.pid"
n=$(calls); eq "running AI Node" "$(b)" 2; eq "no build while running" "$(calls)" "$n"
echo 999999 > "$A/ai-node.pid"
echo "$SLEEPER" > "$A/.build-in-progress"
eq "concurrent build" "$(b)" 3; eq "no build while locked" "$(calls)" "$n"
echo 999999 > "$A/.build-in-progress"
eq "stale lock and pid ignored" "$(b --if-needed)" 0
[ -e "$A/.build-in-progress" ] && bad "stale lock not cleared" || ok
kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null; SLEEPER=""

echo "ai-node-build-fingerprint: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
