#!/bin/bash
# The service credentials are private by what writes them, never by a process-wide umask.
#
# PR #210 first put `umask 077` at the top of install.sh, upgrade-arbiter.sh, configure-node.sh,
# install-adapter.sh and install-ai-node.sh. Every child inherits it: setup-chainlink.sh then makes
# ~/.chainlink-<net> 0700 and config.toml / secrets.toml 0600, and the Chainlink container, which
# runs as uid 14933 and reads that directory through a bind mount, cannot open its own config on a
# fresh install (on the hosts the files belong to root). The AI Node, the adapter and the code
# runner that start-arbiter.sh starts at the end of an upgrade would also run under 077 until the
# next boot, and under 022 after it. So: no global umask, and each file that holds a credential is
# 0600 from the tool that writes it. Both halves are held here.
# Run: bash installer/tests/credential-file-modes.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# ── No installer entry point, and nothing it sources, sets a umask for the whole run ──
for f in "$ROOT"/bin/*.sh "$ROOT"/lib/*.sh "$ROOT"/util/start-arbiter.sh "$REPO"/ai-node/start.sh "$REPO"/external-adapter/start.sh; do
    [ -f "$f" ] || continue
    # A umask inside ( ... ) ends with the subshell; one at the start of a line is the script's.
    if grep -nE '^[[:space:]]*umask[[:space:]]' "$f" | grep -vE '\([[:space:]]*umask' >/dev/null; then
        bad "$(basename "$f") sets a umask for everything it starts: $(grep -nE '^[[:space:]]*umask[[:space:]]' "$f" | head -1)"
    else
        ok
    fi
done

# ── What setup-chainlink.sh writes for the container stays readable by the container ──
# The directory and the two TOML files are created with the caller's umask; .api is chmod 644.
grep -qE '^mkdir -p "\$CHAINLINK_DIR"$' "$ROOT/bin/setup-chainlink.sh" && ok || bad "setup-chainlink.sh no longer creates \$CHAINLINK_DIR with a plain mkdir: check its mode for uid 14933"
grep -qE '^chmod 644 "\$CHAINLINK_DIR/\.api"$' "$ROOT/bin/setup-chainlink.sh" && ok || bad "setup-chainlink.sh no longer makes .api readable by the container"

# ── The credential files are 0600 under an ordinary umask ──
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ai-node" "$T/external-adapter"
# An existing, world-readable config, as every install before this release has.
( umask 022; printf 'JUSTIFIER_MODEL=example:model\n' > "$T/ai-node/.env.local"; printf 'PORT=8080\n' > "$T/external-adapter/.env" )
[ "$(mode "$T/external-adapter/.env")" = "644" ] && ok || bad "fixture: .env should start 644, is $(mode "$T/external-adapter/.env")"
( umask 022; node "$ROOT/util/configure-service-auth.cjs" configure "$T" >/dev/null ) && ok || bad "configure-service-auth.cjs configure failed"
[ "$(mode "$T/ai-node/.env.local")" = "600" ] && ok || bad "ai-node/.env.local is $(mode "$T/ai-node/.env.local") under umask 022, not 600"
[ "$(mode "$T/external-adapter/.env")" = "600" ] && ok || bad "external-adapter/.env is $(mode "$T/external-adapter/.env") under umask 022, not 600"
grep -q '^JUSTIFIER_MODEL=example:model$' "$T/ai-node/.env.local" && grep -q '^PORT=8080$' "$T/external-adapter/.env" && ok || bad "the other settings were not kept"
( umask 022; cp "$REPO/chainlink-node/basicJobSpec" "$T/job.toml"; node "$ROOT/util/configure-service-auth.cjs" render-job "$T" "$T/job.toml" >/dev/null ) && ok || bad "render-job failed"
[ "$(mode "$T/job.toml")" = "600" ] && ok || bad "a rendered job is $(mode "$T/job.toml") under umask 022, not 600"
grep -q '{EA_API_TOKEN}' "$T/job.toml" && bad "the rendered job still has the placeholder" || ok
# The files the tool wrote are the only ones it made private: nothing else in the tree changed mode.
( umask 022; : > "$T/other" ); [ "$(mode "$T/other")" = "644" ] && ok || bad "an unrelated file is $(mode "$T/other")"

# configure-node.sh makes each rendered job private itself as well, and never prints one.
grep -qE 'render-job .*"\$JOB_SPEC_FILE_ARBITER"' "$ROOT/bin/configure-node.sh" && grep -qE '^[[:space:]]*chmod 600 "\$JOB_SPEC_FILE_ARBITER"' "$ROOT/bin/configure-node.sh" && ok || bad "configure-node.sh does not render and chmod 600 each job file"
grep -qE 'temp_json="\$\(mktemp ' "$ROOT/bin/configure-node.sh" && ok || bad "configure-node.sh's JSON copy of a job is not a mktemp file (0600)"

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
