#!/bin/bash
#
# Verdikta Arbiter - publish the Chainlink UI/API (6688) on 127.0.0.1 only
#
# Older installs publish the chainlink container with `-p 6688:6688`, i.e. on
# every interface: the node's operator UI and API (plain HTTP, login only) are
# reachable from the internet. arbiter-firewall.sh drops that traffic on the
# public NIC; this is the second layer. Docker fixes published ports at
# container creation, so the chainlink container is recreated with
# `-p 127.0.0.1:6688:6688`. Nothing else on the host needs 6688 from outside:
# every installer tool uses localhost:6688, and operators reach the UI through
# an SSH tunnel:  ssh -L 6688:127.0.0.1:6688 <user>@<host>
#
# The new container is built from the old one's `docker inspect` (image, the
# /chainlink mount, restart policy, log options, --add-host entries, network,
# command, tty/stdin) and CREATED FIRST under a temporary name: if creation
# fails nothing has been touched. Only then is the old container stopped (30 s
# grace) and renamed aside, the new one renamed to `chainlink` and started. If
# it does not come up, the old container is renamed back and started again.
# It only works on a RUNNING container: that is what lets it start the
# replacement and see it answer before the old one is thrown away (a stopped
# node would get a replacement nobody has ever started). upgrade-arbiter.sh
# therefore asks after it has restarted the arbiter.
# The database (cl-postgres, anonymous data volume) is never touched. The
# recreate refuses, and changes nothing, when the container carries settings it
# would drop: other published ports, extra mounts or read-only mounts, custom
# environment variables, entrypoint, user, working directory, labels,
# healthcheck, static IPs or aliases, privileged / capabilities / devices /
# resource limits / init / tmpfs / ulimits / sysctls.
# Chainlink is down for as long as it takes to stop and start (about a minute).
#
# Usage:
#   apply-chainlink-loopback.sh --check     # exit 0 if 6688 is not exposed, 1 if it is, 2 nothing to check
#   apply-chainlink-loopback.sh --apply     # recreate without prompting (exit 0 done, 1 failed or refused)
#   apply-chainlink-loopback.sh --revert    # publish on all interfaces again (-p 6688:6688)
#   apply-chainlink-loopback.sh             # interactive apply
#
# Test hook: VERDIKTA_CHAINLINK_CONTAINER overrides the container name.
#

set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

CL="${VERDIKTA_CHAINLINK_CONTAINER:-chainlink}"
MODE="interactive"
TARGET_HOST_IP="127.0.0.1"
case "${1:-}" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --revert) MODE="apply"; TARGET_HOST_IP="" ;;
    "") ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

command -v docker >/dev/null 2>&1 || { echo -e "${YELLOW}docker not found; nothing to do.${NC}"; exit 2; }
docker inspect "$CL" >/dev/null 2>&1 || { echo -e "${YELLOW}$CL container not found; nothing to do.${NC}"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo -e "${RED}python3 is required to read the container settings.${NC}" >&2; exit 2; }

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT
docker inspect "$CL" > "$WORK/container.json" 2>/dev/null || exit 1

# Describe how 6688 is published now: prints "<hostip>|<hostport>" per binding.
published_bindings() {
    python3 - "$WORK/container.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))[0]
for b in (c["HostConfig"].get("PortBindings") or {}).get("6688/tcp") or []:
    print("%s|%s" % (b.get("HostIp", ""), b.get("HostPort", "")))
PY
}

BINDINGS=$(published_bindings)
HOST_PORT=$(echo "$BINDINGS" | sed -n '1s/^[^|]*|//p')
HOST_PORT="${HOST_PORT:-6688}"
exposed=0
if [ -z "$BINDINGS" ]; then
    state="not published on the host"
else
    state=""
    while IFS='|' read -r hip hport; do
        case "$hip" in
            127.0.0.1|::1) state="$state ${hip}:${hport}" ;;
            *) exposed=1; state="$state ${hip:-0.0.0.0}:${hport}" ;;
        esac
    done <<< "$BINDINGS"
fi

echo -e "${BLUE}Chainlink UI/API (6688) is published on:${NC}${state:+ }${state# }"

if [ "$MODE" = "check" ]; then
    if [ "$exposed" = "1" ]; then exit 1; fi
    echo -e "${GREEN}$CL is not published on a public address.${NC}"
    exit 0
fi

if [ "$TARGET_HOST_IP" = "127.0.0.1" ] && [ "$exposed" = "0" ]; then
    echo -e "${GREEN}Nothing to do.${NC}"
    exit 0
fi
if [ -z "$TARGET_HOST_IP" ] && { [ "$exposed" = "1" ] || [ -z "$BINDINGS" ]; }; then
    echo -e "${GREEN}Nothing to do: 6688 is ${BINDINGS:+already }published on ${BINDINGS:+all interfaces}${BINDINGS:-nothing (no host port)}.${NC}"
    exit 0
