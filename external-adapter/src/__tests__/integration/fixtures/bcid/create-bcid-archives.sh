#!/bin/bash
# Rebuild the submitted-work (bCID) fixtures used by
#   src/__tests__/utils/bcidValidation.test.js
#   src/__tests__/handlers/evaluateHandler.malformedBcid.test.js
#
# They reproduce the archives a hunter pinned on Base mainnet on 2026-09-15
# (bounties 57/58/59 stranded 0/6 commits; bounty 60 was the conforming control):
#   bounty-primary.zip        the bounty's evaluation package (primary CID)
#   bcid-conforming.zip       what POST /jobs/:id/submit builds (control)
#   bcid-primary-not-json.zip primary.filename points at markdown      (bounty 59)
#   bcid-no-primary.zip       manifest has "files" but no "primary"    (bounty 58)
#   bcid-not-a-zip.zip        the markdown itself, no ZIP structure    (bounty 57)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
for name in bounty-primary bcid-conforming bcid-primary-not-json bcid-no-primary; do
  rm -f "$SCRIPT_DIR/$name.zip"
  (cd "$SCRIPT_DIR/$name" && zip -X -q -r "$SCRIPT_DIR/$name.zip" . -x '.*' '__MACOSX*')
  echo "created $name.zip"
done
cp "$SCRIPT_DIR/bcid-not-a-zip.md" "$SCRIPT_DIR/bcid-not-a-zip.zip"
echo "created bcid-not-a-zip.zip (deliberately not a ZIP)"
