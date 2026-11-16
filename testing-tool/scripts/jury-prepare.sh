#!/usr/bin/env bash
# The runner's half of a real-jury measurement (node A7d; README "A paid run"): every listing through the real runner,
# once each, then the scenario folders the jury reads. No provider, no key, no spend.
#
#   CODE_RUNNER_RUNTIME=runc|runsc jury-prepare.sh <work dir> [listing...]
#
# <work dir>/repo holds this repository, <work dir>/node/bin the Node to use. Everything this writes stays under
# <work dir>: results/ (what each listing's cases did; no pack text), exports/, claims/ and the caches. The packs in
# exports/ and claims/ hold third-party source, and do not leave the machine.
#
# Each listing is its own run, since an export holds one run's scenarios and a run that disagrees leaves none: a
# disagreement costs that listing, not the set. A listing that agreed is not run again while the runtime and what decides
# its evidence (the runner, the harness, the corpus) are the ones it ran on, so this resumes, and nothing older is mixed
# in. `prepared/` holds that. Exit 0 when every listing agreed; 1 otherwise, with claims/ not written.
#
# Naming listings runs those only, and lets several of these run at once, each with its own temporary directory, which is
# how a box with CPUs to spare gets through the set. Keep listings on one repository in one process: they share a fetch in
# the cache. claims/ is written by whichever finds every listing done.
#
# SLOW_HOST=1 passes --slow-host: see code-runner/calibration/run.js. The results files name each listing it let through. A
# listing prepared that way counts as done only with SLOW_HOST set, so a stricter run does not reuse it.
set -uo pipefail
set +x

WORK=$(cd "$1" && pwd)
shift
RUNTIME=${CODE_RUNNER_RUNTIME:?set CODE_RUNNER_RUNTIME to runc or runsc}
NODE="$WORK/node/bin/node"
CALIBRATION="$WORK/repo/code-runner/calibration/run.js"
# The one control the jury reads: its case's whole question is whether the injected text moved the verdict.
JURY_CONTROLS=" adversarial.injected-critical.control "

MARK="$RUNTIME $(git -C "$WORK/repo" rev-parse HEAD:code-runner/src HEAD:code-runner/calibration/cases HEAD:code-runner/calibration/listings HEAD:code-runner/calibration/repos HEAD:code-runner/calibration/lib HEAD:code-runner/calibration/run.js | tr '\n' ' ')"
current() {
  held=$(cat "$WORK/prepared/$1" 2>/dev/null)
  [ "$held" = "$MARK" ] || { [ -n "${SLOW_HOST:-}" ] && [ "$held" = "$MARK slow-host" ]; }
}
TMP="$WORK/tmp/prepare-$$"
mkdir -p "$WORK/results" "$WORK/exports" "$WORK/measured" "$TMP" "$WORK/cache" "$WORK/prepared"
run() {
  env -i PATH="$WORK/node/bin:/usr/bin:/bin" HOME="$WORK" TMPDIR="$TMP" \
    VCR_CALIBRATION_CACHE="$WORK/cache" CODE_RUNNER_RUNTIME="$RUNTIME" "$NODE" "$CALIBRATION" "$@"
}

listings=$(run --list-listings | "$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).join("\n"))') || exit 1
failed=0
for listing in ${*:-$listings}; do
  if current "$listing"; then
    echo "jury-prepare: $listing is done"
    continue
  fi
  echo "jury-prepare: $listing"
  # The run replaces what the marker vouches for, so the marker goes first: a run that fails leaves none.
  rm -f "$WORK/prepared/$listing"
  code=0
  run --listing "$listing" --results "$WORK/results/$listing.json" --measured "$WORK/measured" --export "$WORK/exports/$listing" ${SLOW_HOST:+--slow-host} || code=$?
  echo "jury-prepare: $listing exit $code"
  if [ "$code" -eq 0 ]; then echo "$MARK${SLOW_HOST:+ slow-host}" > "$WORK/prepared/$listing"; else failed=1; fi
done
rm -rf "$TMP"
[ "$failed" -eq 0 ] || { echo "jury-prepare: a listing did not agree, so claims/ is not written"; exit 1; }
for listing in $listings; do
  current "$listing" || { echo "jury-prepare: $listing is not done yet, so claims/ is not written"; exit 0; }
done

# One writer, and claims/ appears whole: the batch reads whatever is there.
if ! mkdir "$WORK/claims.lock" 2>/dev/null; then
  echo "jury-prepare: another process is writing claims/ ($WORK/claims.lock)"
  exit 0
fi
NEW="$WORK/claims.new.$$"
trap 'rm -rf "$WORK/claims.lock" "$NEW"' EXIT
mkdir "$NEW" || exit 1
for folder in "$WORK"/exports/*/*/; do
  id=$(basename "$folder")
  case "$id" in
    *.control) case "$JURY_CONTROLS" in *" $id "*) ;; *) continue ;; esac ;;
  esac
  cp -R "${folder%/}" "$NEW/$id" || { echo "jury-prepare: $id could not be copied, so claims/ is not written"; exit 1; }
done
rm -rf "$WORK/claims"
mv "$NEW" "$WORK/claims" || exit 1
echo "jury-prepare: $(ls "$WORK/claims" | wc -l) scenario(s) in claims/"
