#!/bin/bash
# arbiter-boot-service.sh (2026-10-18 Contabo reboot wave: nodes did not come
# back after a host reboot). enable must write the systemd unit, enable it and
# put --restart unless-stopped on both containers; disable must undo all of it;
# status must tell the two states apart; a run without root or sudo must fail
# with exit 3 and still fix the containers. Also: stop-arbiter.sh leaves the
# .arbiter-stopped marker that start-arbiter.sh removes.
# Runs the real scripts against stub docker/systemctl/sudo on PATH.
# Run: bash installer/tests/boot-service.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)   # resolved: readlink -f in the scripts yields the real path
trap 'rm -rf "$T"' EXIT
I="$T/install"; B="$T/bin"; U="$T/units"; ST="$T/state"
mkdir -p "$I/ai-node" "$I/external-adapter" "$B" "$U" "$ST"
cp "$ROOT/installer/util/arbiter-boot-service.sh" "$I/"
cp "$ROOT/installer/util/start-arbiter.sh" "$ROOT/installer/util/stop-arbiter.sh" "$I/"
chmod +x "$I"/*.sh

# Stub docker: restart policies live in $ST/policy.<name>; both containers exist.
cat > "$B/docker" <<EOF
#!/bin/bash
case "\$*" in
  "inspect --format {{.HostConfig.RestartPolicy.Name}} "*) cat "$ST/policy.\${@: -1}" 2>/dev/null || echo no ;;
  "update --restart "*) echo "\$3" > "$ST/policy.\$4" ;;
  "inspect --format {{.State.Running}} "*) echo true ;;
  "inspect "*) exit 0 ;;
  *) : ;;
esac
exit 0
EOF
# Stub systemctl: enabled state in $ST/unit.<name>.
cat > "$B/systemctl" <<EOF
#!/bin/bash
case "\$1" in
  is-enabled) cat "$ST/unit.\$2" 2>/dev/null || exit 1 ;;
  is-active) echo inactive ;;
  enable) echo enabled > "$ST/unit.\$2" ;;
  disable) echo disabled > "$ST/unit.\$2" ;;
  daemon-reload) echo reload >> "$ST/reloads" ;;
  list-unit-files) [ -f "$U/\$2" ] && echo "\$2 enabled" ;;
esac
exit 0
EOF
# Stub sudo (passwordless): drop -n, run the command, record it.
cat > "$B/sudo" <<EOF
#!/bin/bash
[ "\$1" = "-n" ] && shift
[ "\$1" = "true" ] && exit 0
echo "\$*" >> "$ST/sudo-calls"
exec "\$@"
EOF
# Stub sudo that always refuses (no passwordless sudo on this host).
mkdir -p "$B/nosudo"; printf '#!/bin/bash\nexit 1\n' > "$B/nosudo/sudo"
chmod +x "$B"/* "$B/nosudo/sudo"

run() { ( cd "$I" && env PATH="$B:$PATH" VERDIKTA_SYSTEMD_UNIT_DIR="$U" "$@" 2>&1 ); }
is_root=0; [ "$(id -u)" = "0" ] && is_root=1

# 1. print-unit: the unit that will be installed.
out=$(run bash ./arbiter-boot-service.sh print-unit --user arbiter)
has "unit" "$out" "^After=network-online.target docker.service"
has "unit" "$out" "^Wants=network-online.target docker.service"
has "unit" "$out" "^Type=oneshot"
has "unit" "$out" "^RemainAfterExit=yes"
has "unit" "$out" "^User=arbiter"
has "unit" "$out" "^ExecStart=$I/start-arbiter.sh"
has "unit" "$out" "^ExecStop=$I/stop-arbiter.sh"
has "unit" "$out" "^WantedBy=multi-user.target"
hasnt "unit" "$out" "^Restart="      # stop-arbiter.sh must stay in charge: nothing restarts the node

# 2. status on a fresh host: not configured.
run bash ./arbiter-boot-service.sh status --quiet; rc=$?
[ "$rc" = 1 ] && ok || bad "status before enable: rc=$rc, expected 1"
out=$(run bash ./arbiter-boot-service.sh status)
has "status before" "$out" "not installed"
has "status before" "$out" "restart policy.*no"

# 3. enable: unit written + enabled, policies set.
out=$(run bash ./arbiter-boot-service.sh enable); rc=$?
[ "$rc" = 0 ] && ok || bad "enable: rc=$rc: $out"
[ -f "$U/verdikta-arbiter.service" ] && ok || bad "enable: unit file not written to $U"
grep -q "^ExecStart=$I/start-arbiter.sh" "$U/verdikta-arbiter.service" && ok || bad "enable: unit file has the wrong ExecStart"
[ "$(cat "$ST/unit.verdikta-arbiter.service" 2>/dev/null)" = "enabled" ] && ok || bad "enable: systemctl enable not called"
[ -f "$ST/reloads" ] && ok || bad "enable: daemon-reload not called"
[ "$(cat "$ST/policy.chainlink")" = "unless-stopped" ] && ok || bad "enable: chainlink policy is $(cat "$ST/policy.chainlink" 2>/dev/null)"
[ "$(cat "$ST/policy.cl-postgres")" = "unless-stopped" ] && ok || bad "enable: cl-postgres policy is $(cat "$ST/policy.cl-postgres" 2>/dev/null)"
has "enable" "$out" "Enabled: verdikta-arbiter.service"
if [ "$is_root" = 0 ]; then
    grep -q "install -m 0644" "$ST/sudo-calls" 2>/dev/null && ok || bad "enable: unit not installed through sudo"
fi

# 4. status after enable: configured; enable is idempotent.
run bash ./arbiter-boot-service.sh status --quiet; rc=$?
[ "$rc" = 0 ] && ok || bad "status after enable: rc=$rc, expected 0"
out=$(run bash ./arbiter-boot-service.sh enable); rc=$?
[ "$rc" = 0 ] && ok || bad "second enable: rc=$rc"
has "second enable" "$out" "already.*unless-stopped"

# 5. disable: unit gone, disabled, containers back to no.
out=$(run bash ./arbiter-boot-service.sh disable); rc=$?
[ "$rc" = 0 ] && ok || bad "disable: rc=$rc: $out"
[ ! -f "$U/verdikta-arbiter.service" ] && ok || bad "disable: unit file still present"
[ "$(cat "$ST/unit.verdikta-arbiter.service")" = "disabled" ] && ok || bad "disable: systemctl disable not called"
[ "$(cat "$ST/policy.chainlink")" = "no" ] && ok || bad "disable: chainlink policy is $(cat "$ST/policy.chainlink")"
has "disable" "$out" "stays down after a reboot"
run bash ./arbiter-boot-service.sh status --quiet; rc=$?
[ "$rc" = 1 ] && ok || bad "status after disable: rc=$rc, expected 1"

# 6. No root and no passwordless sudo, no TTY: exit 3, containers still fixed.
if [ "$is_root" = 0 ]; then
    out=$( cd "$I" && env PATH="$B/nosudo:$B:$PATH" VERDIKTA_SYSTEMD_UNIT_DIR="$U" VERDIKTA_UNATTENDED=1 \
           bash ./arbiter-boot-service.sh enable </dev/null 2>&1 ); rc=$?
    [ "$rc" = 3 ] && ok || bad "enable without sudo: rc=$rc, expected 3: $out"
    has "enable without sudo" "$out" "Need root"
    [ "$(cat "$ST/policy.chainlink")" = "unless-stopped" ] && ok || bad "enable without sudo: container policy not applied"
    [ ! -f "$U/verdikta-arbiter.service" ] && ok || bad "enable without sudo: unit file written anyway"
fi

# 7. A set -e caller survives every exit code (install.sh / upgrade-arbiter.sh
#    wrap the call, but the status probe must not kill them either).
out=$(cd "$I" && env PATH="$B:$PATH" VERDIKTA_SYSTEMD_UNIT_DIR="$U" bash -c 'set -e; bash ./arbiter-boot-service.sh status --quiet || rc=$?; echo "rc=${rc:-0} survived"' 2>&1)
has "set -e caller" "$out" "survived"

# 8. stop-arbiter.sh leaves the marker; start-arbiter.sh removes it.
printf '#!/bin/bash\nexit 0\n' > "$I/ai-node/stop.sh"; cp "$I/ai-node/stop.sh" "$I/external-adapter/stop.sh"
printf '#!/bin/bash\nexit 0\n' > "$I/ai-node/start.sh"; cp "$I/ai-node/start.sh" "$I/external-adapter/start.sh"
chmod +x "$I/ai-node"/*.sh "$I/external-adapter"/*.sh
# docker ps shows nothing running; lsof: everything listening (start skips every start).
cat > "$B/docker" <<'EOF'
#!/bin/bash
case "$*" in
  "ps"|"ps -a") echo "CONTAINER ID IMAGE" ;;
  "inspect --format {{.State.Running}} "*) echo true ;;
  "exec cl-postgres pg_isready -q") exit 0 ;;
  *) : ;;
esac
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$B/lsof"
printf '#!/bin/bash\ncase "$*" in *3000/api/health*) echo "{\\"status\\":\\"ok\\"}";; *) exit 7;; esac\n' > "$B/curl"
chmod +x "$B/docker" "$B/lsof" "$B/curl"
out=$(run bash ./stop-arbiter.sh)
[ -f "$I/.arbiter-stopped" ] && ok || bad "stop-arbiter.sh did not write .arbiter-stopped: $out"
has "stop" "$out" "stays down until"
out=$(run bash ./start-arbiter.sh)
[ ! -f "$I/.arbiter-stopped" ] && ok || bad "start-arbiter.sh did not remove .arbiter-stopped: $out"
has "start" "$out" "PostgreSQL"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
