#!/bin/bash
# apply-docker-log-rotation.sh recreates the chainlink container, and used to
# hard-code `-p 6688:6688`. After apply-chainlink-loopback.sh published 6688 on
# 127.0.0.1, a later log-rotation recreate (an old install with an unbounded log
# gets one on every upgrade) would have put the operator UI back on every
# interface. It must keep the host address the old container used.
# Runs the real script against a stub docker.
# Run: bash installer/tests/docker-log-rotation-publish.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
B="$T/bin"; ST="$T/state"; mkdir -p "$B" "$ST"

# Stub docker for the templates this script uses. The chainlink container has an
# UNBOUNDED json log (so the recreate happens) and is published on $FW_HOSTIP.
cat > "$B/docker" <<'EOF'
#!/bin/bash
S="$FW_ST"; echo "$*" >> "$S/calls"
case "$1" in
  inspect)
    shift
    if [ "$1" != "--format" ]; then exit 0; fi
    t="$2"
    case "$t" in
      *LogConfig.Type*)            echo json-file ;;
      *'"max-size"'*)              echo "<no value>" ;;
      *LogPath*)                   echo "" ;;
      *Config.Image*)              echo smartcontract/chainlink:2.23.0 ;;
      *Mounts*)                    echo /home/op/.chainlink-sepolia ;;
      *State.Running*)             echo false ;;
      *RestartPolicy*)             echo unless-stopped ;;
      *PortBindings*)              echo -n "${FW_HOSTIP:-}" ;;
    esac ;;
  create) shift; echo "$*" > "$S/create.args" ;;
esac
exit 0
EOF
chmod +x "$B/docker"
run() { env PATH="$B:$PATH" FW_ST="$ST" "$@" bash "$ROOT/installer/util/apply-docker-log-rotation.sh" --apply 2>&1; }

# 1. Published on 127.0.0.1 (after apply-chainlink-loopback.sh): kept.
rm -f "$ST/calls" "$ST/create.args"
run FW_HOSTIP=127.0.0.1 >/dev/null
args=$(cat "$ST/create.args")
has   "loopback kept"   "$args" " -p 127.0.0.1:6688:6688 "
hasnt "loopback kept: no bare publish" "$args" " -p 6688:6688 "
has   "log rotation still applied" "$args" "--log-opt max-size=100m --log-opt max-file=5"
has   "restart policy kept" "$args" "--restart unless-stopped"
has   "add-host kept" "$args" "--add-host=host.docker.internal:host-gateway"

# 2. Published on all interfaces (every existing install): unchanged.
rm -f "$ST/create.args"
run FW_HOSTIP= >/dev/null
args=$(cat "$ST/create.args")
has   "all interfaces: unchanged" "$args" " -p 6688:6688 "
hasnt "all interfaces: no host address invented" "$args" " -p [0-9.]*:6688:6688"

# 3. The manual recovery command (printed when create fails) says the same.
cat > "$B/docker" <<'EOF'
#!/bin/bash
case "$*" in
  *"LogConfig.Type"*) echo json-file ;;
  *'"max-size"'*) echo "<no value>" ;;
  *Config.Image*) echo smartcontract/chainlink:2.23.0 ;;
  *Mounts*) echo /m ;;
  *State.Running*) echo false ;;
  *RestartPolicy*) echo unless-stopped ;;
  *PortBindings*) echo -n 127.0.0.1 ;;
  create*) exit 1 ;;
esac
exit 0
EOF
out=$(env PATH="$B:$PATH" bash "$ROOT/installer/util/apply-docker-log-rotation.sh" --apply 2>&1)
has   "recovery command keeps the address" "$out" "-d -p 127.0.0.1:6688:6688 --restart"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
