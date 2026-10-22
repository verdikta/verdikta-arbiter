#!/bin/bash
# apply-chainlink-loopback.sh recreates the chainlink container with 6688
# published on 127.0.0.1 only (2026-10-21 port audit: the Chainlink UI/API was
# published on every interface). It must carry over everything that matters
# (image, /chainlink mount, restart policy, log options, --add-host, network,
# command, tty/stdin, host port), create the replacement BEFORE touching the old
# container, roll back when the new one does not come up, and refuse -- changing
# nothing -- when the old container has settings it would drop.
# Runs the real script against a stub docker (a tiny container registry in a
# state directory) with canned `docker inspect` JSON.
# Run: bash installer/tests/chainlink-loopback.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()    { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
B="$T/bin"; ST="$T/state"
mkdir -p "$B" "$ST"
cp "$ROOT/installer/util/apply-chainlink-loopback.sh" "$T/"

# Stub docker: containers are files exists.<name> / running.<name> in $FW_ST; every call is logged.
cat > "$B/docker" <<'EOF'
#!/bin/bash
S="$FW_ST"; echo "$*" >> "$S/calls"
case "$1" in
  inspect)
    shift
    if [ "$1" = "--format" ]; then
        name="$3"; [ -f "$S/exists.$name" ] || exit 1
        case "$2" in
          *Health*)   # Docker's HEALTHCHECK state; an empty health.<name> file = the image has none
            if [ "${HEALTH_STUCK:-0}" = 1 ]; then echo starting; exit 0; fi
            if [ "${HEALTH_STARTING:-0}" = 1 ]; then
                n=$(cat "$S/health.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$S/health.count"
                if [ "$n" -lt 4 ]; then echo starting; else echo healthy; fi; exit 0
            fi
            cat "$S/health.$name" 2>/dev/null || echo healthy; exit 0 ;;
        esac
        cat "$S/running.$name" 2>/dev/null || echo false; exit 0
    fi
    [ -f "$S/exists.$1" ] || exit 1
    if [ "$1" = "chainlink" ] && [ -f "$S/is_new.chainlink" ]; then cat "$S/container.new.json"; else cat "$S/container.json"; fi ;;
  image) cat "$S/image.json" ;;
  create)
    shift; name=""; prev=""
    for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done
    [ "${FAIL_CREATE:-0}" = 1 ] && { echo "create failed" >&2; exit 1; }
    echo "$*" > "$S/create.args"; : > "$S/exists.$name"; : > "$S/is_new.$name"; echo "$name" > "$S/new.name"; echo abc123 ;;
  stop) echo false > "$S/running.$2" ;;
  start)
    if [ -f "$S/is_new.$2" ] && [ "${FAIL_START:-0}" = 1 ]; then echo "start failed" >&2; exit 1; fi
    echo true > "$S/running.$2"
    if [ -f "$S/is_new.$2" ] && [ "${EXIT_AFTER_START:-0}" = 1 ]; then echo false > "$S/running.$2"; fi ;;
  rename)
    if [ "${FAIL_RENAME_NEW:-0}" = 1 ] && [ "${2#chainlink-new-}" != "$2" ]; then echo "rename failed" >&2; exit 1; fi
    for k in exists running is_new; do [ -f "$S/$k.$2" ] && mv "$S/$k.$2" "$S/$k.$3"; done ;;
  rm) name="${@: -1}"; rm -f "$S/exists.$name" "$S/running.$name" "$S/is_new.$name" ;;
  network) : ;;
  port) echo "127.0.0.1:6688" ;;
  *) : ;;
