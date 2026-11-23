#!/bin/bash
# installer/util/apply-health-jobs.sh against a stub of Chainlink's API: the health job per registered
# arbiter job (v2 keeper; verdikta-dispatcher TODO item 16). The stub reads the TOML it is sent with
# Python's TOML parser, so the repo's chainlink-node/healthJobSpec must render to valid TOML here.
# What the job does on Chainlink itself is for the binary (job-timeouts.integration.sh's harness).
# Run: bash installer/tests/health-jobs-apply.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
TOOL="$ROOT/util/apply-health-jobs.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
is()    { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2], want [$3]"; fi; }

[ -x "$TOOL" ] || { echo "FAIL: $TOOL is missing or not executable"; echo "pass=0 fail=1"; exit 1; }
python3 -c 'import tomllib' 2>/dev/null || { echo "SKIP: Python 3.11+ (tomllib) is needed"; echo "pass=0 fail=0"; exit 0; }

T=$(mktemp -d)
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

I="$T/install"
mkdir -p "$I/external-adapter" "$I/chainlink-node" "$I/health-chains"
cp "$REPO/chainlink-node/healthJobSpec" "$I/chainlink-node/healthJobSpec"
TOKEN="tok_$(printf 'e%.0s' $(seq 1 60))"
printf 'PORT=8080\nEA_API_TOKEN="%s"\n' "$TOKEN" > "$I/external-adapter/.env"
export VERDIKTA_INSTALL_ROOT="$I"
KEEPER=0x00000000000000000000000000000000000000Ce
K1=0x$(printf '1%.0s' $(seq 1 64))
K2=0x$(printf '2%.0s' $(seq 1 64))
record() { # record KEEPER KEY... : registrations.json for job ids job1, job2, …
    python3 - "$I/health-chains/registrations.json" "$@" <<'PY'
import json, sys
path, keeper, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
json.dump({"version": 1, "keeper": keeper, "aggregator": "0x" + "a" * 40, "operator": "0x" + "b" * 40,
           "chainId": 84532, "jobs": {f"job{i + 1}": k for i, k in enumerate(keys)}}, open(path, "w"))
PY
}

cat > "$T/stub.py" <<'PY'
import json, sys, tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer
state_file = sys.argv[1]
def load():
    return json.load(open(state_file))
def save(s):
    json.dump(s, open(state_file, "w"))
def job_of(text, i):
    spec = tomllib.loads(text)              # a template that is not valid TOML fails here
    return {"id": str(i), "type": "jobs", "attributes": {
        "name": spec["name"], "type": spec["type"], "schemaVersion": spec["schemaVersion"],
        "cronSpec": {"schedule": spec["schedule"]}, "maxTaskDuration": spec.get("maxTaskDuration"),
        "pipelineSpec": {"id": i, "dotDagSource": spec["observationSource"]}}}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if self.path == "/sessions" and code == 200:
            self.send_header("Set-Cookie", "clsession=stub; Path=/")
        self.end_headers()
        self.wfile.write(data)
    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")
    def authed(self):
        if "clsession=stub" in (self.headers.get("Cookie") or ""):
            return True
        self.reply(401, {"errors": [{"detail": "Unauthorized"}]})
        return False
    def do_POST(self):
        s = load()
        if self.path == "/sessions":
            b = self.body()
            good = b.get("email") == s["email"] and b.get("password") == s["password"]
            return self.reply(200 if good else 401, {"data": {}} if good else {"errors": [{"detail": "bad"}]})
        if not self.authed():
            return
        if self.path == "/v2/jobs":
            b = self.body()
            s["calls"].append({"method": "POST"})
            if s.get("post") == "fail":
                save(s)
                return self.reply(422, {"errors": [{"detail": "invalid"}]})
            s["next"] += 1
            s["jobs"].append(job_of(b["toml"], s["next"]))
            save(s)
            return self.reply(200, {"data": s["jobs"][-1]})
        self.reply(404, {})
    def do_PUT(self):
        s = load()
        if not self.authed():
            return
        job_id = self.path.rsplit("/", 1)[1]
        b = self.body()
        s["calls"].append({"method": "PUT", "id": job_id})
        if s.get("put") == "refuse":
            save(s)
            return self.reply(422, {"errors": [{"detail": "invalid spec"}]})
        s["jobs"] = [j for j in s["jobs"] if j["id"] != job_id]
        s["next"] += 1
        s["jobs"].append(job_of(b["toml"], s["next"]))
        save(s)
        self.reply(200, {"data": s["jobs"][-1]})
    def do_GET(self):
        s = load()
        if not self.authed():
            return
        if self.path.startswith("/v2/jobs"):
            return self.reply(200, {"data": s["jobs"]})
        self.reply(404, {})
server = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(server.server_port))
server.serve_forever()
PY

reset_stub() {
    python3 - "$T/state.json" <<'PY'
import json, sys
arbiter = {"id": "1", "type": "jobs", "attributes": {"name": "Verdikta AI Arbiter 1", "type": "directrequest",
           "pipelineSpec": {"id": 1, "dotDagSource": "fetch [type=\"bridge\" name=\"verdikta-ai\" timeout=\"840s\"]"}}}
json.dump({"email": "op@example.test", "password": "not-a-real-password-7d1", "next": 100, "calls": [],
           "jobs": [arbiter]}, open(sys.argv[1], "w"))
PY
}
state() { python3 -c "
import json, sys
s = json.load(open('$T/state.json'))
print(eval(sys.argv[1]))" "$1"; }
set_state() { python3 -c "
import json, sys
s = json.load(open('$T/state.json'))
exec(sys.argv[1])
json.dump(s, open('$T/state.json', 'w'))" "$1"; }
run_tool() { rc=0; out=$("$TOOL" "$@" 2>&1) || rc=$?; }
health_count() { state "len([j for j in s['jobs'] if j['attributes']['type'] == 'cron'])"; }
calls() { state "[c['method'] for c in s['calls']]"; }

printf 'op@example.test\nnot-a-real-password-7d1\n' > "$T/.api"
export VERDIKTA_CHAINLINK_API_FILE="$T/.api"
reset_stub
python3 "$T/stub.py" "$T/state.json" "$T/port" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; python3 -c 'import time; time.sleep(0.1)'; done
export VERDIKTA_CHAINLINK_URL="http://127.0.0.1:$(cat "$T/port")"

# ── Nothing registered: nothing to do ────────────────────────────────────────
run_tool --check; is "unregistered: check" "$rc" 0
has "unregistered: says so" "$out" "No registered job"
run_tool --apply; is "unregistered: apply" "$rc" 0
is "unregistered: no call" "$(calls)" "[]"

# ── Two registered jobs, no health job: created, each with its key and the keeper ─
record "$KEEPER" "$K1" "$K2"
run_tool --check; is "missing: check" "$rc" 1
has "missing: names job1" "$out" "job1"
has "missing: names job2" "$out" "job2"
is "missing: check sends nothing" "$(calls)" "[]"
run_tool --apply; is "missing: apply" "$rc" 0
is "missing: two POSTs" "$(calls)" "['POST', 'POST']"
is "two health jobs" "$(health_count)" "2"
dag1=$(state "next(j for j in s['jobs'] if '$K1' in j['attributes']['pipelineSpec']['dotDagSource'])['attributes']['pipelineSpec']['dotDagSource']")
has "job1's job reads its key" "$dag1" "\"key\\\\\": \\\\\"$K1"
has "job1's job calls the keeper" "$dag1" "contract=\"$KEEPER\""
has "job1's job sends to the keeper" "$dag1" "to=\"$KEEPER\""
has "job1's job carries the bridge credential" "$dag1" "Bearer $TOKEN"
has "job1's job is on the chain" "$dag1" 'evmChainID="84532"'
hasnt "no placeholder left" "$dag1" '{ARBITER_KEY}'
is "the job's name" "$(state "next(j for j in s['jobs'] if '$K1' in j['attributes']['pipelineSpec']['dotDagSource'])['attributes']['name']")" "Verdikta arbiter job1 health"
is "the arbiter job is untouched" "$(state "s['jobs'][0]['attributes']['name']")" "Verdikta AI Arbiter 1"
hasnt "apply: never the token" "$out" "$TOKEN"
hasnt "apply: never the password" "$out" "not-a-real-password"
run_tool --check; is "after apply: check" "$rc" 0
before=$(state "len(s['calls'])")
run_tool --apply; is "apply again: nothing to do" "$rc" 0
is "apply again sends nothing" "$(state "len(s['calls'])")" "$before"

# ── The keeper changes (a new registration): stale, replaced in place ────────
NEWKEEPER=0x00000000000000000000000000000000000000Df
record "$NEWKEEPER" "$K1" "$K2"
run_tool --check; is "new keeper: stale" "$rc" 1
has "new keeper: says stale" "$out" "stale"
set_state "s['calls'] = []"
run_tool --apply; is "new keeper: apply" "$rc" 0
is "new keeper: two PUTs" "$(state "[c['method'] for c in s['calls'] if c['method'] != 'GET']")" "['PUT', 'PUT']"
is "still two health jobs" "$(health_count)" "2"
has "job1 now names the new keeper" "$(state "next(j for j in s['jobs'] if '$K1' in j['attributes']['pipelineSpec']['dotDagSource'])['attributes']['pipelineSpec']['dotDagSource']")" "$NEWKEEPER"

# ── A refused replacement: reported, the old job stays ───────────────────────
record "$KEEPER" "$K1" "$K2"
set_state "s['put'] = 'refuse'"
run_tool --apply; is "refused: failed" "$rc" 1
has "refused: names the job" "$out" "FAILED: replacing the health job for job"
has "refused: old jobs stay" "$(state "[j['attributes']['pipelineSpec']['dotDagSource'] for j in s['jobs'] if j['attributes']['type'] == 'cron'][0]")" "$NEWKEEPER"
set_state "s['put'] = 'ok'"
run_tool --apply; is "refusal over: applied" "$rc" 0

# ── A job no longer recorded: noted, never touched ───────────────────────────
record "$KEEPER" "$K1"
run_tool --check; is "unrecorded key: check is fine" "$rc" 0
has "unrecorded key: noted" "$out" "not recorded as registered"
is "unrecorded key: its job stays" "$(health_count)" "2"

# ── Cannot tell what the jobs should be ──────────────────────────────────────
printf 'PORT=8080\n' > "$I/external-adapter/.env"
run_tool --check; is "no credential: cannot measure" "$rc" 2
has "no credential: says so" "$out" "EA_API_TOKEN"
run_tool --apply; is "no credential: apply fails" "$rc" 1
printf 'PORT=8080\nEA_API_TOKEN="%s"\n' "$TOKEN" > "$I/external-adapter/.env"
printf '{"jobs": {}}' > "$I/health-chains/registrations.json"
run_tool --check; is "a broken record: cannot measure" "$rc" 2
record "$KEEPER" "$K1"

# ── The node ─────────────────────────────────────────────────────────────────
rc=0; out=$(VERDIKTA_CHAINLINK_URL="http://127.0.0.1:9" "$TOOL" --check 2>&1) || rc=$?
is "node down: check" "$rc" 2
rc=0; out=$(VERDIKTA_CHAINLINK_URL="http://127.0.0.1:9" "$TOOL" --apply 2>&1) || rc=$?
is "node down: apply" "$rc" 2
set_state "s['password'] = 'another'"
run_tool --check; is "login refused: check" "$rc" 2
hasnt "login refused: never the password" "$out" "not-a-real-password"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