fi
WAS_RUNNING=$(docker inspect --format '{{.State.Running}}' "$CL" 2>/dev/null)
if [ "$WAS_RUNNING" != "true" ]; then
    echo -e "${RED}$CL is not running, so the replacement could not be started and checked before the old container is removed.${NC}" >&2
    echo -e "${YELLOW}Nothing was changed. Start the arbiter ($(dirname "$0")/start-arbiter.sh), then run this again.${NC}" >&2
    exit 1
fi

# ── Build the new container's `docker create` arguments from the old one ─────
IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["Config"]["Image"])' "$WORK/container.json")
docker image inspect "$IMAGE" > "$WORK/image.json" 2>/dev/null || echo '[{}]' > "$WORK/image.json"

TS=$(date +%Y%m%d%H%M%S)
NEW="$CL-new-$TS"
PREV="$CL-prev-$TS"

python3 - "$WORK/container.json" "$WORK/image.json" "$NEW" "$TARGET_HOST_IP" > "$WORK/create.args" 2> "$WORK/refusal.txt" <<'PY'
import json, shlex, sys
c = json.load(open(sys.argv[1]))[0]
img = json.load(open(sys.argv[2]))[0]
new_name, host_ip = sys.argv[3], sys.argv[4]
hc, cfg = c["HostConfig"], c["Config"]
problems = []

pb = hc.get("PortBindings") or {}
others = sorted(p for p in pb if p != "6688/tcp")
if others:
    problems.append("other published ports: " + ", ".join(others))
mounts = c.get("Mounts") or []
if len(mounts) != 1 or mounts[0].get("Destination") != "/chainlink":
    problems.append("mounts other than /chainlink: " + ", ".join(m.get("Destination", "?") for m in mounts))
img_cfg = img.get("Config") or {}
img_env = set(img_cfg.get("Env") or [])
extra_env = sorted(e.split("=", 1)[0] for e in (cfg.get("Env") or []) if e not in img_env)
if extra_env:
    problems.append("custom environment variables: " + ", ".join(extra_env))
if img and (cfg.get("Entrypoint") or None) != (img_cfg.get("Entrypoint") or None):
    problems.append("a custom entrypoint")
for key in ("Privileged",):
    if hc.get(key):
        problems.append(key)
for key in ("CapAdd", "CapDrop", "Devices", "Dns", "SecurityOpt", "Links", "VolumesFrom"):
    if hc.get(key):
        problems.append(key)
for key in ("Memory", "NanoCpus", "CpuShares"):
    if hc.get(key):
        problems.append("a resource limit (%s)" % key)
for key in ("Init", "Tmpfs", "ReadonlyRootfs", "Ulimits", "Sysctls", "CgroupParent", "PidMode", "UTSMode", "UsernsMode"):
    if hc.get(key):
        problems.append(key)
for key in ("User", "WorkingDir", "Healthcheck"):
    if (cfg.get(key) or None) != (img_cfg.get(key) or None):
        problems.append("a custom " + key.lower())
extra_labels = sorted(k for k, v in (cfg.get("Labels") or {}).items() if (img_cfg.get("Labels") or {}).get(k) != v)
if extra_labels:
    problems.append("custom labels: " + ", ".join(extra_labels))
for m in mounts:
    if m.get("RW") is False:
        problems.append("a read-only mount")
own = {(c.get("Name") or "").lstrip("/"), (c.get("Id") or "")[:12]}
for net, conf in ((c.get("NetworkSettings") or {}).get("Networks") or {}).items():
    if (conf or {}).get("IPAMConfig"):
        problems.append("a static IP on network " + net)
    if [a for a in (conf or {}).get("Aliases") or [] if a not in own]:
        problems.append("network aliases on " + net)
if problems:
    sys.stderr.write("; ".join(problems) + "\n")
    sys.exit(3)

m = mounts[0]
src = m.get("Name") if m.get("Type") == "volume" else m.get("Source")
binding = (pb.get("6688/tcp") or [{}])[0]
host_port = binding.get("HostPort") or "6688"
publish = "%s%s:6688" % (host_ip + ":" if host_ip else "", host_port)

arch = img.get("Architecture") or "amd64"
args = ["--platform", "linux/" + arch, "--name", new_name, "-v", "%s:/chainlink" % src]
if cfg.get("Tty"):
    args.append("-t")
if cfg.get("OpenStdin"):
    args.append("-i")
args += ["-p", publish]
policy = hc.get("RestartPolicy") or {}
name = policy.get("Name") or ""
if name in ("always", "unless-stopped"):
    args += ["--restart", name]
elif name == "on-failure":
    args += ["--restart", "on-failure" + (":%d" % policy["MaximumRetryCount"] if policy.get("MaximumRetryCount") else "")]
