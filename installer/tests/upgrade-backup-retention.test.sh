#!/bin/bash
# upgrade-arbiter.sh copies the whole installation aside on every upgrade
# (~1.8 GB) and nothing removed the copies — issue #47. After a NEW backup
# succeeds it now keeps the newest N (default 3; --keep-backups N /
# VA_UPGRADE_BACKUP_KEEP; 0 keeps all) and removes older ones — only
# directories named <install>_backup_YYYYMMDD-HHMMSS, never a symlink, a file
# or a copy the operator named by hand.
# Runs the script's real functions against fake backup directories.
# Run: bash installer/tests/upgrade-backup-retention.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2], wanted [$3]"; fi; }

fn() { awk -v name="$1" '$0 ~ "^"name"\\(\\) \\{$" {p=1} p{print} p&&/^}$/{exit}' "$S"; }
FUNCS="$(grep -E '^BACKUP_KEEP_DEFAULT=' "$S")
$(fn resolve_backup_keep)
$(fn list_install_backups)
$(fn prune_old_backups)"
[ -n "$(fn prune_old_backups)" ] && [ -n "$(fn list_install_backups)" ] && [ -n "$(fn resolve_backup_keep)" ] && ok || bad "could not extract the retention functions"

# run KEEP_FLAG VA_KEEP ANSWER(0=yes 1=no) DIR NEW_BACKUP_DIR -> output of prune_old_backups
run() {
    KEEP_BACKUPS_FLAG="$1" VA_UPGRADE_BACKUP_KEEP="$2" ANSWER="$3" bash -c '
GREEN=""; YELLOW=""; RED=""; BLUE=""; NC=""
ask_yes_no() { echo "ASKED: $1"; return "$ANSWER"; }
'"$FUNCS"'
BACKUP_DIR="$2"
prune_old_backups "$1" "$(resolve_backup_keep)"' _ "$4" "$5" 2>&1
}
mk() { # mk ROOT -> an install with five timestamped backups + things that are NOT ours
    local r="$1"; mkdir -p "$r/node"
    for ts in 20260915-095513 20260915-170243 20260916-140652 20260916-211428 20260917-102755; do
        mkdir -p "$r/node_backup_$ts/installer"; echo "x" > "$r/node_backup_$ts/installer/.env"
    done
    mkdir -p "$r/node_backup_manual" "$r/node_backup_20260101" "$r/other_backup_20260101-000000" "$r/elsewhere/real"
    echo keep > "$r/elsewhere/real/file"
    ln -s "$r/elsewhere/real" "$r/node_backup_20250101-000000"      # a SYMLINK with a matching name
    : > "$r/node_backup_20250202-000000"                             # a FILE with a matching name
}
left() { (cd "$1" && ls -d node_backup_2026* 2>/dev/null | tr '\n' ' '); }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# 1. Default: newest 3 kept, the two oldest removed, the rest of the directory untouched.
mk "$T/a"; out=$(run "" "" 0 "$T/a/node" "$T/a/node_backup_20260917-102755")
eq "default keeps the newest 3" "$(left "$T/a")" "node_backup_20260101 node_backup_20260916-140652 node_backup_20260916-211428 node_backup_20260917-102755 "
echo "$out" | grep -q 'ASKED: Remove these 2 older backup(s)?' && ok || bad "did not ask before removing: $out"
echo "$out" | grep -q "Removed old backup: $T/a/node_backup_20260915-095513" && ok || bad "did not say what it removed"
[ -d "$T/a/node_backup_manual" ] && [ -d "$T/a/other_backup_20260101-000000" ] && ok || bad "removed a directory that is not an install backup"
[ -L "$T/a/node_backup_20250101-000000" ] && [ -f "$T/a/elsewhere/real/file" ] && ok || bad "touched a symlink with a matching name (or its target)"
[ -f "$T/a/node_backup_20250202-000000" ] && ok || bad "removed a plain file with a matching name"
[ -d "$T/a/node" ] && ok || bad "removed the installation itself"

# 2. The operator says no: nothing is removed.
mk "$T/b"; out=$(run "" "" 1 "$T/b/node" "$T/b/node_backup_20260917-102755")
eq "a declined prompt removes nothing" "$(ls -d "$T/b"/node_backup_2026*-* | wc -l | tr -d ' ')" "5"
echo "$out" | grep -q 'Older backups kept' && ok || bad "declined prune not reported"

