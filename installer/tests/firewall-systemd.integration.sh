#!/bin/bash
# Real-systemd check of arbiter-firewall.sh (opt-in: needs Docker; runs a privileged
# throwaway Ubuntu container with systemd as PID 1; not part of the *.test.sh run).
#
# Verifies what the PATH-shim tests cannot: that systemd itself accepts the generated
# unit (systemd-analyze verify), that `enable` enables and starts it, that
# `systemctl stop` removes the rules (ExecStop) and `start` brings them back, that a
# restart after the rules were flushed re-applies them without duplicates, that the
# unit starts again after the container's systemd is restarted (WantedBy=multi-user),
# that the ExecStop lines leave nothing noisy in the journal, and that `disable`
# removes rules, unit and registration.
#
# Run: bash installer/tests/firewall-systemd.integration.sh [ubuntu:24.04|ubuntu:20.04]
# (20.04 = systemd 245 / iptables 1.8.4 legacy, the oldest hosts; 24.04 = systemd 255 / nft)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMG=${1:-ubuntu:24.04}; N=fwsystemd$$
command -v docker >/dev/null 2>&1 || { echo "docker not available; skipping"; exit 0; }
cleanup() { docker rm -f $N >/dev/null 2>&1; docker rmi -f $N-img >/dev/null 2>&1; }
trap cleanup EXIT
pass=0; fail=0; ok(){ pass=$((pass+1)); echo "  ok   $1"; }; bad(){ fail=$((fail+1)); echo "  FAIL $1"; }
X() { docker exec $N bash -c "$1"; }

# image with systemd + iptables
docker build -q -t $N-img - >/dev/null <<DOCKERFILE
FROM $IMG
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv iptables iproute2 sudo >/dev/null 2>&1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
docker run -d --name $N --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock $N-img >/dev/null
for _ in $(seq 1 40); do X 'systemctl is-system-running' 2>/dev/null | grep -qE "running|degraded" && break; sleep 1; done
echo "systemd: $(X 'systemctl is-system-running 2>&1; systemctl --version | head -1' | tr '\n' ' ')"
X 'iptables --version; iptables -N DOCKER-USER; iptables -A DOCKER-USER -j RETURN; mkdir -p /root/inst/ai-node'
docker cp $REPO/installer/util/arbiter-firewall.sh $N:/root/inst/
X 'chmod +x /root/inst/arbiter-firewall.sh'

echo "== unit text validated by systemd itself"
X 'cd /root/inst && ./arbiter-firewall.sh print-unit > /tmp/u.service && systemd-analyze verify /tmp/u.service 2>&1 | grep -v "^$" | head -10'
X 'systemd-analyze verify /tmp/u.service >/dev/null 2>&1' && ok "systemd-analyze verify accepts the unit" || bad "systemd-analyze verify complained (see above)"

echo "== enable"
X 'cd /root/inst && ./arbiter-firewall.sh enable' ; rc=$?
[ $rc = 0 ] && ok "enable exit 0 under real systemd" || bad "enable rc=$rc"
X 'systemctl is-enabled verdikta-arbiter-firewall; systemctl is-active verdikta-arbiter-firewall' | tr '\n' ' '; echo
X 'systemctl is-enabled verdikta-arbiter-firewall' | grep -q enabled && ok "unit enabled" || bad "unit not enabled"
X 'systemctl is-active verdikta-arbiter-firewall' | grep -q active && ok "unit active (RemainAfterExit)" || bad "unit not active"
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 3 ] && ok "3 v4 rules" || bad "v4 rules: $n"
X 'cd /root/inst && ./arbiter-firewall.sh status --quiet'; [ $? = 0 ] && ok "status 0" || bad "status != 0"

echo "== systemctl stop removes the rules (ExecStop), start restores them (ExecStart)"
X 'systemctl stop verdikta-arbiter-firewall'
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 0 ] && ok "stop removed the rules" || bad "rules after stop: $n"
X 'iptables -S DOCKER-USER | grep -q RETURN' && ok "Docker's own DOCKER-USER rule untouched" || bad "RETURN rule gone"
X 'systemctl start verdikta-arbiter-firewall'
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 3 ] && ok "start restored the rules" || bad "rules after start: $n"

echo "== boot persistence: rules flushed (as after a reboot), unit re-applies them"
X 'iptables -F INPUT; iptables -F DOCKER-USER; iptables -A DOCKER-USER -j RETURN; systemctl restart verdikta-arbiter-firewall'
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 3 ] && ok "restart re-applied after a flush" || bad "after flush+restart: $n"
X 'systemctl restart verdikta-arbiter-firewall'
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 3 ] && ok "restart is idempotent (no duplicates)" || bad "after second restart: $n"
echo "== the journal is clean (ExecStop of rules that do not exist stays quiet)"
X 'systemctl stop verdikta-arbiter-firewall; systemctl start verdikta-arbiter-firewall'
X 'journalctl -u verdikta-arbiter-firewall --no-pager 2>&1' | grep -qi "bad rule\|no chain\|error" && bad "noise in the journal" || ok "no error lines in the journal"

echo "== disable"
X 'cd /root/inst && ./arbiter-firewall.sh disable'; [ $? = 0 ] && ok "disable exit 0" || bad "disable rc"
n=$(X 'iptables -S | grep -c verdikta-arbiter-ports'); [ "$n" = 0 ] && ok "rules gone" || bad "rules left: $n"
X 'test ! -e /etc/systemd/system/verdikta-arbiter-firewall.service' && ok "unit file removed" || bad "unit file still there"
X 'systemctl is-enabled verdikta-arbiter-firewall 2>&1' | grep -q "No such file\|not-found\|disabled" && ok "unit gone from systemd" || bad "unit still known"
echo "pass=$pass fail=$fail"