esac
exit 0
EOF
cat > "$B/curl" <<'EOF'
#!/bin/bash
[ "${HEALTH_FAIL:-0}" = 1 ] && exit 7
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$B/sleep"
chmod +x "$B"/*

# mk_container [key=value]... writes the canned inspect JSON of the OLD container.
mk_container() {
    python3 - "$ST/container.json" "$@" <<'PY'
import json, sys
out, opts = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:])
c = {"Id": "0123456789abcdef", "Name": "/chainlink", "State": {"Running": True},
     "Config": {"Image": "smartcontract/chainlink:2.23.0", "Tty": True, "OpenStdin": True,
                "Env": ["PATH=/usr/local/bin"], "Entrypoint": ["chainlink"],
                "Cmd": ["node", "-config", "/chainlink/config.toml", "-secrets", "/chainlink/secrets.toml", "start", "-a", "/chainlink/.api"]},
     "HostConfig": {"PortBindings": {"6688/tcp": [{"HostIp": opts.get("hostip", ""), "HostPort": opts.get("hostport", "6688")}]},
                    "RestartPolicy": {"Name": opts.get("restart", "unless-stopped"), "MaximumRetryCount": 0},
                    "LogConfig": {"Type": "json-file", "Config": {"max-size": "100m", "max-file": "5"}},
                    "ExtraHosts": ["host.docker.internal:host-gateway"], "NetworkMode": "verdikta-network"},
     "Mounts": [{"Type": opts.get("mounttype", "bind"), "Name": "chainlink-data", "Source": "/home/op/.chainlink-sepolia", "Destination": "/chainlink"}],
     "NetworkSettings": {"Networks": {"verdikta-network": {"Aliases": ["chainlink", "0123456789ab"]}}}}
if opts.get("nopublish"): c["HostConfig"]["PortBindings"] = {}
if opts.get("extraport"): c["HostConfig"]["PortBindings"]["9999/tcp"] = [{"HostIp": "", "HostPort": "9999"}]
if opts.get("extramount"): c["Mounts"].append({"Type": "bind", "Source": "/etc/x", "Destination": "/x"})
if opts.get("extraenv"): c["Config"]["Env"].append("CL_PASSWORD=hunter2")
if opts.get("privileged"): c["HostConfig"]["Privileged"] = True
if opts.get("entrypoint"): c["Config"]["Entrypoint"] = ["/bin/sh"]
if opts.get("extranet"): c["NetworkSettings"]["Networks"]["monitoring"] = {}
if opts.get("user"): c["Config"]["User"] = "1000"
if opts.get("workdir"): c["Config"]["WorkingDir"] = "/srv"
if opts.get("healthcheck"): c["Config"]["Healthcheck"] = {"Test": ["CMD", "true"]}
if opts.get("labels"): c["Config"]["Labels"] = {"owner": "ops"}
if opts.get("tmpfs"): c["HostConfig"]["Tmpfs"] = {"/tmp": ""}
if opts.get("rom"): c["Mounts"][0]["RW"] = False
if opts.get("staticip"): c["NetworkSettings"]["Networks"]["verdikta-network"]["IPAMConfig"] = {"IPv4Address": "172.20.0.9"}
if opts.get("alias"): c["NetworkSettings"]["Networks"]["verdikta-network"]["Aliases"].append("chainlink.internal")
json.dump([c], open(out, "w"))
PY
    echo '[{"Architecture":"amd64","Config":{"Env":["PATH=/usr/local/bin"],"Entrypoint":["chainlink"]}}]' > "$ST/image.json"
    cp "$ST/container.json" "$ST/container.new.json"
}
reset() {  # old container exists; $1 = running state; extra args = mk_container options
    local running="$1"; shift
    rm -f "$ST"/exists.* "$ST"/running.* "$ST"/is_new.* "$ST"/health.* "$ST"/calls "$ST"/create.args "$ST"/new.name
    : > "$ST/exists.chainlink"; echo "$running" > "$ST/running.chainlink"
    mk_container "$@"
}
run() { env PATH="$B:$PATH" FW_ST="$ST" bash "$T/apply-chainlink-loopback.sh" $RUN_ARGS 2>&1; }
call_line() { grep -n "$1" "$ST/calls" | head -1 | cut -d: -f1; }

# 1. --check: exposed (1), loopback (0), not published (0), no container (2).
reset true
RUN_ARGS=--check; out=$(run); rc=$?
eq  "check exposed rc" "$rc" 1
has "check exposed" "$out" "published on:.*0.0.0.0:6688"
reset true hostip=127.0.0.1
out=$(run); rc=$?
eq  "check loopback rc" "$rc" 0
reset true nopublish=1
out=$(run); rc=$?
eq  "check unpublished rc" "$rc" 0
rm -f "$ST/exists.chainlink"
out=$(run); rc=$?
eq  "check no container rc" "$rc" 2
reset true hostip=::1
run >/dev/null; rc=$?
eq  "check ::1 rc" "$rc" 0
# --check never changes anything.
reset true
RUN_ARGS=--check run >/dev/null
hasnt "check is read-only" "$(cat "$ST/calls")" "^create\|^stop\|^rename\|^rm"

# 2. --apply on a running node.
reset true
RUN_ARGS=--apply; out=$(run); rc=$?
eq  "apply rc" "$rc" 0
args=$(cat "$ST/create.args")
has "args: platform"  "$args" "^--platform linux/amd64 --name chainlink-new-[0-9]* "
has "args: mount"     "$args" " -v /home/op/.chainlink-sepolia:/chainlink "
has "args: tty/stdin" "$args" " -t -i "
has "args: publish"   "$args" " -p 127.0.0.1:6688:6688 "
has "args: restart"   "$args" " --restart unless-stopped "
has "args: log"       "$args" " --log-driver json-file --log-opt max-file=5 --log-opt max-size=100m "
has "args: add-host"  "$args" " --add-host host.docker.internal:host-gateway "
has "args: network"   "$args" " --network verdikta-network smartcontract/chainlink:2.23.0 node -config /chainlink/config.toml -secrets /chainlink/secrets.toml start -a /chainlink/.api\$"
hasnt "args: no public publish" "$args" " -p 6688:6688"
c=$(call_line "^create"); s=$(call_line "^stop"); r=$(call_line "^rename chainlink chainlink-prev"); r2=$(call_line "^rename chainlink-new"); st=$(call_line "^start chainlink"); rm_=$(call_line "^rm chainlink-prev")
{ [ -n "$c" ] && [ -n "$s" ] && [ "$c" -lt "$s" ] && [ "$s" -lt "$r" ] && [ "$r" -lt "$r2" ] && [ "$r2" -lt "$st" ] && [ "$st" -lt "$rm_" ]; } && ok || bad "call order wrong (create<stop<rename<rename<start<rm): $(cat "$ST/calls")"
[ -f "$ST/exists.chainlink" ] && [ "$(cat "$ST/running.chainlink")" = true ] && ok || bad "apply: chainlink not running afterwards"
[ ! -f "$ST/exists.$(cat "$ST/new.name")" ] && ok || bad "apply: temporary name left behind"
if [ -n "$(find "$ST" -name 'exists.chainlink-prev*')" ]; then bad "apply: old container left behind"; else ok; fi
has "apply: ssh hint" "$out" "ssh -L 6688:127.0.0.1:6688"
has "apply: answering" "$out" "answering on 127.0.0.1:6688"

# 3. A stopped container is refused, untouched: the replacement could not be
#    started and checked before the old one is removed (upgrade-arbiter.sh runs
#    this after it has restarted the arbiter for that reason).
reset false
RUN_ARGS=--apply; out=$(run); rc=$?
eq  "stopped rc" "$rc" 1
has "stopped: message" "$out" "is not running"
has "stopped: nothing changed" "$out" "Nothing was changed"
hasnt "stopped: untouched" "$(cat "$ST/calls")" "^create\|^stop\|^start\|^rename\|^rm"
eq  "stopped: still stopped" "$(cat "$ST/running.chainlink")" false
RUN_ARGS=--check; run >/dev/null; rc=$?
eq  "check works on a stopped container" "$rc" 1
RUN_ARGS=--apply

# 4. create fails: the old container is not touched at all.
reset true
out=$(FAIL_CREATE=1 run); rc=$?
eq  "create fails rc" "$rc" 1
has "create fails: message" "$out" "was not touched"
hasnt "create fails: untouched" "$(cat "$ST/calls")" "^stop\|^rename\|^rm\|^start"
eq  "create fails: still running" "$(cat "$ST/running.chainlink")" true

# 5. start fails: rolled back to the old container, which runs again.
reset true
out=$(FAIL_START=1 run); rc=$?
eq  "start fails rc" "$rc" 1
has "start fails: message" "$out" "Rolling back"
[ -f "$ST/exists.chainlink" ] && [ ! -f "$ST/is_new.chainlink" ] && ok || bad "rollback: the old container is not back as chainlink"
eq  "rollback: old container running" "$(cat "$ST/running.chainlink")" true

# 6. The new container exits while we wait: rolled back.
reset true
out=$(HEALTH_FAIL=1 EXIT_AFTER_START=1 run); rc=$?
eq  "exits rc" "$rc" 1
has "exits: message" "$out" "exited"
[ ! -f "$ST/is_new.chainlink" ] && ok || bad "exits: new container still named chainlink"

# 7. Running but not answering yet: kept, with a warning (migrations can be slow).
reset true
out=$(HEALTH_FAIL=1 run); rc=$?
eq  "slow start rc" "$rc" 0
has "slow start: warning" "$out" "not answering yet"
[ -f "$ST/is_new.chainlink" ] && ok || bad "slow start: new container not kept"

# 7b. Docker's own health status: the recreate waits for "healthy" so what looks at the
#     container right afterwards (the post-upgrade doctor) does not see "starting" -- the
#     first testnet run's post-upgrade doctor FAILed on exactly that.
reset true
out=$(run); rc=$?
eq  "healthy at once: rc" "$rc" 0
hasnt "healthy at once: no health wait" "$out" "Waiting for Docker's health check"
reset true
out=$(HEALTH_STARTING=1 run); rc=$?
eq  "starting for a while: rc" "$rc" 0
has "starting: waited" "$out" "Waiting for Docker's health check"
has "starting: became healthy" "$out" "Docker reports .* healthy"
reset true
out=$(HEALTH_STUCK=1 run); rc=$?
eq  "stuck at starting: rc (the API answers, so the upgrade must not fail)" "$rc" 0
has "stuck: warning" "$out" "Docker still reports 'starting'"
reset true
: > "$ST/health.chainlink"
out=$(run); rc=$?
eq  "no healthcheck in the image: rc" "$rc" 0
hasnt "no healthcheck in the image: no wait" "$out" "Waiting for Docker's health check"

# 8. Refusals change nothing.
for opt in extraport extramount extraenv privileged entrypoint user workdir healthcheck labels tmpfs rom staticip alias; do
    reset true $opt=1
    out=$(run); rc=$?
    eq  "refuse $opt rc" "$rc" 1
    has "refuse $opt" "$out" "Nothing was changed"
    hasnt "refuse $opt: untouched" "$(cat "$ST/calls")" "^create\|^stop\|^rename\|^rm\|^start"
done
reset true extraenv=1; out=$(run)
has "refuse extraenv: names the variable" "$out" "CL_PASSWORD"
hasnt "refuse extraenv: never prints the value" "$out" "hunter2"

# 9. Details carried over: host port, volume mounts, on-failure restart, extra network.
reset true hostport=16688
run >/dev/null; has "host port kept" "$(cat "$ST/create.args")" " -p 127.0.0.1:16688:6688 "
reset true mounttype=volume
run >/dev/null; has "named volume kept" "$(cat "$ST/create.args")" " -v chainlink-data:/chainlink "
reset true extranet=1
run >/dev/null; has "extra network connected" "$(cat "$ST/calls")" "^network connect monitoring chainlink-new-"
reset true restart=no
run >/dev/null; hasnt "restart no: flag omitted" "$(cat "$ST/create.args")" "--restart"

# 10. Already loopback: nothing to do. --revert publishes on all interfaces again.
reset true hostip=127.0.0.1
out=$(run); rc=$?
eq  "already loopback rc" "$rc" 0
has "already loopback" "$out" "Nothing to do"
hasnt "already loopback: no recreate" "$(cat "$ST/calls")" "^create"
RUN_ARGS=--revert; out=$(run); rc=$?
eq  "revert rc" "$rc" 0
has "revert publishes on all interfaces" "$(cat "$ST/create.args")" " -p 6688:6688 "
reset true
out=$(run)
has "revert when public" "$out" "Nothing to do"

# 10b. Renaming the replacement into place fails: back to the old container, no orphan.
reset true
RUN_ARGS=--apply; out=$(FAIL_RENAME_NEW=1 run); rc=$?
eq  "rename fails rc" "$rc" 1
has "rename fails: message" "$out" "Rolling back"
[ -f "$ST/exists.chainlink" ] && [ ! -f "$ST/is_new.chainlink" ] && [ "$(cat "$ST/running.chainlink")" = true ] && ok || bad "rename fails: the old container is not back and running"
if [ -n "$(find "$ST" -name 'exists.chainlink-*')" ]; then bad "rename fails: an orphan container is left: $(find "$ST" -name 'exists.*')"; else ok; fi
# --revert with nothing published does not invent a public binding.
reset true nopublish=1
RUN_ARGS=--revert; out=$(run); rc=$?
eq  "revert, unpublished rc" "$rc" 0
has "revert, unpublished" "$out" "Nothing to do"
hasnt "revert, unpublished: no recreate" "$(cat "$ST/calls")" "^create"
RUN_ARGS=--apply

# 11. Interactive: n aborts, y proceeds.
reset true
RUN_ARGS=""; out=$(echo n | run); rc=$?
eq  "interactive n rc" "$rc" 1
hasnt "interactive n: no create" "$(cat "$ST/calls")" "^create"
reset true
out=$(echo y | run); rc=$?
eq  "interactive y rc" "$rc" 0
has "interactive y: published on loopback" "$(cat "$ST/create.args")" " -p 127.0.0.1:6688:6688 "

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