# 3. N from the answer key, from the flag (flag wins), 1, and more than exist.
mk "$T/c"; run "" "1" 0 "$T/c/node" "$T/c/node_backup_20260917-102755" >/dev/null
eq "VA_UPGRADE_BACKUP_KEEP=1 keeps only the newest" "$(ls -d "$T/c"/node_backup_2026*-* | xargs -n1 basename | tr '\n' ' ')" "node_backup_20260917-102755 "
mk "$T/d"; run "4" "1" 0 "$T/d/node" "$T/d/node_backup_20260917-102755" >/dev/null
eq "--keep-backups wins over the answer key" "$(ls -d "$T/d"/node_backup_2026*-* | wc -l | tr -d ' ')" "4"
mk "$T/e"; out=$(run "9" "" 0 "$T/e/node" "$T/e/node_backup_20260917-102755")
eq "keeping more than exist removes nothing" "$(ls -d "$T/e"/node_backup_2026*-* | wc -l | tr -d ' ')" "5"
echo "$out" | grep -q 'ASKED' && bad "asked although there was nothing to remove" || ok

# 4. 0 keeps everything; a non-number falls back to 3 with a warning (never prunes on a guess).
mk "$T/f"; out=$(run "0" "" 0 "$T/f/node" "$T/f/node_backup_20260917-102755")
eq "0 keeps them all" "$(ls -d "$T/f"/node_backup_2026*-* | wc -l | tr -d ' ')" "5"
echo "$out" | grep -q 'retention is 0 = off' && ok || bad "retention off not reported"
mk "$T/g"; out=$(run "" "lots" 0 "$T/g/node" "$T/g/node_backup_20260917-102755")
eq "a non-number falls back to 3" "$(ls -d "$T/g"/node_backup_2026*-* | wc -l | tr -d ' ')" "3"
echo "$out" | grep -q "Ignoring backup retention 'lots'" && ok || bad "bad retention value not reported: $out"

# 5. The backup just made is never removed, even if the clock ran backwards and it sorts oldest.
mk "$T/h"; run "" "1" 0 "$T/h/node" "$T/h/node_backup_20260915-095513" >/dev/null
[ -d "$T/h/node_backup_20260915-095513" ] && ok || bad "removed the backup that was just made"

# 6. A trailing slash on the install dir and a path with a space behave the same.
mk "$T/i i"; run "" "2" 0 "$T/i i/node/" "$T/i i/node_backup_20260917-102755" >/dev/null
eq "spaces and a trailing slash" "$(ls -d "$T/i i"/node_backup_2026*-* | wc -l | tr -d ' ')" "2"

# 7. Wiring: pruning happens only after create_backup succeeded, never on the no-backup path.
awk '/create_backup "\$TARGET_DIR"/{p=1} p{print} /BACKUP_DIR=""  # Clear backup directory/{exit}' "$S" > "$T/callsite"
grep -n 'exit 1' "$T/callsite" | head -1 | cut -d: -f1 > "$T/l_exit"; grep -n 'prune_old_backups "\$TARGET_DIR" "\$(resolve_backup_keep)"' "$T/callsite" | cut -d: -f1 > "$T/l_prune"; grep -n '^else' "$T/callsite" | head -1 | cut -d: -f1 > "$T/l_else"
if [ -s "$T/l_prune" ] && [ "$(cat "$T/l_exit")" -lt "$(cat "$T/l_prune")" ] && [ "$(cat "$T/l_prune")" -lt "$(cat "$T/l_else")" ]; then ok; else bad "prune_old_backups is not called right after a successful create_backup"; fi
eq "prune_old_backups has exactly one call site" "$(grep -c '^\s*prune_old_backups ' "$S")" "1"
bash "$S" --help 2>/dev/null | grep -q -- '--keep-backups N' && ok || bad "--help does not document --keep-backups"

# 8. The answers validator knows the key's shape.
V="$ROOT/bin/validate-answers.sh"
( export VERDIKTA_UNATTENDED=1 VA_UPGRADE_BACKUP_KEEP=5; bash "$V" upgrade >/dev/null 2>&1 ) && ok || bad "validator rejected VA_UPGRADE_BACKUP_KEEP=5"
( export VERDIKTA_UNATTENDED=1 VA_UPGRADE_BACKUP_KEEP=many; bash "$V" upgrade >/dev/null 2>&1 ) && bad "validator accepted VA_UPGRADE_BACKUP_KEEP=many" || ok

# 9. The doctor reports the backups (INFO up to 5, WARN above).
doc=$(awk '/# Install backups left by upgrade-arbiter.sh/{p=1} p{print} p&&/^    fi$/{n++} n==2{exit}' "$DOCTOR")
[ -n "$doc" ] && ok || bad "could not extract the doctor's install-backups block"
doctor_says() { INSTALL_DIR="$1" bash -c 'emit() { echo "$1 $2 $3"; }
f() {
'"$doc"'
}; f' 2>&1; }
mk "$T/j"; eq "doctor: 5 backups are INFO" "$(doctor_says "$T/j/node" | cut -d' ' -f1-3)" "INFO svc.install_backups 5"
mkdir -p "$T/j/node_backup_20260918-000000"
eq "doctor: 6 backups are WARN" "$(doctor_says "$T/j/node" | cut -d' ' -f1-3)" "WARN svc.install_backups 6"
mkdir -p "$T/k/node"; eq "doctor: no backups, no finding" "$(doctor_says "$T/k/node")" ""

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
