#!/bin/bash
# Builds the AI Node for production (`next build`); start.sh serves the result
# with `next start`.
#
# The build is stamped with a fingerprint of everything compiled into it:
# sources (including the ClassID-generated src/config/models.ts), Next/TS
# config, the installed dependency tree (@verdikta/common is bundled, so a
# library update needs a rebuild) and the Node version. `--if-needed` rebuilds
# only when one of those changed. .env.local is NOT part of it: server code
# reads it at runtime, so key / JUSTIFIER_MODEL / LOG_LEVEL changes need only
# a restart.
#
# Usage: ./build.sh              build now
#        ./build.sh --if-needed  build only if .next is missing or stale
#        ./build.sh --check      report whether .next is current; never builds
#
# Env:   AI_NODE_BUILD_LINT=1    also run ESLint (a development check; skipped
#                                by default to save time and memory)
#        NODE_OPTIONS            passed through to next build, e.g.
#                                --max-old-space-size=1536
#
# Exit:  0 built, or already current
#        1 build failed (or, with --check, the build is missing or stale)
#        2 the AI Node is running: next build rewrites .next under it; stop it first
#        3 another build is already running in this directory
cd "$(dirname "$0")"

MODE=build
case "${1:-}" in
    "") ;;
    --if-needed) MODE=if-needed ;;
    --check) MODE=check ;;
    -h|--help) sed -n '2,/^cd /p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 64 ;;
esac

# Load NVM if available (same Node as start.sh)
if [ -d "$HOME/.nvm" ]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm use 20.18.1 >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js is not available. Please install Node.js v20.18.0+ first."
    exit 1
fi
if [ ! -x node_modules/.bin/next ]; then
    echo "ERROR: node_modules/.bin/next not found. Run 'npm install' in $(pwd) first."
    exit 1
fi

export NEXT_TELEMETRY_DISABLED=1
STAMP=".next/VERDIKTA_BUILD_FINGERPRINT"
LOCK=".build-in-progress"

if command -v sha256sum >/dev/null 2>&1; then
    HASHER=(sha256sum)
else
    HASHER=(shasum -a 256)
fi

fingerprint() {
    local inputs=() f
    for f in src public package.json package-lock.json next.config.* tsconfig.json \
             instrumentation.ts postcss.config.* tailwind.config.* \
             node_modules/.package-lock.json node_modules/next/package.json \
             node_modules/@verdikta/common/package.json; do
        [ -e "$f" ] && inputs+=("$f")
    done
    {
        echo "node $(node --version)"
        find "${inputs[@]}" -type f ! -name '*.backup' ! -name '*.bak' ! -path '*/__tests__/*' -print0 \
            | LC_ALL=C sort -z | xargs -0 "${HASHER[@]}"
    } | "${HASHER[@]}" | cut -d' ' -f1
}

CURRENT=$(fingerprint)
if [ -f .next/BUILD_ID ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$CURRENT" ]; then
    [ "$MODE" = build ] || { echo "AI Node production build is up to date ($(cat .next/BUILD_ID))."; exit 0; }
elif [ "$MODE" = check ]; then
    if [ -f .next/BUILD_ID ]; then
        echo "AI Node production build is stale (sources or dependencies changed since it was built)."
    else
        echo "AI Node has no production build (.next/BUILD_ID missing)."
    fi
    exit 1
fi

if [ -f "$LOCK" ]; then
    other=$(cat "$LOCK" 2>/dev/null)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
        echo "ERROR: another AI Node build is already running (pid $other)."
        exit 3
    fi
    rm -f "$LOCK"
fi
if [ -f ai-node.pid ] && kill -0 "$(cat ai-node.pid)" 2>/dev/null; then
    echo "ERROR: the AI Node is running (pid $(cat ai-node.pid)); next build would replace .next under it."
    echo "Stop it first: $(pwd)/stop.sh"
    exit 2
fi

echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# next build peaks around 1.2 GB (killed every time under a 1 GB cap). Warn,
# do not refuse, when the box is short: start.sh then falls back to next dev.
if [ -r /proc/meminfo ]; then
    avail_mb=$(awk '/^MemAvailable:/{a=$2} /^SwapFree:/{s=$2} END{print int((a+s)/1024)}' /proc/meminfo)
    if [ "${avail_mb:-0}" -lt 1536 ]; then
        echo "WARNING: only ${avail_mb} MB of memory+swap available; next build needs about 1.5 GB."
        echo "         If it is killed, add swap (installer/docs/maintenance/upgrading.md, \"AI Node production build\")."
    fi
fi

ARGS=(build)
[ "${AI_NODE_BUILD_LINT:-0}" = "1" ] || ARGS+=(--no-lint)

echo "Building AI Node for production (next ${ARGS[*]}) in $(pwd)..."
started=$(date +%s)
rm -f "$STAMP"
if ! node_modules/.bin/next "${ARGS[@]}"; then
    echo "ERROR: AI Node production build failed after $(( $(date +%s) - started ))s."
    exit 1
fi
# Stamp what the build started from: a source edited mid-build makes the
# next --if-needed rebuild.
echo "$CURRENT" > "$STAMP"
echo "AI Node production build $(cat .next/BUILD_ID) finished in $(( $(date +%s) - started ))s."
