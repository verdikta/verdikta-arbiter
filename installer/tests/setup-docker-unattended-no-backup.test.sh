#!/bin/bash
# setup-docker.sh, unattended, with an old cl-postgres container that is STOPPED:
# it cannot dump the database and asks "Continue installation without backup?".
# A "n" used to print "Installation cancelled by user." and exit 0, so install.sh
# reported the Docker phase as completed and carried on (issue #53).
# Runs the real script against a fake docker on PATH.
# Run: bash installer/tests/setup-docker-unattended-no-backup.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/setup-docker.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# A copy of the installer tree the script can source .env and lib/prompts.sh from.
mkdir -p "$T/installer/bin" "$T/installer/lib" "$T/installer/config" "$T/installer/util" "$T/bin"
cp "$S" "$T/installer/bin/setup-docker.sh"
cp "$ROOT/lib/prompts.sh" "$T/installer/lib/prompts.sh"
cp "$ROOT/util/docker-pull-helper.sh" "$T/installer/util/docker-pull-helper.sh" 2>/dev/null || true
echo 'INSTALL_DIR="/nonexistent/install"' > "$T/installer/.env"
# Fake docker: daemon up; cl-postgres exists (ps -a) but is not running (ps);
# no chainlink container. Everything else succeeds silently.
cat > "$T/bin/docker" <<'FAKE'
#!/bin/bash
case "$*" in
  "info") exit 0 ;;
  *"ps -a --filter name=^cl-postgres$"*) echo cl-postgres ;;
  *"ps --filter name=^cl-postgres$"*) : ;;
  *"ps -a --filter name=^chainlink$"*) : ;;
  *"ps --filter name=^chainlink$"*) : ;;
  *) : ;;
esac
exit 0
FAKE
chmod +x "$T/bin/docker"
echo "$T" > "$T/marker"

run_script() {
  # $1 = value for VA_DOCKER_CONTINUE_WITHOUT_BACKUP ('' = unset), $2 = value for VA_DOCKER_REMOVE_EXISTING
  # env, not a bare prefix: an assignment produced by expansion is a command
  # word to bash, an environment entry to env.
  ( cd "$T" && env PATH="$T/bin:$PATH" VERDIKTA_UNATTENDED=1 \
      ${1:+VA_DOCKER_CONTINUE_WITHOUT_BACKUP="$1"} ${2:+VA_DOCKER_REMOVE_EXISTING="$2"} \
      bash "$T/installer/bin/setup-docker.sh" </dev/null >"$T/out" 2>&1 )
  echo $?
}

# 1. Unattended, n: exits non-zero and names the key.
rc=$(run_script n "")
[ "$rc" != "0" ] && ok || bad "unattended n still exits 0 (rc=$rc)"
grep -q 'Installation cancelled by user' "$T/out" && ok || bad "cancel message missing"
grep -q 'VA_DOCKER_CONTINUE_WITHOUT_BACKUP=y' "$T/out" && ok || bad "the key to set is not named"
grep -q 'The PostgreSQL container is stopped' "$T/out" && ok || bad "the stopped-postgres branch was not the one taken"

# 2. Unattended, key unset: the prompt's unattended default is n — same outcome.
rc=$(run_script "" "")
[ "$rc" != "0" ] && ok || bad "unattended with the key unset exits 0 (rc=$rc)"

# 3. Unattended, y: proceeds to the removal confirmation (which, answered n, is
#    the existing unattended exit 1 naming VA_DOCKER_REMOVE_EXISTING).
rc=$(run_script y n)
[ "$rc" != "0" ] && ok || bad "removal confirmation no longer refuses unattended (rc=$rc)"
grep -q 'set VA_DOCKER_REMOVE_EXISTING=y' "$T/out" && ok || bad "with y the run did not reach the removal confirmation"
grep -q 'VA_DOCKER_CONTINUE_WITHOUT_BACKUP=y' "$T/out" && bad "with y the no-backup refusal still fired" || ok

# 4. Interactive cancel path unchanged: a n still exits 0.
rc=$( ( cd "$T" && PATH="$T/bin:$PATH" bash "$T/installer/bin/setup-docker.sh" <<< "n" >"$T/out" 2>&1 ); echo $? )
[ "$rc" = "0" ] && ok || bad "interactive n no longer exits 0 (rc=$rc)"
grep -q 'Installation cancelled by user' "$T/out" && ok || bad "interactive cancel message missing"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
