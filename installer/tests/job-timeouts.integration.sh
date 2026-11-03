#!/bin/bash
# Node A6a, on the real binary: smartcontract/chainlink:2.23.0 with Postgres, anvil
# and a fake External Adapter. What the design reads from Chainlink's source is
# measured here. It needs Docker and linux/amd64 (the image has no arm64 variant);
# installer.yml runs it on every change to chainlink-node/ or installer/.
#
#   default    the 10 m default, the config rendered from the template, a restart
#              taking a config change and nothing else taking it, a stale job measured,
#              replaced by apply-job-timeouts.sh with its id, and then answering a real
#              OracleRequest log; each limit cutting a run, at a scale of seconds.
#   JOB_TIMEOUTS_FULL=1   adds the real scale: a bridge call of 660 s, past the old
#              300 s and past the 10 m default, on two nodes side by side (12 minutes):
#              one on the default config, cut at 600 s, one on the template, answered.
#
# Everything is named job-timeouts-<run id> and removed at the end.
# Run: bash installer/tests/job-timeouts.integration.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v docker >/dev/null || { echo "docker is required"; exit 1; }
if [ "$(docker info --format '{{.Architecture}}')" != "x86_64" ]; then
    echo "smartcontract/chainlink:2.23.0 is linux/amd64 only and this daemon is $(docker info --format '{{.Architecture}}'): run this on amd64 (CI does)"
    exit 1
fi
exec python3 -u - "$ROOT" <<'PY'
import datetime, http.server, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

ROOT = sys.argv[1]
REPO = os.path.dirname(ROOT)
TOOL = os.path.join(ROOT, 'util', 'apply-job-timeouts.sh')
JOB_TEMPLATE = open(os.path.join(REPO, 'chainlink-node', 'basicJobSpec')).read()
CONFIG_TEMPLATE = open(os.path.join(REPO, 'chainlink-node', 'config_template.toml')).read()
IMAGE = 'smartcontract/chainlink:2.23.0'
POSTGRES = 'postgres:16-alpine'
# @verdikta/common's BASE_IMAGE_PINS.foundry, the release the code runner's forge comes from.
FOUNDRY = 'ghcr.io/foundry-rs/foundry@sha256:f00b023f65e3aab6b7f994dd13b9faff1441aba92df60a53850cb644a4b8b3b5'
# An anvil dev account, unlocked by anvil itself: no key is involved.
DEV_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
RUN = 'job-timeouts-' + secrets.token_hex(3)
EMAIL = 'it@example.test'
PASSWORD = 'Zz9!Yy8@' + secrets.token_hex(16)
KEYSTORE = 'Qq7#Ww6$' + secrets.token_hex(16)
DB_PASSWORD = secrets.token_hex(16)
FULL = os.environ.get('JOB_TIMEOUTS_FULL') == '1'
OLD_LIMIT = 300

work = tempfile.mkdtemp(prefix=RUN + '-')
containers = []
passed = failed = 0

def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  ok   {name}' + (f'  ({detail})' if detail else ''))
    else:
        failed += 1
        print(f'  FAIL {name}' + (f'  ({detail})' if detail else ''))

def sh(*args, check=True, timeout=600):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f'{" ".join(args)}: exit {r.returncode}: {r.stderr[-2000:]}')
    return r

def cleanup():
    for c in reversed(containers):
        sh('docker', 'rm', '-f', '-v', c, check=False)
    sh('docker', 'network', 'rm', RUN, check=False)
    shutil.rmtree(work, ignore_errors=True)

# ── A fake External Adapter ──────────────────────────────────────────────────
seen = []
class FakeEA(http.server.BaseHTTPRequestHandler):
    delay = {}
    def log_message(self, *a):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        seen.append({'path': self.path, 'body': body, 'at': time.time()})
        time.sleep(FakeEA.delay.get(self.path, 0))
        out = json.dumps({'jobRunID': '1', 'statusCode': 200, 'status': 'success',
                          'data': {'aggregatedScore': [600000, 400000], 'justificationCid': 'QmFakeJustification'}}).encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except (BrokenPipeError, ConnectionResetError):
            pass
ea = http.server.ThreadingHTTPServer(('0.0.0.0', 0), FakeEA)
threading.Thread(target=ea.serve_forever, daemon=True).start()
EA_URL = f'http://host.docker.internal:{ea.server_port}'