lc = hc.get("LogConfig") or {}
if lc.get("Type"):
    args += ["--log-driver", lc["Type"]]
    for k, v in sorted((lc.get("Config") or {}).items()):
        args += ["--log-opt", "%s=%s" % (k, v)]
for h in hc.get("ExtraHosts") or []:
    args += ["--add-host", h]
nets = sorted((c.get("NetworkSettings") or {}).get("Networks") or {})
mode = hc.get("NetworkMode") or ""
primary = mode if mode in nets else (nets[0] if nets else "")
if primary and primary != "default":
    args += ["--network", primary]
args.append(cfg["Image"])
args += cfg.get("Cmd") or []
print(" ".join(shlex.quote(a) for a in args))
print(" ".join(shlex.quote(n) for n in nets if n != primary and n not in ("bridge", "default")))
PY
rc=$?
if [ "$rc" != "0" ]; then
    echo -e "${RED}Not recreating $CL: it has settings this tool would drop ($(cat "$WORK/refusal.txt")).${NC}" >&2
    echo -e "${YELLOW}Nothing was changed. Rely on arbiter-firewall.sh for 6688, or recreate the container by hand with -p 127.0.0.1:6688:6688.${NC}" >&2
    exit 1
fi
CREATE_ARGS_LINE=$(sed -n 1p "$WORK/create.args")
EXTRA_NETS=$(sed -n 2p "$WORK/create.args")

if [ "$MODE" = "interactive" ]; then
    echo "This recreates $CL with 6688 published on 127.0.0.1 only; Chainlink is down for about a minute."
    read -r -p "Continue? (y/n): " resp
    case "$resp" in [Yy]*) ;; *) echo "Aborted; no changes made."; exit 1 ;; esac
fi

echo -e "${BLUE}→ Creating the replacement container ($NEW; $CL is untouched so far)...${NC}"
eval "set -- $CREATE_ARGS_LINE"
if ! docker create "$@" >/dev/null; then
    echo -e "${RED}Could not create the replacement container; $CL was not touched.${NC}" >&2
    exit 1
fi
for n in $EXTRA_NETS; do
    docker network connect "$n" "$NEW" >/dev/null 2>&1 || echo -e "${YELLOW}Could not attach $NEW to network $n.${NC}"
done

rollback() {
    echo -e "${RED}$1 Rolling back to the previous container.${NC}" >&2
    docker rm -f "$NEW" >/dev/null 2>&1     # the replacement, if it still carries its temporary name
    docker rm -f "$CL" >/dev/null 2>&1      # ... or already renamed into place
    docker rename "$PREV" "$CL" >/dev/null 2>&1
    if [ "$WAS_RUNNING" = "true" ]; then docker start "$CL" >/dev/null 2>&1; fi
    exit 1
}

echo -e "${BLUE}→ Stopping $CL (graceful, 30s)...${NC}"
docker stop "$CL" --time=30 >/dev/null || { docker rm "$NEW" >/dev/null 2>&1; echo -e "${RED}Failed to stop $CL; nothing changed.${NC}" >&2; exit 1; }
docker rename "$CL" "$PREV" >/dev/null || { docker rm "$NEW" >/dev/null 2>&1; docker start "$CL" >/dev/null 2>&1; echo -e "${RED}Could not rename $CL; nothing changed.${NC}" >&2; exit 1; }
docker rename "$NEW" "$CL" >/dev/null || rollback "Could not rename the replacement container."

echo -e "${BLUE}→ Starting the new $CL...${NC}"
docker start "$CL" >/dev/null || rollback "The new container did not start."
echo -e "${BLUE}→ Waiting for the Chainlink API to respond...${NC}"
up=0
for _ in $(seq 1 30); do
    if curl -s -f "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1; then up=1; break; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$CL" 2>/dev/null)" != "true" ]; then
        rollback "The new container exited."
    fi
    sleep 2
done
if [ "$up" = "1" ]; then
    echo -e "${GREEN}✓ Chainlink is answering on 127.0.0.1:$HOST_PORT.${NC}"
else
    echo -e "${YELLOW}⚠ The container is running but the API is not answering yet (database migrations can take a while). Watch: docker logs -f $CL${NC}"
fi
docker rm "$PREV" >/dev/null 2>&1 || echo -e "${YELLOW}The old container is left as $PREV; remove it with: docker rm $PREV${NC}"
docker port "$CL" 6688/tcp 2>/dev/null | sed 's/^/  published: /'
if [ -n "$TARGET_HOST_IP" ]; then
    echo -e "${BLUE}Chainlink UI from your machine:  ssh -L 6688:127.0.0.1:6688 <user>@<this-host>   then open http://localhost:6688${NC}"
    echo -e "${BLUE}Undo: $0 --revert${NC}"
fi
exit 0
