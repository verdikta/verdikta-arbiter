#!/usr/bin/env bash
# Is any key in these files? Prints file names and a count, never a value (node A7d). The values go to grep on its stdin,
# so they are in no process's arguments.
#
#   jury-check-no-keys.sh <key file> <path>...
#
# Exit 0: none found. 1: found, with the files named. 2: the key file gave nothing to look for. 3: a path could not be read,
# so nothing is known.
set -uo pipefail
set +x
KEY_FILE=$1
shift
patterns=$(mktemp)
chmod 600 "$patterns"
trap 'rm -f "$patterns"' EXIT
(
  set -a
  # shellcheck disable=SC1090
  . "$KEY_FILE"
  set +a
  for name in $(grep -oE '^(export )?[A-Z_][A-Z0-9_]*=' "$KEY_FILE" | sed -e 's/^export //' -e 's/=$//'); do
    printenv "$name"
  done
) | grep -v '^$' > "$patterns"
count=$(wc -l < "$patterns")
[ "$count" -gt 0 ] || { echo "jury-check-no-keys: the key file gave no values"; exit 2; }
for path in "$@"; do
  [ -e "$path" ] || { echo "jury-check-no-keys: $path does not exist, so nothing is known"; exit 3; }
done
code=0
found=$(grep -rlF -f "$patterns" -- "$@") || code=$?
if [ -n "$found" ]; then
  echo "jury-check-no-keys: a key value is in:"
  echo "$found"
  exit 1
fi
if [ "$code" -gt 1 ]; then
  echo "jury-check-no-keys: the scan failed (grep exit $code), so nothing is known"
  exit 3
fi
echo "jury-check-no-keys: none of the $count key value(s) is in the files given"
