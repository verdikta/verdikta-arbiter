#!/bin/bash
#
# Verdikta Arbiter - Application Log Rotation (P2-A, July 2026 incident)
#
# The AI Node and External Adapter write timestamped nohup logs
# (ai-node/logs/ai-node_*.log, external-adapter/logs/adapter_*.log) plus
# ai-node/logs/llm-interactions.log, with no rotation. This tool bounds them:
#
#   1. Compress finished (not currently open) *.log files older than 1 day.
#   2. Delete compressed archives older than RETENTION_DAYS (default 14).
#   3. Copy-truncate any currently-open *.log larger than MAX_ACTIVE_MB
#      (default 200): the last TAIL_KEEP_LINES lines are preserved in a
#      .rotated file, then the live file is truncated to zero.
#      (Safe because the start scripts open logs in append mode.)
#
# Usage:
#   rotate-logs.sh                    # rotate now
#   rotate-logs.sh --dry-run          # show what would happen
#   rotate-logs.sh --install-cron     # install a daily 03:17 crontab entry
#   rotate-logs.sh --uninstall-cron
#
# Tunables (env): RETENTION_DAYS, MAX_ACTIVE_MB, TAIL_KEEP_LINES
#

set -o pipefail

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

RETENTION_DAYS="${RETENTION_DAYS:-14}"
MAX_ACTIVE_MB="${MAX_ACTIVE_MB:-200}"
TAIL_KEEP_LINES="${TAIL_KEEP_LINES:-5000}"
CRON_TAG="# verdikta-rotate-logs"

DRY_RUN=0
ACTION="rotate"
case "${1:-}" in
    --dry-run) DRY_RUN=1 ;;
    --install-cron) ACTION="install-cron" ;;
    --uninstall-cron) ACTION="uninstall-cron" ;;
    "") ;;
    -h|--help) sed -n '2,25p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

# Locate install dir (same strategy as arbiter-doctor.sh)
INSTALL_DIR=""
if [ -d "/root/verdikta-arbiter-node/ai-node" ]; then
    INSTALL_DIR="/root/verdikta-arbiter-node"
elif [ -d "$HOME/verdikta-arbiter-node/ai-node" ]; then
    INSTALL_DIR="$HOME/verdikta-arbiter-node"
else
    d="$SCRIPT_DIR"
    while [ "$d" != "/" ]; do
        if [ -d "$d/ai-node" ] && [ -d "$d/external-adapter" ]; then INSTALL_DIR="$d"; break; fi
        d="$(dirname "$d")"
    done
fi
if [ -z "$INSTALL_DIR" ]; then
    echo "ERROR: could not locate the arbiter install dir (expected ai-node/ + external-adapter/)" >&2
    exit 64
fi

if [ "$ACTION" = "install-cron" ]; then
    entry="17 3 * * * $SCRIPT_PATH $CRON_TAG"
    ( crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; echo "$entry" ) | crontab -
    echo "Installed daily log-rotation cron entry:"
    echo "  $entry"
    exit 0
fi
if [ "$ACTION" = "uninstall-cron" ]; then
    crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
    echo "Removed log-rotation cron entry (if present)."
    exit 0
fi

run() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] $*"
    else
        "$@"
    fi
}

file_open() {
    # Is any process holding this file open? Prefer lsof (portable semantics),
    # fall back to fuser.
    if command -v lsof >/dev/null 2>&1; then
        [ -n "$(lsof -t -- "$1" 2>/dev/null)" ]
        return $?
    fi
    if command -v fuser >/dev/null 2>&1; then
        fuser -s "$1" >/dev/null 2>&1
        return $?
    fi
    # Cannot tell — treat as open (never compress a possibly-live log).
    return 0
}

rotate_dir() {
    local dir="$1"
    [ -d "$dir" ] || return 0
    echo "Rotating: $dir"

    # 1. Compress finished logs older than 1 day
    local f
    while IFS= read -r f; do
        if file_open "$f"; then
            continue
        fi
        echo "  compress: $f ($(du -h "$f" | cut -f1))"
        run gzip -f "$f"
    done < <(find "$dir" -maxdepth 1 -name "*.log" -type f -mtime +0 2>/dev/null)

    # 2. Delete old archives
    while IFS= read -r f; do
        echo "  delete (>${RETENTION_DAYS}d): $f"
        run rm -f "$f"
    done < <(find "$dir" -maxdepth 1 \( -name "*.log.gz" -o -name "*.rotated-*" \) -type f -mtime "+$RETENTION_DAYS" 2>/dev/null)

    # 3. Copy-truncate oversized live logs
    while IFS= read -r f; do
        if ! file_open "$f"; then
            continue   # handled by the compress pass on its next -mtime match
        fi
        local keep="${f}.rotated-$(date +%Y%m%d-%H%M%S)"
        echo "  copy-truncate (> ${MAX_ACTIVE_MB}MB, live): $f -> $keep"
        if [ "$DRY_RUN" != "1" ]; then
            tail -n "$TAIL_KEEP_LINES" "$f" > "$keep" && gzip -f "$keep"
            truncate -s 0 "$f"
        fi
    done < <(find "$dir" -maxdepth 1 -name "*.log" -type f -size "+${MAX_ACTIVE_MB}M" 2>/dev/null)
}

rotate_dir "$INSTALL_DIR/ai-node/logs"
rotate_dir "$INSTALL_DIR/external-adapter/logs"

echo "Done."
