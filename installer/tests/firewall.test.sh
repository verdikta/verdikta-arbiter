#!/bin/bash
# arbiter-firewall.sh (2026-10-21 port review: 5432 / 6688 / 3000 / 8080 were
# reachable from the internet on the hosts it checked). enable must insert exactly the
# review's rules on the DETECTED public interface (never a hard-coded eth0), for
# IPv4 and IPv6, idempotently; persist them through a systemd unit made of plain
# iptables lines; mark the AI Node for a loopback bind; and disable must undo
# all of it without touching rules it did not create. status must tell the
# states apart (exit 0 / 1 / 2), a run without root or sudo must fail with
# exit 3 and change nothing, a missing DOCKER-USER chain must be skipped.
# Runs the real script against stub iptables/ip6tables/ip/systemctl/sudo on PATH.
# Run: bash installer/tests/firewall.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
eq()    { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
I="$T/install"; B="$T/bin"; U="$T/units"; ST="$T/state"
mkdir -p "$I/ai-node" "$I/external-adapter" "$B/nosudo" "$U" "$ST"
cp "$ROOT/installer/util/arbiter-firewall.sh" "$I/"
chmod +x "$I"/*.sh

# Fake iptables / ip6tables: rules are "CHAIN spec" lines in $FW_ST/<tool>.rules,
# the chains that exist are listed in $FW_ST/<tool>.chains.
cat > "$B/iptables" <<'EOF'
#!/bin/bash
tool=$(basename "$0"); R="$FW_ST/$tool.rules"; C="$FW_ST/$tool.chains"; touch "$R"
[ "$1" = "-w" ] && shift
op="$1"; shift
case "$op" in
  -S) chain="$1"
      grep -qx "$chain" "$C" 2>/dev/null || { echo "$tool: No chain/target/match by that name." >&2; exit 1; }
      echo "-N $chain"; grep "^$chain " "$R" | sed 's/^\([^ ]*\) /-A \1 /' ;;
  -C) chain="$1"; shift; grep -qxF "$chain $*" "$R"; exit $? ;;
  -I) chain="$1"; shift; shift
      grep -qx "$chain" "$C" 2>/dev/null || exit 1
      echo "$chain $*" >> "$R"; echo "$tool -I $chain $*" >> "$FW_ST/ops" ;;
  -D) chain="$1"; shift; line="$chain $*"
      grep -qxF "$line" "$R" || exit 1
      awk -v l="$line" '!d && $0==l {d=1; next} {print}' "$R" > "$R.new" && mv "$R.new" "$R"
      echo "$tool -D $chain $*" >> "$FW_ST/ops" ;;
  *) exit 2 ;;
esac
exit 0
EOF
cp "$B/iptables" "$B/ip6tables"
# Fake ip: the default-route NIC per family comes from $FW_ST/if4 / if6; the
# machine's own addresses (for the bridge check) from $FW_ST/addrs.
cat > "$B/ip" <<'EOF'
#!/bin/bash
if [ "$1 $2 $3" = "-o addr show" ]; then
    n=2; while read -r a; do [ -n "$a" ] && echo "$n: eth0    inet $a/24 scope global eth0"; n=$((n+1)); done < "$FW_ST/addrs" 2>/dev/null
    exit 0
fi
fam="$1"; shift
[ "$1 $2" = "route get" ] || exit 0
f="$FW_ST/if${fam#-}"
[ -s "$f" ] || { echo "RTNETLINK answers: Network is unreachable" >&2; exit 2; }
echo "$3 via 10.0.0.1 dev $(cat "$f") src 10.0.0.2 uid 1000"
EOF
# Fake docker: `port NAME PORT/tcp` prints $FW_ST/docker.port.NAME; `exec cl-postgres psql`
# prints the bridge URLs in $FW_ST/bridge.urls (exit 1 when absent: database not running);
# `exec chainlink sh -c <probe>` exits with the number in $FW_ST/probe.rc (default 0).
cat > "$B/docker" <<'EOF'
#!/bin/bash
case "$1" in
  port) cat "$FW_ST/docker.port.$2" 2>/dev/null; exit 0 ;;
  exec) case "$2" in
          cl-postgres) [ -f "$FW_ST/bridge.urls" ] && { cat "$FW_ST/bridge.urls"; exit 0; }; exit 1 ;;
          chainlink) exit "$(cat "$FW_ST/probe.rc" 2>/dev/null || echo 0)" ;;
        esac ;;
esac
exit 0
EOF
# Fake getent: `getent ahosts NAME` from $FW_ST/hosts ("name ip" lines); an IP literal resolves to itself.
cat > "$B/getent" <<'EOF'
#!/bin/bash
[ "$1" = ahosts ] || exit 2
case "$2" in
  [0-9]*.[0-9]*.[0-9]*.[0-9]*) echo "$2 STREAM $2" ;;
  *) awk -v h="$2" '$1 == h {print $2 " STREAM " h}' "$FW_ST/hosts" 2>/dev/null ;;
esac
EOF
cat > "$B/systemctl" <<EOF
#!/bin/bash
case "\$1" in
  is-enabled) cat "$ST/unit.\$2" 2>/dev/null || exit 1 ;;
  is-active) if [ "\$(cat "$ST/unit.\$2" 2>/dev/null)" = enabled ] && [ ! -f "$ST/unit-failed" ]; then echo active; else echo inactive; exit 3; fi ;;
  enable) echo enabled > "$ST/unit.\${@: -1}" ;;
  disable) echo disabled > "$ST/unit.\${@: -1}" ;;
  daemon-reload) echo reload >> "$ST/reloads" ;;
  list-unit-files) [ -f "$U/\$2" ] && echo "\$2 enabled" ;;
esac
exit 0
EOF
cat > "$B/sudo" <<EOF
#!/bin/bash
[ "\$1" = "-n" ] && shift
[ "\$1" = "true" ] && exit 0
echo "\$*" >> "$ST/sudo-calls"
exec "\$@"
EOF
printf '#!/bin/bash\nexit 1\n' > "$B/nosudo/sudo"
chmod +x "$B"/* "$B/nosudo/sudo"

reset_host() {  # a fresh host: both chains exist, public NIC ens3 (v4) / ens3 (v6)
    rm -f "$ST"/iptables.* "$ST"/ip6tables.* "$ST"/ops "$ST"/sudo-calls "$ST"/unit.* "$ST"/unit-failed "$ST"/reloads "$U"/*.service
    rm -f "$ST"/docker.port.* "$ST"/bridge.urls "$ST"/probe.rc "$ST"/hosts; printf '10.0.0.2\n172.17.0.1\n' > "$ST/addrs"
    printf 'INPUT\nDOCKER-USER\n' > "$ST/iptables.chains"
    printf 'INPUT\nDOCKER-USER\n' > "$ST/ip6tables.chains"
    echo ens3 > "$ST/if4"; echo ens3 > "$ST/if6"
    rm -f "$I/.ai-node-loopback"
}
run() { ( cd "$I" && env PATH="$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" "$@" 2>&1 ); }
FW="bash ./arbiter-firewall.sh"
is_root=0; [ "$(id -u)" = "0" ] && is_root=1
TAG="-m comment --comment verdikta-arbiter-ports -j DROP"

reset_host

# 1. print-unit: plain iptables lines on the detected NIC, no User=, no Restart=.
out=$(run $FW print-unit)
has   "unit" "$out" "^After=network-online.target docker.service containerd.service$"
has   "unit" "$out" "^Type=oneshot"
has   "unit" "$out" "^RemainAfterExit=yes"
has   "unit" "$out" "^WantedBy=multi-user.target"
hasnt "unit" "$out" "^User="
hasnt "unit" "$out" "^Restart="
hasnt "unit" "$(echo "$out" | grep -v '^#')" "arbiter-firewall.sh"   # nothing from the install dir runs as root
has   "unit" "$out" "iptables -w -I DOCKER-USER 1 -i ens3 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL $TAG"
has   "unit" "$out" "iptables -w -I DOCKER-USER 1 -i ens3 -p tcp -m conntrack --ctorigdstport 6688 --ctdir ORIGINAL $TAG"
has   "unit" "$out" "iptables -w -I INPUT 1 -i ens3 -p tcp -m multiport --dports 3000,8080 $TAG"
has   "unit" "$out" "ip6tables -w -I INPUT 1 -i ens3 -p tcp -m multiport --dports 3000,5432,6688,8080 $TAG"
has   "unit" "$out" "ip6tables -w -I DOCKER-USER 1 -i ens3 -p tcp -m conntrack --ctorigdstport 5432"
has   "unit" "$out" "^ExecStop=-/bin/sh -c 'iptables -w -D INPUT -i ens3"
has   "unit" "$out" "'! iptables -w -S DOCKER-USER >/dev/null 2>&1 || iptables -w -C DOCKER-USER"   # skip when the chain is absent
hasnt "unit" "$out" "eth0"                      # the NIC is detected, never hard-coded
# verdikta-sandbox.service is ordered before only when it exists.
touch "$U/verdikta-sandbox.service"
out=$(run $FW print-unit)
has   "unit+sandbox" "$out" "^After=network-online.target docker.service containerd.service verdikta-sandbox.service$"
rm -f "$U/verdikta-sandbox.service"

# 2. Interface detection: v4 and v6 NICs can differ; v6 falls back to the v4 NIC;
#    --interface overrides detection (and may be repeated, e.g. a VPC NIC).
echo enp1s0 > "$ST/if4"; echo enp2s0 > "$ST/if6"
out=$(run $FW enable --print-rules)
has   "detect" "$out" "iptables -w -C INPUT -i enp1s0 .* || iptables -w -I INPUT 1 -i enp1s0"
has   "detect" "$out" "ip6tables -w -C INPUT -i enp2s0 .* || ip6tables -w -I INPUT 1 -i enp2s0"
hasnt "detect" "$out" "enp2s0 .*[^6]iptables"
: > "$ST/if6"
out=$(run $FW enable --print-rules)
has   "v6 falls back to the v4 NIC" "$out" "ip6tables -w -I INPUT 1 -i enp1s0"
out=$(run $FW enable --print-rules --interface eth0 --interface eth1)
has   "override" "$out" "iptables -w -I INPUT 1 -i eth0 "
has   "override" "$out" "iptables -w -I INPUT 1 -i eth1 "
hasnt "override" "$out" "enp1s0"
out=$(run $FW enable --print-rules --interface 'bad name'); rc=$?
eq    "bad NIC name" "$rc" 64
reset_host

# 3. --print-rules changes nothing and needs no privilege.
out=$(run $FW enable --print-rules); rc=$?
eq    "print-rules rc" "$rc" 0
[ ! -s "$ST/iptables.rules" ] && [ ! -f "$ST/ops" ] && [ ! -f "$ST/sudo-calls" ] && ok || bad "print-rules touched state"
has   "print-rules" "$out" "^# Commands enable runs"
out=$(run $FW disable --print-rules)
has   "print-rules disable" "$out" "iptables -w -D DOCKER-USER -i ens3"

# 4. status on a fresh host: not configured.
run $FW status --quiet; rc=$?
eq    "status before enable" "$rc" 1
out=$(run $FW status --quiet); eq "status --quiet is silent" "$out" ""
out=$(run $FW status)
has   "status before" "$out" "OPEN"
has   "status before" "$out" "not installed"

# 5. enable: exact rules, unit, marker, adapter URL, hints.
printf 'OPERATOR_ADDR=0xabc\nAI_NODE_URL=http://localhost:3000\nIPFS_PINNING_KEY=secret\n' > "$I/external-adapter/.env"
chmod 600 "$I/external-adapter/.env"
out=$(run $FW enable); rc=$?
eq    "enable rc" "$rc" 0
R4="$ST/iptables.rules"; R6="$ST/ip6tables.rules"
grep -qxF "DOCKER-USER -i ens3 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL $TAG" "$R4" && ok || bad "v4 DOCKER-USER 5432 rule missing: $(cat "$R4")"
grep -qxF "DOCKER-USER -i ens3 -p tcp -m conntrack --ctorigdstport 6688 --ctdir ORIGINAL $TAG" "$R4" && ok || bad "v4 DOCKER-USER 6688 rule missing"
grep -qxF "INPUT -i ens3 -p tcp -m multiport --dports 3000,8080 $TAG" "$R4" && ok || bad "v4 INPUT rule missing"
grep -qxF "INPUT -i ens3 -p tcp -m multiport --dports 3000,5432,6688,8080 $TAG" "$R6" && ok || bad "v6 INPUT rule missing: $(cat "$R6")"
grep -qxF "DOCKER-USER -i ens3 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL $TAG" "$R6" && ok || bad "v6 DOCKER-USER rule missing"
eq    "rule count v4" "$(wc -l < "$R4" | tr -d ' ')" 3
eq    "rule count v6" "$(wc -l < "$R6" | tr -d ' ')" 3
[ -f "$U/verdikta-arbiter-firewall.service" ] && ok || bad "unit not written"
eq    "unit enabled" "$(cat "$ST/unit.verdikta-arbiter-firewall.service" 2>/dev/null)" enabled
[ -f "$ST/reloads" ] && ok || bad "daemon-reload not called"
[ -f "$I/.ai-node-loopback" ] && ok || bad "AI Node loopback marker not written"
grep -q '^AI_NODE_URL=http://127.0.0.1:3000$' "$I/external-adapter/.env" && ok || bad "AI_NODE_URL not switched: $(cat "$I/external-adapter/.env")"
grep -q '^IPFS_PINNING_KEY=secret$' "$I/external-adapter/.env" && ok || bad "other .env lines lost"
if [ -n "$(find "$I/external-adapter" -name '*bak*')" ]; then bad "left a .bak copy of the adapter .env"; else ok; fi
has   "enable output" "$out" "ssh -L 6688:127.0.0.1:6688"
has   "enable output" "$out" "arbiter-firewall.sh disable"
has   "enable output" "$out" "Closing ports 5432, 6688, 3000 and 8080 on: ens3"
if [ "$is_root" = 0 ]; then
    grep -q "^iptables -w -I DOCKER-USER 1 " "$ST/sudo-calls" && ok || bad "rules not inserted through sudo"
    grep -q "^install -m 0644 .*verdikta-arbiter-firewall.service" "$ST/sudo-calls" && ok || bad "unit not installed through sudo"
fi
# The audit's traffic map: the rules never name an internal interface or port.
hasnt "scope" "$(cat "$R4" "$R6")" "docker0\|br-\|lo "
hasnt "scope" "$(cat "$R4" "$R6")" "22"

# 6. status after enable: configured. A rule flushed behind our back is noticed.
run $FW status --quiet; rc=$?
eq    "status after enable" "$rc" 0
out=$(run $FW status)
hasnt "status after" "$out" "OPEN"
has   "status after" "$out" "closed"
has   "status after" "$out" "AI Node bind: .*127.0.0.1"
cp "$R4" "$T/r4.keep"; grep -v ctorigdstport "$R4" > "$R4.new"; mv "$R4.new" "$R4"
run $FW status --quiet; rc=$?
eq    "status with DOCKER-USER rules flushed" "$rc" 1
cp "$T/r4.keep" "$R4"

# 6b. A NIC added on purpose (`enable --interface eth0 --interface eth1`, say a
#     private VPC NIC) is checked by a plain `status` too; the default NIC alone
#     being covered is not enough once the unit says otherwise.
reset_host
run $FW enable --interface ens3 --interface ens9 >/dev/null
grep -q -- "-i ens9 " "$ST/iptables.rules" && ok || bad "second --interface not applied"
run $FW status --quiet; rc=$?
eq    "status with a VPC NIC covered" "$rc" 0
grep -v -- "-i ens9 " "$ST/iptables.rules" > "$ST/iptables.rules.new"; mv "$ST/iptables.rules.new" "$ST/iptables.rules"
run $FW status --quiet; rc=$?
eq    "status notices the VPC NIC rules are gone" "$rc" 1
out=$(run $FW status)
has   "status names the NIC" "$out" "on ens9): .*OPEN"
reset_host
run $FW enable >/dev/null
run $FW status --quiet; rc=$?
eq    "status after a plain enable" "$rc" 0

# 6c. A plain `enable` re-run (the upgrade offers it whenever status is not 0) keeps the
#     NICs of the installed unit instead of silently shrinking the set to the default NIC.
reset_host
run $FW enable --interface ens3 --interface ens9 >/dev/null
out=$(run $FW enable); rc=$?
eq    "plain re-enable rc" "$rc" 0
has   "plain re-enable names the kept NICs" "$out" "keeping the interface(s) of the installed unit: ens3 ens9"
grep -q -- "-i ens9 " "$U/verdikta-arbiter-firewall.service" && ok || bad "plain re-enable dropped ens9 from the unit"
grep -q -- "-i ens9 " "$ST/iptables.rules" && ok || bad "plain re-enable dropped the ens9 rules"
# ... and an explicit --interface replaces the set; disable then enable resets it.
run $FW enable --interface ens3 >/dev/null
if grep -q -- "-i ens9 " "$U/verdikta-arbiter-firewall.service"; then bad "an explicit --interface should replace the set, but the unit still names ens9"; else ok; fi
run $FW disable >/dev/null; run $FW enable >/dev/null
grep -q -- "-i ens9 " "$U/verdikta-arbiter-firewall.service" && bad "disable + enable should reset the NIC set" || ok

# 6d. Without root the rules cannot be read: the unit must at least be ACTIVE
#     (enabled-but-failed, or stopped, is evidence the rules are not there).
if [ "$is_root" = 0 ]; then
    reset_host
    run $FW enable >/dev/null
    : > "$ST/unit-failed"
    out=$( cd "$I" && env PATH="$B/nosudo:$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" bash ./arbiter-firewall.sh status </dev/null 2>&1 ); rc=$?
    eq    "unverified status, unit enabled but not active" "$rc" 1
    has   "unverified status says why" "$out" "did not apply the rules"
    rm -f "$ST/unit-failed"
fi

# 6e. No DOCKER-USER chain is "n/a" only while nothing is published publicly: Docker started
#     later (or on nftables) with a container on 0.0.0.0 must not look closed.
reset_host
printf 'INPUT\n' > "$ST/iptables.chains"
echo "0.0.0.0:5432" > "$ST/docker.port.cl-postgres"; echo "127.0.0.1:6688" > "$ST/docker.port.chainlink"
out=$(run $FW enable); rc=$?
eq    "enable, DOCKER-USER missing, 5432 published publicly: rc" "$rc" 1
has   "enable names the unprotected port" "$out" "5432 is NOT protected"
hasnt "enable does not blame the loopback-published 6688" "$out" "6688 is NOT protected"
[ -f "$U/verdikta-arbiter-firewall.service" ] && ok || bad "the rest (INPUT rules, unit) must still be installed"
run $FW status --quiet; rc=$?
eq    "status, DOCKER-USER missing, 5432 published publicly" "$rc" 1
out=$(run $FW status)
has   "status says why" "$out" "no DOCKER-USER chain, but cl-postgres publishes 5432 on a public address"
rm -f "$ST/docker.port.cl-postgres"
run $FW status --quiet; rc=$?
eq    "status, DOCKER-USER missing, nothing published" "$rc" 0
reset_host
printf 'INPUT\n' > "$ST/iptables.chains"; echo "127.0.0.1:5432" > "$ST/docker.port.cl-postgres"
run $FW enable >/dev/null; rc=$?
eq    "enable, DOCKER-USER missing, only loopback published" "$rc" 0

# 6f. The bridge check: Chainlink must reach the adapter through an address of THIS host,
#     otherwise the traffic leaves via the public NIC and the 8080 drop cuts it off.
reset_host
printf 'http://10.0.0.2:8080/evaluate\n' > "$ST/bridge.urls"
out=$(run $FW check-bridge); rc=$?
eq    "bridge on the host's address: rc" "$rc" 0
has   "bridge on the host's address" "$out" "10.0.0.2 is an address of this machine"
printf 'http://172.17.0.1:8080/evaluate\nhttp://host.docker.internal:8080/evaluate\n' > "$ST/bridge.urls"
run $FW check-bridge >/dev/null; rc=$?
eq    "bridge on the docker0 / host-gateway address: rc" "$rc" 0
printf 'http://203.0.113.9:8080/evaluate\n' > "$ST/bridge.urls"
out=$(run $FW check-bridge); rc=$?
eq    "bridge on a foreign address: rc" "$rc" 1
has   "bridge on a foreign address" "$out" "203.0.113.9 is NOT an address of this machine"
out=$(run $FW enable); rc=$?
eq    "enable refuses a foreign bridge: rc" "$rc" 1
has   "enable refuses: why" "$out" "Not closing the ports"
[ ! -s "$ST/iptables.rules" ] && [ ! -f "$U/verdikta-arbiter-firewall.service" ] && ok || bad "a refused enable changed something"
out=$(run $FW enable --ignore-bridge-check); rc=$?
eq    "enable --ignore-bridge-check: rc" "$rc" 0
grep -q "multiport --dports 3000,8080" "$ST/iptables.rules" && ok || bad "--ignore-bridge-check did not apply the rules"
# a DNS name resolving to a local address is local; one resolving elsewhere is not.
reset_host
printf 'arbiter.example.org 10.0.0.2\nlb.example.org 198.51.100.7\n' > "$ST/hosts"
printf 'http://arbiter.example.org:8080/evaluate\n' > "$ST/bridge.urls"
run $FW check-bridge >/dev/null; rc=$?
eq    "bridge DNS name -> local address: rc" "$rc" 0
printf 'https://user@lb.example.org:8080/evaluate\n' > "$ST/bridge.urls"
run $FW check-bridge >/dev/null; rc=$?
eq    "bridge DNS name -> foreign address: rc" "$rc" 1
# no database to ask: not checked, enable goes ahead.
reset_host
out=$(run $FW check-bridge); rc=$?
eq    "bridge unreadable: rc" "$rc" 2
has   "bridge unreadable" "$out" "not checked"
run $FW enable >/dev/null; rc=$?
eq    "enable with an unreadable bridge" "$rc" 0
# the probe from inside the chainlink container
reset_host
printf 'http://10.0.0.2:8080/evaluate\n' > "$ST/bridge.urls"
out=$(run $FW check-bridge --probe); rc=$?
eq    "probe ok: rc" "$rc" 0
has   "probe ok" "$out" "chainlink reached http://10.0.0.2:8080/version"
echo 7 > "$ST/probe.rc"
out=$(run $FW check-bridge --probe); rc=$?
eq    "probe fails: rc" "$rc" 1
has   "probe fails" "$out" "chainlink could NOT reach"
echo 99 > "$ST/probe.rc"
out=$(run $FW check-bridge --probe); rc=$?
eq    "probe impossible (no curl/wget): rc" "$rc" 0
has   "probe impossible" "$out" "neither curl nor wget"

# 7. enable again: idempotent, inserts nothing.
reset_host
printf 'OPERATOR_ADDR=0xabc\nAI_NODE_URL=http://localhost:3000\n' > "$I/external-adapter/.env"
run $FW enable >/dev/null
rm -f "$ST/ops"
out=$(run $FW enable); rc=$?
eq    "second enable rc" "$rc" 0
[ ! -f "$ST/ops" ] && ok || bad "second enable inserted rules again: $(cat "$ST/ops")"
eq    "rule count after second enable" "$(wc -l < "$R4" | tr -d ' ')" 3
has   "second enable" "$out" "already"
grep -c '^AI_NODE_URL=' "$I/external-adapter/.env" | grep -qx 1 && ok || bad "AI_NODE_URL duplicated"

# 8. Only the installer's default AI_NODE_URL is rewritten.
reset_host
printf 'AI_NODE_URL=http://10.1.2.3:3000\n' > "$I/external-adapter/.env"
run $FW enable >/dev/null
grep -q '^AI_NODE_URL=http://10.1.2.3:3000$' "$I/external-adapter/.env" && ok || bad "a custom AI_NODE_URL was rewritten"

# 8b. An adapter that reaches the AI Node at another address must not lose it:
#     the loopback bind is skipped (rules still applied) and the operator is told.
for url in 'http://10.1.2.3:3000' 'http://[::1]:3000' 'http://ai.internal:3000'; do
    reset_host
    printf 'AI_NODE_URL=%s\n' "$url" > "$I/external-adapter/.env"
    out=$(run $FW enable); rc=$?
    eq    "custom AI_NODE_URL $url: enable rc" "$rc" 0
    [ ! -f "$I/.ai-node-loopback" ] && ok || bad "marker written although the adapter uses $url"
    has   "custom AI_NODE_URL $url: warned" "$out" "AI Node bind left unchanged"
    grep -q "multiport --dports 3000,8080" "$ST/iptables.rules" && ok || bad "rules not applied when the AI Node bind is skipped"
done
# the installer's own forms are fine, including quotes and a trailing slash.
for url in 'http://localhost:3000/' '"http://localhost:3000"' 'http://127.0.0.1:3000'; do
    reset_host
    printf 'AI_NODE_URL=%s\n' "$url" > "$I/external-adapter/.env"
    run $FW enable >/dev/null
    [ -f "$I/.ai-node-loopback" ] && ok || bad "marker not written for AI_NODE_URL=$url"
done
reset_host; rm -f "$I/external-adapter/.env"
run $FW enable >/dev/null
[ -f "$I/.ai-node-loopback" ] && ok || bad "marker not written when the adapter has no .env"

# 9. A missing DOCKER-USER chain (Docker stopped / nftables) and unreadable
#    ip6tables are skipped, not fatal; the other rules are still applied.
reset_host
printf 'INPUT\n' > "$ST/iptables.chains"; : > "$ST/ip6tables.chains"
out=$(run $FW enable); rc=$?
eq    "enable without DOCKER-USER rc" "$rc" 0
has   "skip" "$out" "skipped"
grep -q "multiport --dports 3000,8080" "$ST/iptables.rules" && ok || bad "v4 INPUT rule not applied when DOCKER-USER is missing"
grep -q "ctorigdstport" "$ST/iptables.rules" && bad "DOCKER-USER rule inserted without the chain" || ok
[ ! -s "$ST/ip6tables.rules" ] && ok || bad "ip6tables rules inserted although ip6tables is unusable"
run $FW status --quiet; rc=$?
eq    "status with n/a rules" "$rc" 0

# 10. disable: our rules, unit and marker go; a hand-typed rule (the audit's
#     manual commands, no tag) and unrelated rules stay.
reset_host
run $FW enable >/dev/null
echo "INPUT -p tcp -m tcp --dport 22 -j ACCEPT" >> "$ST/iptables.rules"
echo "INPUT -i ens3 -p tcp -m multiport --dports 3000,8080 -j DROP" >> "$ST/iptables.rules"
echo "DOCKER-USER -i vsbx0 -j VSBX-EGRESS" >> "$ST/iptables.rules"
out=$(run $FW disable); rc=$?
eq    "disable rc" "$rc" 0
has   "disable" "$out" "removed 6 rule(s)"
grep -q "verdikta-arbiter-ports" "$ST/iptables.rules" "$ST/ip6tables.rules" && bad "tagged rules left: $(cat "$ST/iptables.rules")" || ok
grep -qxF "INPUT -p tcp -m tcp --dport 22 -j ACCEPT" "$ST/iptables.rules" && ok || bad "disable removed an unrelated rule"
grep -qxF "INPUT -i ens3 -p tcp -m multiport --dports 3000,8080 -j DROP" "$ST/iptables.rules" && ok || bad "disable removed a hand-typed rule"
grep -qxF "DOCKER-USER -i vsbx0 -j VSBX-EGRESS" "$ST/iptables.rules" && ok || bad "disable removed the sandbox rule"
[ ! -f "$U/verdikta-arbiter-firewall.service" ] && ok || bad "unit file still present"
eq    "unit disabled" "$(cat "$ST/unit.verdikta-arbiter-firewall.service")" disabled
[ ! -f "$I/.ai-node-loopback" ] && ok || bad "marker still present"
run $FW status --quiet; rc=$?
eq    "status after disable" "$rc" 1
# disable works with no default route (cleanup must not depend on detection).
run $FW enable >/dev/null; : > "$ST/if4"; : > "$ST/if6"
out=$(run $FW disable); rc=$?
eq    "disable without a default route" "$rc" 0
grep -q "verdikta-arbiter-ports" "$ST/iptables.rules" && bad "disable without a route left rules" || ok

# 11. No root and no passwordless sudo, no TTY: exit 3, nothing changed.
if [ "$is_root" = 0 ]; then
    reset_host
    out=$( cd "$I" && env PATH="$B/nosudo:$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" VERDIKTA_UNATTENDED=1 \
           bash ./arbiter-firewall.sh enable </dev/null 2>&1 ); rc=$?
    eq    "enable without sudo" "$rc" 3
    has   "enable without sudo" "$out" "Need root"
    has   "enable without sudo" "$out" "arbiter-firewall.sh enable"
    [ ! -s "$ST/iptables.rules" ] && [ ! -f "$U/verdikta-arbiter-firewall.service" ] && [ ! -f "$I/.ai-node-loopback" ] && ok || bad "enable without sudo changed something"
    # status cannot read iptables without root: it says so and trusts the unit.
    run $FW enable >/dev/null
    out=$( cd "$I" && env PATH="$B/nosudo:$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" \
           bash ./arbiter-firewall.sh status </dev/null 2>&1 ); rc=$?
    eq    "status without sudo (unit enabled)" "$rc" 0
    has   "status without sudo" "$out" "not verified"
    rm -f "$ST/unit.verdikta-arbiter-firewall.service"
    ( cd "$I" && env PATH="$B/nosudo:$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" bash ./arbiter-firewall.sh status --quiet </dev/null >/dev/null 2>&1 ); rc=$?
    eq    "status without sudo (unit missing)" "$rc" 1
fi

# 12. No systemd: enable applies the rules and exits 2; status exits 2 when the
#     rules are there and 1 when they are not.
reset_host
out=$(run env VERDIKTA_FIREWALL_NO_SYSTEMD=1 $FW enable); rc=$?
eq    "enable without systemd" "$rc" 2
grep -q "multiport --dports 3000,8080" "$ST/iptables.rules" && ok || bad "no-systemd enable did not apply the rules"
has   "no systemd" "$out" "reboot removes them"
[ ! -f "$U/verdikta-arbiter-firewall.service" ] && ok || bad "unit written without systemd"
run env VERDIKTA_FIREWALL_NO_SYSTEMD=1 $FW status --quiet; rc=$?
eq    "status without systemd (rules present)" "$rc" 2
reset_host
run env VERDIKTA_FIREWALL_NO_SYSTEMD=1 $FW status --quiet; rc=$?
eq    "status without systemd (rules missing)" "$rc" 1

# 13. No iptables at all: exit 4 (skipped where a real one is installed).
if ! [ -x /usr/sbin/iptables ] && ! [ -x /sbin/iptables ] && ! [ -x /usr/local/sbin/iptables ]; then
    mkdir -p "$T/empty"
    out=$( cd "$I" && env PATH="$T/empty:/usr/bin:/bin" VERDIKTA_SYSTEMD_UNIT_DIR="$U" /bin/bash ./arbiter-firewall.sh status 2>&1 ); rc=$?
    eq    "no iptables" "$rc" 4
    has   "no iptables" "$out" "iptables is not installed"
fi

# 14. No default route at all: enable explains how to name the NIC.
reset_host; : > "$ST/if4"; : > "$ST/if6"
out=$(run $FW enable); rc=$?
eq    "no default route" "$rc" 1
has   "no default route" "$out" "--interface"
run $FW enable --interface eth5 >/dev/null; rc=$?
eq    "no default route, --interface given" "$rc" 0
grep -q "multiport --dports 3000,8080 -m comment" "$ST/iptables.rules" && grep -q -- "-i eth5 " "$ST/iptables.rules" && ok || bad "--interface rules missing"

# 15. A `set -e` caller survives every exit code (upgrade-arbiter.sh and
#     install.sh wrap the call, but the probe itself must not kill them).
reset_host
out=$(cd "$I" && env PATH="$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" bash -c 'set -e; bash ./arbiter-firewall.sh status --quiet || rc=$?; echo "rc=${rc:-0} survived"' 2>&1)
has   "set -e caller" "$out" "rc=1 survived"

# 16. Not an arbiter install dir (the repo's installer/util): rules still apply,
#     but no marker or .env is written there.
reset_host
mkdir -p "$T/plain"; cp "$I/arbiter-firewall.sh" "$T/plain/"
out=$( cd "$T/plain" && env PATH="$B:$PATH" FW_ST="$ST" VERDIKTA_SYSTEMD_UNIT_DIR="$U" bash ./arbiter-firewall.sh enable 2>&1 ); rc=$?
eq    "enable outside an install" "$rc" 0
[ ! -e "$T/plain/.ai-node-loopback" ] && ok || bad "marker written outside an arbiter install"
has   "enable outside an install" "$out" "not an arbiter install"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
