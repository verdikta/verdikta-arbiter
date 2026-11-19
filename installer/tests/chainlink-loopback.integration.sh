#!/bin/bash
# Real-Docker check of the fresh-install database design and of
# apply-chainlink-loopback.sh (opt-in: needs a Docker daemon and the images
# postgres:14 and node:20.18.1-bookworm; throwaway containers and a throwaway
# network with unique names; nothing of yours is touched; not part of the *.test.sh run).
#
# 1. A cl-postgres created the way setup-docker.sh does it (default bridge, then
#    `docker network connect`), with NO host port, is reached by container name from a
#    client on the user-defined network (what Chainlink does with
#    postgresql://...@cl-postgres:5432), also after a Postgres restart, and cannot be
#    resolved from outside that network.
# 2. A "chainlink" container published on all interfaces (an old install) is recreated by
#    apply-chainlink-loopback.sh with 6688 on 127.0.0.1 only; restart policy, log
#    options, --add-host, network, mount, tty/stdin and command survive, nothing is left
#    over, a peer on the network still reaches it, it is not reachable on the LAN address;
#    a STOPPED container is refused untouched; --revert publishes it on all interfaces.
#
# Run: bash installer/tests/chainlink-loopback.integration.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "docker not available; skipping"; exit 0; }
N=fwtest$$; NET=$N-net; PG=$N-pg; CL=$N-chainlink; DIR=$(mktemp -d)
HOSTPORT=${FW_TEST_HOST_PORT:-16688}
# shellcheck disable=SC2046  # the ids are meant to be word-split
cleanup() { docker rm -f $PG $CL >/dev/null 2>&1; docker rm -f $(docker ps -aq --filter "name=$CL-") >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; rm -rf "$DIR"; }
trap cleanup EXIT
pass=0; fail=0; ok(){ pass=$((pass+1)); echo "  ok   $1"; }; bad(){ fail=$((fail+1)); echo "  FAIL $1"; }
APPLY() { VERDIKTA_CHAINLINK_CONTAINER=$CL bash "$REPO/installer/util/apply-chainlink-loopback.sh" "$@"; }

echo "== fresh-install DB design: cl-postgres created like setup-docker.sh, NOT published"
docker run -d --name $PG -e POSTGRES_PASSWORD=pw --restart unless-stopped postgres:14 >/dev/null
docker network create $NET >/dev/null
docker network connect $NET $PG
for _ in $(seq 1 30); do docker exec $PG pg_isready -q && break; sleep 1; done
[ -z "$(docker port $PG)" ] && ok "cl-postgres publishes nothing on the host" || bad "port published: $(docker port $PG)"
q() { docker run --rm --network $NET -e PGPASSWORD=pw postgres:14 psql -h $PG -U postgres -tAc 'select 1' 2>&1; }
[ "$(q)" = "1" ] && ok "a client on the user-defined network reaches $PG:5432 by container name" || bad "client could not reach the DB: $(q)"
docker restart $PG >/dev/null; for _ in $(seq 1 30); do docker exec $PG pg_isready -q && break; sleep 1; done
[ "$(q)" = "1" ] && ok "still reaches it after a postgres restart" || bad "after restart: $(q)"
out=$(docker run --rm -e PGPASSWORD=pw postgres:14 psql -h $PG -U postgres -tAc 'select 1' 2>&1 | head -1)
echo "$out" | grep -q "could not translate host name" && ok "a container NOT on the network cannot resolve the DB" || bad "default-bridge client: $out"

echo "== old-style chainlink container published on ALL interfaces (host port $HOSTPORT)"
docker run -d -it --name $CL -v $DIR:/chainlink -p $HOSTPORT:6688 --restart unless-stopped \
  --log-driver json-file --log-opt max-size=100m --log-opt max-file=5 \
  --add-host=host.docker.internal:host-gateway --network $NET node:20.18.1-bookworm \
  node -e "require('http').createServer((q,r)=>r.end('ok')).listen(6688)" >/dev/null
sleep 2
APPLY --check >/dev/null; [ $? = 1 ] && ok "--check: exposed (exit 1)" || bad "--check should be 1"
APPLY --apply; rc=$?
[ $rc = 0 ] && ok "--apply exit 0" || bad "--apply rc=$rc (a refusal here would be a false refusal for an installer-made container)"
echo "   docker port: $(docker port $CL)"
docker port $CL 6688/tcp | grep -q "^127.0.0.1:$HOSTPORT\$" && ok "published on 127.0.0.1:$HOSTPORT only" || bad "bindings: $(docker port $CL)"
docker port $CL 6688/tcp | grep -qE '^(0.0.0.0|\[::\])' && bad "still on a public address" || ok "no 0.0.0.0 / [::] binding left"
[ "$(curl -s http://127.0.0.1:$HOSTPORT/)" = "ok" ] && ok "serves on loopback" || bad "loopback request failed"
LAN=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$LAN" ]; then curl -s -m 3 http://$LAN:$HOSTPORT/ >/dev/null && bad "reachable on the LAN address $LAN" || ok "NOT reachable on the LAN address $LAN"; fi
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' $CL | grep -q unless-stopped && ok "restart policy kept" || bad "restart policy"
docker inspect -f '{{.HostConfig.LogConfig.Config}}' $CL | grep -q 'max-size:100m' && ok "log options kept" || bad "log opts"
docker inspect -f '{{.HostConfig.ExtraHosts}}' $CL | grep -q 'host.docker.internal:host-gateway' && ok "--add-host kept" || bad "add-host"
docker inspect -f '{{.HostConfig.NetworkMode}}' $CL | grep -q "$NET" && ok "network kept" || bad "network"
docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}}{{end}}' $CL | grep -q "$DIR:/chainlink" && ok "/chainlink mount kept" || bad "mount"
docker inspect -f 'tty={{.Config.Tty}} stdin={{.Config.OpenStdin}}' $CL | grep -q "tty=true stdin=true" && ok "tty/stdin kept" || bad "tty/stdin"
docker inspect -f '{{.State.Running}}' $CL | grep -q true && ok "running" || bad "not running"
[ -z "$(docker ps -aq --filter name=$CL- )" ] && ok "no leftover -new/-prev containers" || bad "leftovers: $(docker ps -a --format '{{.Names}}' --filter name=$CL-)"
out=$(docker run --rm --network $NET node:20.18.1-bookworm node -e "require('http').get('http://$CL:6688/',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))})")
[ "$out" = "ok" ] && ok "a peer on the network still reaches the container's own port" || bad "peer: $out"
[ "$(q)" = "1" ] && ok "the database is still reachable by name" || bad "DB after recreate: $(q)"

echo "== a stopped container is refused, untouched"
docker stop $CL >/dev/null
APPLY --revert >/dev/null 2>&1; rc=$?
[ $rc = 1 ] && ok "--revert on a stopped container is refused (exit 1)" || bad "stopped --revert rc=$rc"
[ "$(docker inspect -f '{{.State.Running}}' $CL)" = false ] && [ -z "$(docker ps -aq --filter name=$CL- )" ] && ok "nothing changed" || bad "the stopped container was touched"
docker start $CL >/dev/null; sleep 1

echo "== revert"
APPLY --revert >/dev/null; rc=$?
[ $rc = 0 ] && ok "--revert exit 0" || bad "--revert rc=$rc"
docker port $CL 6688/tcp | grep -qE "^0.0.0.0:$HOSTPORT\$" && ok "--revert publishes on all interfaces again" || bad "revert bindings: $(docker port $CL)"
echo "pass=$pass fail=$fail"; [ "$fail" = 0 ]
