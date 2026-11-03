#!/bin/bash
# installer/util/apply-job-timeouts.sh (node A6a, design §11) against a stub of
# Chainlink's API: what it sets in config.toml, what it measures on a live node,
# and how it replaces a stale job. The stub's jobs are rendered from the repo's
# own basicJobSpec, so a template the tool cannot round-trip fails here.
# installer/tests/job-timeouts.integration.sh does the same against the real
# 2.23.0 binary.
# Run: bash installer/tests/job-timeouts-apply.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
TOOL="$ROOT/util/apply-job-timeouts.sh"
JOB_TEMPLATE="$REPO/chainlink-node/basicJobSpec"
CFG_TEMPLATE="$REPO/chainlink-node/config_template.toml"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
is()    { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2], want [$3]"; fi; }

[ -x "$TOOL" ] || { echo "FAIL: $TOOL is missing or not executable"; echo "pass=0 fail=1"; exit 1; }

T=$(mktemp -d)
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

# ── config.toml ──────────────────────────────────────────────────────────────
# The rendered template, as a node before this release has it: no [JobPipeline].
new_config() { sed 's/<CHAIN_ID>/84532/; s/<TIP_CAP_DEFAULT>/2 gwei/; s/<FEE_CAP_DEFAULT>/30 gwei/; s/<EVM_NODES_BLOCK>//' "$CFG_TEMPLATE"; }
old_config() { new_config | python3 -c "
import re, sys
print(re.sub(r'(?:^#[^\n]*\n)*^\[JobPipeline\]\n(?:^[^\[\n][^\n]*\n)*\n?', '', sys.stdin.read(), flags=re.M), end='')"; }

run_tool() { # sets rc and out
    rc=0
    out=$("$TOOL" "$@" 2>&1) || rc=$?
}

C="$T/config.toml"
old_config > "$C"; chmod 600 "$C"
grep -q '^\[JobPipeline\]$' "$C" && bad "fixture: the old config still has [JobPipeline]" || ok
run_tool --config-check "$C"; is "old config: check says below" "$rc" 1
has "old config: check says why" "$out" "MaxRunDuration"
cmp -s "$C" <(old_config) && ok || bad "--config-check changed the file"
run_tool --config "$C"; is "old config: set" "$rc" 0
# Byte for byte what a fresh install renders: check_chainlink_config then finds no difference to report.
if cmp -s "$C" <(new_config); then ok; else bad "the patched old config is not the new template: $(diff "$C" <(new_config) | head -10)"; fi
ls "$C".backup.* >/dev/null 2>&1 && ok || bad "no backup of the old config"
cmp -s "$(ls "$C".backup.* | head -1)" <(old_config) && ok || bad "the backup is not the old config"
mode=$(python3 -c "import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))" "$C")
is "the config keeps its mode" "$mode" "0o600"
run_tool --config-check "$C"; is "patched config: check says fine" "$rc" 0
before=$(ls "$C".backup.* | wc -l)
run_tool --config "$C"; is "patched config: set again is a no-op" "$rc" 0
is "a no-op takes no second backup" "$(ls "$C".backup.* | wc -l)" "$before"
rm -f "$C".backup.*

printf '[Log]\nLevel = "warn"\n\n[JobPipeline]\nMaxSuccessfulRuns = 5\nMaxRunDuration = "10m"\nReaperInterval = "1h"\n\n[JobPipeline.HTTPRequest]\nDefaultTimeout = "300s"\n' > "$C"
run_tool --config "$C"; is "10m: raised" "$rc" 0
grep -qE '^MaxRunDuration = "15m"$' "$C" && ok || bad "10m was not raised to 15m: $(cat "$C")"
grep -q '^MaxSuccessfulRuns = 5$' "$C" && grep -q '^ReaperInterval = "1h"$' "$C" && ok || bad "the operator's other keys were not kept"
[ "$(grep -c '^MaxRunDuration' "$C")" = "1" ] && ok || bad "a second MaxRunDuration line was added"
rm -f "$C".backup.*

for keep in "'20m'" '"1h"' '"900s"' "'15m0s'" '"0s"' '"0"'; do
    printf '[JobPipeline]\nMaxRunDuration = %s\n' "$keep" > "$C"
    cp "$C" "$C.was"
    run_tool --config-check "$C"; is "$keep is enough" "$rc" 0
    run_tool --config "$C"; is "$keep is kept" "$rc" 0
    cmp -s "$C" "$C.was" && ok || bad "$keep was changed"
done

for wrong in '"soon"' '"5"' '""' '"-1m"'; do
    printf '[JobPipeline]\nMaxRunDuration = %s\n' "$wrong" > "$C"
    cp "$C" "$C.was"
    run_tool --config-check "$C"; is "unreadable $wrong: check" "$rc" 1
    run_tool --config "$C"; is "unreadable $wrong: refuses to guess" "$rc" 1
    cmp -s "$C" "$C.was" && ok || bad "unreadable $wrong was changed"
done

printf '[Log]\nLevel = "warn"\n' > "$C"
run_tool --config "$C"; is "no [JobPipeline] at all: added" "$rc" 0
run_tool --config-check "$C"; is "added at the end: check says fine" "$rc" 0
rm -f "$C".backup.*

# A commented-out key and another table's key do not count.
printf '[JobPipeline]\n# MaxRunDuration = "1h"\n\n[Other]\nMaxRunDuration = "1h"\n' > "$C"
run_tool --config-check "$C"; is "a comment and another table do not count" "$rc" 1
run_tool --config "$C"; is "... set" "$rc" 0
python3 - "$C" <<'PY' && ok || bad "the key went into the wrong table: $(cat "$C")"
import sys
lines = open(sys.argv[1]).read().splitlines()
section = lines[lines.index('[JobPipeline]') + 1:lines.index('[Other]')]
sys.exit(0 if 'MaxRunDuration = "15m"' in section else 1)
PY
rm -f "$C".backup.*

run_tool --config "$T/none.toml"; is "no file: --config" "$rc" 2
run_tool --config-check "$T/none.toml"; is "no file: --config-check" "$rc" 2

# ── The stub of Chainlink's API ──────────────────────────────────────────────
cat > "$T/stub.py" <<'PY'
import json, os, re, sys, uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

state_file = sys.argv[1]
def load():
    with open(state_file) as f:
        return json.load(f)
def save(state):
    with open(state_file, 'w') as f:
        json.dump(state, f)

def from_toml(text):
    """Enough of TOML for what the tool sends; the integration test has the real parser."""
    def scalar(key):
        m = re.search(r'^%s\s*=\s*"?([^"\n]*)"?\s*$' % key, text, re.M)
        return m.group(1) if m else None
    src = re.search(r'^observationSource\s*=\s*"""\n?(.*?)"""\s*$', text, re.M | re.S)
    dag = src.group(1).replace('\\"', '\0').replace('\\\\', '\\').replace('\0', '"') if src else None
    return {
        'name': scalar('name'), 'type': scalar('type'), 'schemaVersion': int(scalar('schemaVersion') or 0),
        'externalJobID': scalar('externalJobID'), 'maxTaskDuration': scalar('maxTaskDuration'),
        'evmChainID': scalar('evmChainID'), 'gasLimit': None, 'forwardingAllowed': False,
        'directRequestSpec': {'contractAddress': scalar('contractAddress'), 'evmChainID': scalar('evmChainID'),
                              'minIncomingConfirmations': None, 'minContractPaymentLinkJuels': None, 'requesters': None},
        'pipelineSpec': {'id': 99, 'jobID': 99, 'dotDagSource': dag},
    }

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        if self.path == '/sessions' and code == 200:
            self.send_header('Set-Cookie', 'clsession=stub; Path=/')
        self.end_headers()
        self.wfile.write(data)
    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')
    def authed(self):
        if 'clsession=stub' in (self.headers.get('Cookie') or ''):
            return True
        self.reply(401, {'errors': [{'detail': 'Unauthorized'}]})
        return False
    def do_POST(self):
        s = load()
        if self.path == '/sessions':
            b = self.body()
            ok = b.get('email') == s['email'] and b.get('password') == s['password']
            return self.reply(200 if ok else 401, {'data': {}} if ok else {'errors': [{'detail': 'bad'}]})
        if not self.authed():
            return
        if self.path == '/v2/jobs':
            b = self.body()
            s['calls'].append({'method': 'POST', 'toml': b['toml']})
            if s.get('post') == 'fail':
                save(s)
                return self.reply(500, {'errors': [{'detail': 'cannot add'}]})
            a = from_toml(b['toml'])
            s['next'] += 1
            s['jobs'].append({'id': str(s['next']), 'type': 'jobs', 'attributes': a})
            save(s)
            return self.reply(200, {'data': s['jobs'][-1]})
        self.reply(404, {})
    def do_PUT(self):
        s = load()
        if not self.authed():
            return
        job_id = self.path.rsplit('/', 1)[1]
        b = self.body()
        s['calls'].append({'method': 'PUT', 'id': job_id, 'toml': b['toml']})
        mode = s.get('put', 'ok')
        if s.get('put_after') is not None:
            # the first N PUTs succeed; the rest behave as `put`
            done = sum(1 for c in s['calls'] if c['method'] == 'PUT') - 1
            mode = 'ok' if done < s['put_after'] else mode
        if mode == 'refuse':
            save(s)
            return self.reply(422, {'errors': [{'detail': 'invalid spec'}]})
        s['jobs'] = [j for j in s['jobs'] if j['id'] != job_id]
        if mode == 'gone':
            save(s)
            return self.reply(500, {'errors': [{'detail': 'deleted, then could not add'}]})
        a = from_toml(b['toml'])
        if mode == 'mangle':
            a['externalJobID'] = str(uuid.uuid4())
            s['put'] = 'ok'
        if mode == 'mangle-other':
            a['pipelineSpec']['dotDagSource'] = a['pipelineSpec']['dotDagSource'] + '\n// changed by the node\n'
            s['put'] = 'ok'
        if mode == 'mangle-field':
            a['directRequestSpec']['contractAddress'] = '0x00000000000000000000000000000000000000Bb'
            s['put'] = 'ok'
        if mode == 'mangle-field-always':
            a['directRequestSpec']['contractAddress'] = '0x00000000000000000000000000000000000000Bb'
        s['next'] += 1
        s['jobs'].append({'id': str(s['next']), 'type': 'jobs', 'attributes': a})
        save(s)
        self.reply(200, {'data': s['jobs'][-1]})
    def do_GET(self):
        s = load()
        if self.path == '/health':
            return self.reply(200, {})
        if not self.authed():
            return
        if self.path.startswith('/v2/jobs'):
            return self.reply(200, {'data': s['jobs']})
        if self.path.startswith('/v2/config'):
            return self.reply(200, {'data': {'attributes': {'config': s['config']}}})
        self.reply(404, {})

server = HTTPServer(('127.0.0.1', 0), H)
with open(sys.argv[2], 'w') as f:
    f.write(str(server.server_port))
server.serve_forever()
PY

# The fixture: jobs as a node stores them, from the repo's template with its own TOML decoding.
cat > "$T/fixture.py" <<'PY'
import json, re, sys
template = open(sys.argv[1]).read()
out = sys.argv[2]
OLD = re.sub(r'timeout="\d+s"', 'timeout="300s" # increase timeout to 300s', template)
def dag_of(text):
    raw = re.search(r'observationSource = """\n?(.*?)"""', text, re.S).group(1)
    raw = re.sub(r'\\\n\s*', '', raw)                       # a line-ending backslash
    return raw.replace('\\\\', '\0').replace('\\"', '"').replace('\0', '\\')
def job(i, ext, source, max_task):
    return {'id': str(i), 'type': 'jobs', 'attributes': {
        'name': 'Verdikta AI Arbiter %d' % i, 'type': 'directrequest', 'schemaVersion': 1,
        'externalJobID': ext, 'maxTaskDuration': max_task, 'evmChainID': '84532', 'gasLimit': None, 'forwardingAllowed': False,
        'directRequestSpec': {'contractAddress': '0x00000000000000000000000000000000000000Aa', 'evmChainID': '84532',
                              'minIncomingConfirmations': None, 'minContractPaymentLinkJuels': None, 'requesters': None},
        'pipelineSpec': {'id': i, 'jobID': i, 'dotDagSource': dag_of(source)}}}
foreign = {'id': '50', 'type': 'jobs', 'attributes': {
    'name': 'Somebody else', 'type': 'webhook', 'schemaVersion': 1, 'externalJobID': '99999999-9999-4999-8999-999999999999',
    'maxTaskDuration': '0s', 'pipelineSpec': {'id': 50, 'jobID': 50, 'dotDagSource': 'a [type="http" method=GET url="http://x" timeout="1s"];'}}}
state = {
    'email': 'op@example.test', 'password': 'not-a-real-password-7d1',
    'next': 100, 'calls': [],
    'config': "[Log]\nLevel = 'warn'\n\n[JobPipeline]\nMaxRunDuration = '15m0s'\n",
    'jobs': [
        job(1, '11111111-1111-4111-8111-111111111111', OLD, '5m0s'),
        job(2, '22222222-2222-4222-8222-222222222222', OLD, '5m0s'),
        job(3, '33333333-3333-4333-8333-333333333333', template, '14m0s'),
        foreign,
    ],
}
json.dump(state, open(out, 'w'))
PY

export VERDIKTA_JOB_BACKUP_DIR="$T/job-backups"
printf 'op@example.test\nnot-a-real-password-7d1\n' > "$T/.api"
export VERDIKTA_CHAINLINK_API_FILE="$T/.api"
state() { python3 -c "
import json, sys
s = json.load(open('$T/state.json'))
print(eval(sys.argv[1]))" "$1"; }
set_state() { python3 -c "
import json, sys
s = json.load(open('$T/state.json'))
exec(sys.argv[1])
json.dump(s, open('$T/state.json', 'w'))" "$1"; }
reset_stub() {
    python3 "$T/fixture.py" "$JOB_TEMPLATE" "$T/state.json"
    rm -rf "$VERDIKTA_JOB_BACKUP_DIR"
}
reset_stub
python3 "$T/stub.py" "$T/state.json" "$T/port" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; python3 -c 'import time; time.sleep(0.1)'; done
export VERDIKTA_CHAINLINK_URL="http://127.0.0.1:$(cat "$T/port")"

job_field() { state "next(j for j in s['jobs'] if j['attributes']['externalJobID'] == '$1')['attributes']$2"; }
ID1=11111111-1111-4111-8111-111111111111
ID2=22222222-2222-4222-8222-222222222222

# ── --check measures ─────────────────────────────────────────────────────────
run_tool --check; is "--check: stale jobs" "$rc" 1
has "--check names the stale job" "$out" "Verdikta AI Arbiter 1"
has "--check says what it read" "$out" "300s"
has "--check says what it read (job)" "$out" "5m0s"
hasnt "--check: never the password" "$out" "not-a-real-password"
is "--check changes nothing" "$(state "len(s['calls'])")" "0"

set_state "
for j in s['jobs']:
    if j['attributes']['type'] == 'directrequest':
        j['attributes']['maxTaskDuration'] = '14m0s'
        j['attributes']['pipelineSpec']['dotDagSource'] = j['attributes']['pipelineSpec']['dotDagSource'].replace('timeout=\"300s\" # increase timeout to 300s', 'timeout=\"840s\"')
"
run_tool --check; is "--check: every job at 840 s" "$rc" 0
has "--check: says how many" "$out" "3 job"

set_state "s['config'] = \"[JobPipeline]\nMaxRunDuration = '10m0s'\n\""
run_tool --check; is "--check: the node runs below 15m" "$rc" 1
has "--check: names the node's value" "$out" "10m0s"
set_state "s['config'] = \"[Log]\nLevel = 'warn'\n\""
run_tool --check; is "--check: an effective config that cannot be read is not fine" "$rc" 2

reset_stub
set_state "s['jobs'] = [j for j in s['jobs'] if j['attributes']['type'] != 'directrequest']"
run_tool --check; is "--check: no Verdikta job is nothing to do" "$rc" 0
has "--check: says so" "$out" "no Verdikta"

reset_stub
set_state "s['password'] = 'another'"
run_tool --check; is "--check: a login refused cannot measure" "$rc" 2
hasnt "--check: refused login never prints the password" "$out" "not-a-real-password"
reset_stub

rc=0; out=$(VERDIKTA_CHAINLINK_API_FILE="$T/none" "$TOOL" --check 2>&1) || rc=$?
is "--check: no credentials file cannot measure" "$rc" 2
rc=0; out=$(VERDIKTA_CHAINLINK_URL="http://127.0.0.1:9" "$TOOL" --check 2>&1) || rc=$?
is "--check: a node that does not answer cannot measure" "$rc" 2
rc=0; started=$(date +%s); out=$(VERDIKTA_CHAINLINK_URL="http://127.0.0.1:9" "$TOOL" --check --wait 2 2>&1) || rc=$?
is "--check --wait: still down" "$rc" 2
[ $(( $(date +%s) - started )) -ge 2 ] && ok || bad "--wait did not wait"

# ── --apply replaces the stale jobs, keeping their ids ───────────────────────
reset_stub
dag_before=$(job_field $ID1 "['pipelineSpec']['dotDagSource']")
run_tool --apply; is "--apply: done" "$rc" 0
hasnt "--apply: never the password" "$out" "not-a-real-password"
is "--apply: two PUTs, the stale ones" "$(state "[c['id'] for c in s['calls'] if c['method'] == 'PUT']")" "['1', '2']"
is "--apply: no POST" "$(state "[c for c in s['calls'] if c['method'] == 'POST']")" "[]"
is "job 1 keeps its id" "$(job_field $ID1 "['name']")" "Verdikta AI Arbiter 1"
is "job 2 keeps its id" "$(job_field $ID2 "['name']")" "Verdikta AI Arbiter 2"
is "job 1's maxTaskDuration" "$(job_field $ID1 "['maxTaskDuration']")" "840s"
is "job 3 was not touched" "$(job_field 33333333-3333-4333-8333-333333333333 "['maxTaskDuration']")" "14m0s"
is "the foreign job was not touched" "$(state "next(j for j in s['jobs'] if j['id'] == '50')['attributes']['maxTaskDuration']")" "0s"
dag_after=$(job_field $ID1 "['pipelineSpec']['dotDagSource']")
has "the bridge's timeout" "$dag_after" 'timeout="840s"'
hasnt "the old timeout is gone" "$dag_after" '300s'
# Only that attribute of the DAG moved, so nothing else about a text-mode job did.
want=$(printf '%s' "$dag_before" | sed 's/timeout="300s" # increase timeout to 300s/timeout="840s"/')
is "the rest of the job's DAG, byte for byte" "$dag_after" "$want"
[ -n "$(ls "$VERDIKTA_JOB_BACKUP_DIR" 2>/dev/null)" ] && ok || bad "no spec saved before replacing"
grep -rq "not-a-real-password" "$VERDIKTA_JOB_BACKUP_DIR" && bad "the saved spec holds the password" || ok
run_tool --check; is "--check after --apply" "$rc" 0
before=$(state "len(s['calls'])")
run_tool --apply; is "--apply again: nothing to do" "$rc" 0
is "--apply again sends nothing" "$(state "len(s['calls'])")" "$before"

# Refused by validation: the node changed nothing (PUT validates before it deletes).
reset_stub
set_state "s['put'] = 'refuse'"
run_tool --apply; is "refused: failed" "$rc" 1
is "refused: job 1 unchanged" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"
is "refused: nothing restored" "$(state "[c for c in s['calls'] if c['method'] == 'POST']")" "[]"
is "refused: stops at the first failure" "$(state "len([c for c in s['calls'] if c['method'] == 'PUT'])")" "1"
has "refused: says the node's reason" "$out" "422"

# Deleted, then could not add: put the old job back under its id.
reset_stub
set_state "s['put'] = 'gone'"
run_tool --apply; is "gone: failed" "$rc" 1
is "gone: restored under the same id" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"
has "gone: restored with its old DAG" "$(job_field $ID1 "['pipelineSpec']['dotDagSource']")" 'timeout="300s"'
is "gone: job 2 not touched" "$(job_field $ID2 "['maxTaskDuration']")" "5m0s"

# ... and the restore fails too: say so, and where the spec is.
reset_stub
set_state "s['put'] = 'gone'; s['post'] = 'fail'"
run_tool --apply; is "lost: exit 3" "$rc" 3
has "lost: names the job" "$out" "Verdikta AI Arbiter 1"
has "lost: names the external id" "$out" "$ID1"
has "lost: names the saved spec" "$out" "$VERDIKTA_JOB_BACKUP_DIR"
saved=$(grep -rl "$ID1" "$VERDIKTA_JOB_BACKUP_DIR" | head -1)
[ -n "$saved" ] && grep -q 'maxTaskDuration = "5m0s"' "$saved" && ok || bad "the saved spec is not the old job: $saved"

# The node answers with something else than was sent: do not trust it, put the old job back.
reset_stub
set_state "s['put'] = 'mangle'"
run_tool --apply; is "another id came back: failed" "$rc" 1
has "another id came back: says so" "$out" "externalJobID"
is "another id came back: old job restored" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"

reset_stub
set_state "s['put'] = 'mangle-other'"
run_tool --apply; is "another DAG came back: failed" "$rc" 1
is "another DAG came back: old job restored" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"

# A job with only its maxTaskDuration stale: the old and the new DAG are the same bytes, so the DAG alone cannot tell.
only_task_stale='
for j in s["jobs"]:
    if j["id"] == "1":
        j["attributes"]["pipelineSpec"]["dotDagSource"] = next(x for x in s["jobs"] if x["id"] == "3")["attributes"]["pipelineSpec"]["dotDagSource"]
'
reset_stub
set_state "$only_task_stale"
set_state "s['put'] = 'mangle-field'"
run_tool --apply; is "another contract came back, same DAG: failed" "$rc" 1
has "another contract came back: says so" "$out" "contractAddress"
is "another contract came back: old values restored" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"
is "another contract came back: old contract restored" "$(job_field $ID1 "['directRequestSpec']['contractAddress']")" "0x00000000000000000000000000000000000000Aa"

# ... and the restore comes back wrong too: not called restored.
reset_stub
set_state "$only_task_stale"
set_state "s['put'] = 'mangle-field-always'"
run_tool --apply; is "the restore comes back wrong: exit 3" "$rc" 3
has "the restore comes back wrong: says so" "$out" "COULD NOT RESTORE"

# The old job back but under another maxTaskDuration is not the old job.
reset_stub
set_state "$only_task_stale"
set_state "s['put'] = 'gone'"
run_tool --apply; is "only maxTaskDuration stale, deleted, restored: failed" "$rc" 1
is "only maxTaskDuration stale: the restored job has its own value" "$(job_field $ID1 "['maxTaskDuration']")" "5m0s"

# Job 1 done, job 2 fails: job 1 stays done, the rerun finishes the rest.
reset_stub
set_state "s['put'] = 'refuse'; s['put_after'] = 1"
run_tool --apply; is "second job fails: failed" "$rc" 1
is "second job fails: the first stays replaced" "$(job_field $ID1 "['maxTaskDuration']")" "840s"
set_state "s['put'] = 'ok'; s['put_after'] = None"
run_tool --apply; is "second job fails: rerun finishes" "$rc" 0
is "rerun: the second is replaced" "$(job_field $ID2 "['maxTaskDuration']")" "840s"

# Can't log in: nothing is sent.
reset_stub
set_state "s['password'] = 'another'"
run_tool --apply; is "--apply: login refused" "$rc" 2
is "--apply: login refused sends nothing" "$(state "len(s['calls'])")" "0"

# A DAG the tool cannot edit is a failure, never a guess.
reset_stub
set_state "
for j in s['jobs']:
    if j['id'] == '1':
        j['attributes']['pipelineSpec']['dotDagSource'] = 'fetch [type=\"bridge\" name=\"verdikta-ai\" requestData=\"{}\"]'
"
run_tool --check; is "a bridge with no timeout: stale" "$rc" 1
run_tool --apply; is "a bridge with no timeout: refuses" "$rc" 1
has "a bridge with no timeout: says so" "$out" "Verdikta AI Arbiter 1"
is "a bridge with no timeout: job untouched" "$(state "[c for c in s['calls'] if c.get('id') == '1']")" "[]"

# A job in another layout is the same job: spaces in the attributes, another order, `]` in a value.
reset_stub
set_state "
for j in s['jobs']:
    if j['id'] == '1':
        j['attributes']['pipelineSpec']['dotDagSource'] = 'fetch [timeout = \"300s\", requestData=\"{\\\\\"a\\\\\": [1]}\", type = \"bridge\", name = \"verdikta-ai\"];\nother [type=\"bridge\" name=\"someone-else\" timeout=\"1s\"];\n'
"
run_tool --check; is "another layout: measured, and stale" "$rc" 1
has "another layout: names the job" "$out" "Verdikta AI Arbiter 1"
has "another layout: reads its timeout" "$out" "bridge timeout 300s"
run_tool --apply; is "another layout: replaced" "$rc" 0
dag=$(job_field $ID1 "['pipelineSpec']['dotDagSource']")
has   "another layout: its bridge at 840 s" "$dag" 'timeout = "840s"'
has   "another layout: another bridge's timeout untouched" "$dag" 'name="someone-else" timeout="1s"'
hasnt "another layout: nothing left at 300 s" "$dag" '300s'

# The arbiter's job by name, with no verdikta-ai bridge in it (a renamed bridge): never quietly left out.
reset_stub
set_state "
for j in s['jobs']:
    if j['id'] == '1':
        j['attributes']['pipelineSpec']['dotDagSource'] = 'fetch [type=\"bridge\" name=\"renamed\" timeout=\"300s\"];'
"
run_tool --check; is "a Verdikta job with no verdikta-ai bridge: not fine" "$rc" 1
has "... named" "$out" "Verdikta AI Arbiter 1"
run_tool --apply; is "... refused" "$rc" 1
is "... untouched" "$(state "[c for c in s['calls'] if c.get('id') == '1']")" "[]"

# Several bridge tasks of ours: all of them count, and all are replaced.
reset_stub
set_state "
for j in s['jobs']:
    if j['id'] == '1':
        j['attributes']['maxTaskDuration'] = '14m0s'
        j['attributes']['pipelineSpec']['dotDagSource'] = 'a [type=\"bridge\" name=\"verdikta-ai\" timeout=\"840s\"];\nb [type=\"bridge\" name=\"verdikta-ai\" timeout=\"300s\"];\n'
    elif j['attributes']['type'] == 'directrequest':
        j['attributes']['maxTaskDuration'] = '14m0s'
        j['attributes']['pipelineSpec']['dotDagSource'] = 'a [type=\"bridge\" name=\"verdikta-ai\" timeout=\"840s\"];\n'
"
run_tool --check; is "a second bridge task below target: stale" "$rc" 1
run_tool --apply; is "a second bridge task: replaced" "$rc" 0
hasnt "a second bridge task: at 840 s" "$(job_field $ID1 "['pipelineSpec']['dotDagSource']")" '300s'

# ── Usage ────────────────────────────────────────────────────────────────────
run_tool; [ "$rc" != "0" ] && ok || bad "no arguments must not succeed"
run_tool --nonsense; [ "$rc" != "0" ] && ok || bad "an unknown argument must not succeed"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