# ── Nodes ────────────────────────────────────────────────────────────────────
def render_config(without_job_pipeline=False, max_run=None, default_timeout=None):
    text = CONFIG_TEMPLATE
    nodes = f'[[EVM.Nodes]]\nName="anvil"\nWSURL="ws://{RUN}-anvil:8545"\nHTTPURL="http://{RUN}-anvil:8545"\n'
    for k, v in {'<CHAIN_ID>': '31337', '<TIP_CAP_DEFAULT>': '1 gwei', '<FEE_CAP_DEFAULT>': '20 gwei', '<EVM_NODES_BLOCK>': nodes}.items():
        text = text.replace(k, v)
    if without_job_pipeline:
        text = re.sub(r'^\[JobPipeline\]\n(?:^[^\[\n][^\n]*\n)*\n?', '', text, flags=re.M)
    if max_run is not None:
        text = re.sub(r'^MaxRunDuration = .*$', f'MaxRunDuration = "{max_run}"', text, flags=re.M)
    if default_timeout is not None:
        text = re.sub(r'^DefaultTimeout = .*$', f'DefaultTimeout = "{default_timeout}"', text, flags=re.M)
    return text

class Node:
    def __init__(self, name, config):
        self.name = f'{RUN}-{name}'
        self.dir = os.path.join(work, name)
        os.makedirs(self.dir)
        os.chmod(self.dir, 0o777)
        self.pg = self.name + '-pg'
        self.config_path = os.path.join(self.dir, 'config.toml')
        self.api_path = os.path.join(self.dir, '.api')
        open(self.config_path, 'w').write(config)
        open(self.api_path, 'w').write(f'{EMAIL}\n{PASSWORD}\n')
        open(os.path.join(self.dir, 'secrets.toml'), 'w').write(
            f"[Database]\nURL = 'postgresql://postgres:{DB_PASSWORD}@{self.pg}:5432/postgres?sslmode=disable'\n"
            f"[Password]\nKeystore = '{KEYSTORE}'\n")
        for f in os.listdir(self.dir):
            os.chmod(os.path.join(self.dir, f), 0o644)
        containers.append(self.pg)
        sh('docker', 'run', '-d', '--name', self.pg, '--network', RUN, '-e', f'POSTGRES_PASSWORD={DB_PASSWORD}', POSTGRES)
        # Over TCP: the image's first, init-only server listens on the socket alone.
        for _ in range(60):
            if sh('docker', 'exec', self.pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False).returncode == 0:
                break
            time.sleep(1)
        containers.append(self.name)
        self.create()
        self.jar = None

    def create(self):
        sh('docker', 'run', '-d', '--name', self.name, '--network', RUN, '-v', f'{self.dir}:/chainlink',
           '--add-host=host.docker.internal:host-gateway', '-p', '127.0.0.1::6688', IMAGE,
           'node', '-config', '/chainlink/config.toml', '-secrets', '/chainlink/secrets.toml', 'start', '-a', '/chainlink/.api')
        self.wait()

    def wait(self):
        self.url = 'http://' + sh('docker', 'port', self.name, '6688/tcp').stdout.strip().split('\n')[0]
        for _ in range(180):
            try:
                self.login()
                return
            except Exception:
                time.sleep(1)
        print(sh('docker', 'logs', '--tail', '60', self.name, check=False).stderr[-4000:])
        raise RuntimeError(f'{self.name} did not come up')

    def restart(self):
        sh('docker', 'restart', self.name)
        self.wait()

    def login(self):
        req = urllib.request.Request(self.url + '/sessions', json.dumps({'email': EMAIL, 'password': PASSWORD}).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.cookie = r.headers.get('Set-Cookie').split(';')[0]

    def api(self, method, path, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data, {'Content-Type': 'application/json', 'Cookie': self.cookie}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def effective(self, key='MaxRunDuration'):
        _, d = self.api('GET', '/v2/config')
        text = d['data']['attributes']['config']
        m = re.search(r'^\[JobPipeline\]\n(?:[^\[\n][^\n]*\n)*?%s = \'([^\']*)\'' % key, text, re.M)
        return m.group(1) if m else None

    def tool(self, *args):
        env = {**os.environ, 'VERDIKTA_CHAINLINK_URL': self.url, 'VERDIKTA_CHAINLINK_API_FILE': self.api_path,
               'VERDIKTA_JOB_BACKUP_DIR': os.path.join(self.dir, 'job-backups')}
        r = subprocess.run([TOOL, *args], capture_output=True, text=True, env=env, timeout=300)
        return r.returncode, r.stdout + r.stderr

    def job_by_ext(self, ext):
        _, d = self.api('GET', '/v2/jobs?size=1000')
        return next((j for j in d['data'] if j['attributes']['externalJobID'] == ext), None)

    def add_bridge(self, name, url):
        code, d = self.api('POST', '/v2/bridge_types', {'name': name, 'url': url, 'confirmations': 0, 'minimumContractPayment': '0'})
        if code >= 300:
            raise RuntimeError(f'bridge: {code} {d}')

    def add_job(self, toml):
        code, d = self.api('POST', '/v2/jobs', {'toml': toml})
        if code >= 300:
            raise RuntimeError(f'job: {code} {d}\n{toml}')
        return d['data']

    def runs(self, job_id):
        _, d = self.api('GET', f'/v2/jobs/{job_id}/runs?size=20')
        return d.get('data', [])

    def wait_run(self, job_id, before, seconds):
        """A run that started after `before` and has finished its bridge task, or None."""
        until = time.time() + seconds
        while time.time() < until:
            for run in self.runs(job_id):
                if run['id'] in before:
                    continue
                a = run['attributes']
                if a.get('finishedAt'):
                    return run
                fetch = next((t for t in a.get('taskRuns', []) if t.get('dotId') == 'fetch'), None)
                if fetch and fetch.get('finishedAt'):
                    return run
            time.sleep(1)
        return None

def stamp(text):
    return datetime.datetime.fromisoformat(re.sub(r'(\.\d{6})\d*', r'\1', text).replace('Z', '+00:00')).timestamp()

def fetch_of(run):
    return next(t for t in run['attributes']['taskRuns'] if t['dotId'] == 'fetch')

def run_seconds(run):
    t = fetch_of(run)
    return stamp(t['finishedAt']) - stamp(t['createdAt'])

def webhook_toml(name, max_task, bridge_timeout, path):
    return f'''type = "webhook"
schemaVersion = 1
name = "{name}"
maxTaskDuration = "{max_task}"
observationSource = """
fetch [type="bridge" name="{path}" timeout="{bridge_timeout}" requestData="{{\\\\"data\\\\": {{}}}}"];
"""
'''

def run_webhook(node, job, seconds):
    before = {r['id'] for r in node.runs(job['id'])}
    # The answer comes when the run ends, so the POST is not waited on; the run is read from the list.
    threading.Thread(target=lambda: node.api('POST', f"/v2/jobs/{job['attributes']['externalJobID']}/runs", {}, timeout=seconds + 30), daemon=True).start()
    return node.wait_run(job['id'], before, seconds)

def render_job(i, contract, max_task='840s', bridge='840s'):
    text = JOB_TEMPLATE
    text = text.replace('{JOB_NAME}', f'Verdikta AI Arbiter {i}').replace('{FROM_ADDRESS}', DEV_ACCOUNT).replace('{CONTRACT_ADDRESS}', contract).replace('<CHAIN_ID>', '31337')
    text = re.sub(r'^maxTaskDuration = "[^"]*"', f'maxTaskDuration = "{max_task}"', text, flags=re.M)
    return re.sub(r'timeout="[^"]*"', f'timeout="{bridge}"', text)

def cast(*args):
    return sh('docker', 'exec', f'{RUN}-anvil', 'cast', *args).stdout.strip()

def send(*args):
    # The options first: `--create` takes everything after it as the constructor's.
    return json.loads(cast('send', '--rpc-url', 'http://localhost:8545', '--unlocked', '--from', DEV_ACCOUNT, '--json', *args))

TOPIC0 = None
def deploy_emitter():
    """A contract that logs OracleRequest: topic1 = the first 32 bytes of its calldata, data = the rest."""
    global TOPIC0
    TOPIC0 = cast('keccak', 'OracleRequest(bytes32,address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)')[2:]
    runtime = '600035' + '7f' + TOPIC0 + '60203603' + '8060206000' + '37' + '6000' + 'a2' + '00'
    size = len(runtime) // 2
    init = '60' + format(size, '02x') + '80600b6000396000f3' + runtime
    # EIP-55: a job's contractAddress must carry the checksum.
    return cast('to-check-sum-address', send('--create', '0x' + init)['contractAddress'])

def cbor_text(s):
    b = s.encode()
    assert len(b) < 24
    return bytes([0x60 + len(b)]) + b

def emit_request(contract, ext):
    spec_id = ext.replace('-', '').encode().hex()
    cbor = (cbor_text('cid') + cbor_text('QmIntegration') + cbor_text('aggId') + cbor_text('agg1')).hex()
    data = cast('abi-encode', 'f(address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)',
                DEV_ACCOUNT, '0x' + secrets.token_hex(32), '0', DEV_ACCOUNT, '0x12345678', '4000000000', '1', '0x' + cbor)[2:]
    receipt = send(contract, '0x' + spec_id + data)
    if receipt.get('status') != '0x1' or not receipt.get('logs'):
        raise RuntimeError(f'the OracleRequest log was not emitted: {receipt}')

# ── The run ──────────────────────────────────────────────────────────────────
def main():
    sh('docker', 'network', 'create', RUN)
    sh('docker', 'pull', IMAGE, timeout=900)
    containers.append(f'{RUN}-anvil')
    sh('docker', 'run', '-d', '--name', f'{RUN}-anvil', '--network', RUN, '--entrypoint', 'anvil', FOUNDRY,
       '--host', '0.0.0.0', '--block-time', '1', '--chain-id', '31337', timeout=600)
    for _ in range(60):
        if sh('docker', 'exec', f'{RUN}-anvil', 'cast', 'block-number', '--rpc-url', 'http://localhost:8545', check=False).returncode == 0:
            break
        time.sleep(1)
    contract = deploy_emitter()
    print(f'emitter at {contract}')

    print('\n== the 10 m default, and a config change at a restart ==')
    a = Node('a', render_config(without_job_pipeline=True))
    ok('no [JobPipeline]: the node runs 10 m', a.effective() == '10m0s', a.effective())
    rc, out = a.tool('--check')
    ok('--check reads it and says below', rc == 1 and '10m0s' in out, f'rc={rc}')
    rc, out = a.tool('--config', a.config_path)
    ok('--config sets it', rc == 0, f'rc={rc}')
    ok('the running node has not changed', a.effective() == '10m0s', a.effective())
    a.restart()
    ok('after a restart it runs 15 m', a.effective() == '15m0s', a.effective())
    rc, out = a.tool('--check')
    ok('--check: nothing stale, no job yet', rc == 0, f'rc={rc}: {out[-300:]}')

    print('\n== the template renders and a stale job is replaced with its id ==')
    a.add_bridge('verdikta-ai', EA_URL + '/a')
    stale = a.add_job(render_job(1, contract, '300s', '300s'))
    fresh = a.add_job(render_job(2, contract))
    ext = stale['attributes']['externalJobID']
    dag_before = stale['attributes']['pipelineSpec']['dotDagSource']
    ok('the job stores what it was created with', stale['attributes']['maxTaskDuration'] == '5m0s', stale['attributes']['maxTaskDuration'])
    ok('the template job stores 840 s', fresh['attributes']['maxTaskDuration'] == '14m0s' and 'timeout="840s"' in fresh['attributes']['pipelineSpec']['dotDagSource'], fresh['attributes']['maxTaskDuration'])
    a.restart()
    again = a.job_by_ext(ext)
    ok('a restart does not reach a job', again['attributes']['maxTaskDuration'] == '5m0s', again['attributes']['maxTaskDuration'])
    rc, out = a.tool('--check')
    ok('--check: the stale job, named', rc == 1 and 'Verdikta AI Arbiter 1' in out and '5m0s' in out, f'rc={rc}')
    ok('--check: not the fresh one', 'Verdikta AI Arbiter 2' not in out)
    rc, out = a.tool('--apply')
    ok('--apply', rc == 0, f'rc={rc}: {out[-600:]}')
    after = a.job_by_ext(ext)
    ok('the id is kept', after is not None)
    ok('it is a new job row', after['id'] != stale['id'], f"{stale['id']} -> {after['id']}")
    ok('840 s on the job', after['attributes']['maxTaskDuration'] in ('840s', '14m0s'), after['attributes']['maxTaskDuration'])
    dag = after['attributes']['pipelineSpec']['dotDagSource']
    ok('840 s on the bridge', 'timeout="840s"' in dag)
    ok('the rest of the DAG, byte for byte', dag == re.sub(r'timeout="300s"', 'timeout="840s"', dag_before))
    for key in ('name', 'type', 'schemaVersion', 'directRequestSpec'):
        was, now = stale['attributes'][key], after['attributes'][key]
        if key == 'directRequestSpec':
            was = {k: v for k, v in was.items() if k not in ('createdAt', 'updatedAt', 'initiator')}
            now = {k: v for k, v in now.items() if k not in ('createdAt', 'updatedAt', 'initiator')}
        ok(f'{key} is kept', was == now, f'{was} -> {now}' if was != now else '')
    rc, out = a.tool('--check')
    ok('--check after --apply', rc == 0, f'rc={rc}: {out[-300:]}')

    print('\n== the replaced job answers a real OracleRequest under its id ==')
    before = len(seen)
    emit_request(contract, ext)
    until = time.time() + 180
    while time.time() < until and len(seen) == before:
        time.sleep(1)
    ok('the log reached the bridge', len(seen) > before)
    if len(seen) > before:
        body = seen[-1]['body']
        ok('the job\'s request, through the replaced job', body.get('data', {}).get('cid') == 'QmIntegration' and body.get('data', {}).get('aggId') == 'agg1', json.dumps(body)[:200])
        ok('the id it reports is the one kept', body.get('id') == ext, body.get('id'))

    print('\n== each limit cuts a run, at a scale of seconds ==')
    b = Node('b', render_config(max_run='15s', default_timeout='2s'))
    b.add_bridge('slow', EA_URL + '/slow')
    FakeEA.delay['/slow'] = 25
    roomy = b.add_job(webhook_toml('roomy', '90s', '90s', 'slow'))
    run = run_webhook(b, roomy, 60)
    ok('MaxRunDuration 15 s cuts a 25 s call, whatever the job says', run is not None and fetch_of(run).get('error') and 13 <= run_seconds(run) <= 20,
       f"{run and run_seconds(run):.1f}s: {run and fetch_of(run).get('error')}" if run else 'no run')
    text = open(b.config_path).read()
    open(b.config_path, 'w').write(re.sub(r'^MaxRunDuration = .*$', 'MaxRunDuration = "60s"', text, flags=re.M))
    ok('a file change does not reach a running node', b.effective() == '15s', b.effective())
    b.restart()
    ok('a restart does', b.effective() == '1m0s', b.effective())
    run = run_webhook(b, roomy, 60)
    ok('the same job now answers at 25 s: DefaultTimeout 2 s does not cap a bridge with a timeout', run is not None and not fetch_of(run).get('error') and 23 <= run_seconds(run) <= 30,
       f"{run and run_seconds(run):.1f}s: {run and fetch_of(run).get('error')}" if run else 'no run')
    short_job = b.add_job(webhook_toml('short-job', '8s', '90s', 'slow'))
    run = run_webhook(b, short_job, 60)
    ok('maxTaskDuration cuts it', run is not None and fetch_of(run).get('error') and 6 <= run_seconds(run) <= 12,
       f"{run and run_seconds(run):.1f}s" if run else 'no run')
    short_bridge = b.add_job(webhook_toml('short-bridge', '90s', '8s', 'slow'))
    run = run_webhook(b, short_bridge, 60)
    ok('the bridge timeout cuts it', run is not None and fetch_of(run).get('error') and 6 <= run_seconds(run) <= 12,
       f"{run and run_seconds(run):.1f}s" if run else 'no run')

    if FULL:
        print('\n== the real scale: a 660 s bridge call, on the default config and on the template ==')
        c = Node('c', render_config(without_job_pipeline=True))
        d = Node('d', render_config())
        FakeEA.delay['/full'] = 660
        ok('the default config runs 10 m', c.effective() == '10m0s', c.effective())
        ok('the template runs 15 m', d.effective() == '15m0s', d.effective())
        jobs = {}
        for node in (c, d):
            node.add_bridge('verdikta-ai', EA_URL + '/full')
            jobs[node] = node.add_job(render_job(1, contract))
        before = {node: {r['id'] for r in node.runs(jobs[node]['id'])} for node in (c, d)}
        emit_request(contract, jobs[c]['attributes']['externalJobID'])
        emit_request(contract, jobs[d]['attributes']['externalJobID'])
        started = time.time()
        results = {}
        threads = [threading.Thread(target=lambda n=n: results.__setitem__(n, n.wait_run(jobs[n]['id'], before[n], 800))) for n in (c, d)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        print(f'  ({time.time() - started:.0f}s of waiting)')
        rc_run, rd_run = results[c], results[d]
        ok('default config: the 840 s job is cut at 600 s', rc_run is not None and fetch_of(rc_run).get('error') and 590 <= run_seconds(rc_run) <= 615,
           f"{run_seconds(rc_run):.0f}s: {fetch_of(rc_run).get('error')}" if rc_run else 'no run')
        ok('template: the 840 s job answers at 660 s, past the old 300 s and the 10 m default', rd_run is not None and not fetch_of(rd_run).get('error') and 655 <= run_seconds(rd_run) <= 680,
           f"{run_seconds(rd_run):.0f}s: {fetch_of(rd_run).get('error')}" if rd_run else 'no run')

try:
    main()
except Exception as e:  # any setup failure is a failure of this test, never a skip
    failed += 1
    print(f'FAIL setup: {e}')
    for name in containers:
        logs = sh('docker', 'logs', '--tail', '25', name, check=False)
        print(f'--- {name}\n{logs.stdout[-1500:]}{logs.stderr[-1500:]}')
finally:
    cleanup()
print(f'\npass={passed} fail={failed}')
sys.exit(0 if failed == 0 and passed > 0 else 1)
PY
