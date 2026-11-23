#!/bin/bash
#
# Verdikta Arbiter - one health job per registered arbiter job (v2 keeper; verdikta-dispatcher
# TODO item 16, decided 2026-11-20)
#
# The v2 keeper sends health calls that each registered job must answer within 60 s with the next
# value of its hash chain, or it is frozen (not selectable) until it answers. A Chainlink cron job per
# job does that (chainlink-node/healthJobSpec): every 10 s it reads keeper.healthState(key), and while
# a call is pending it asks the external adapter for the value over the verdikta-ai bridge and sends
# keeper.rotateChain from the node's key.
#
# The job needs the keeper's address and the job's key, which exist only once the job is registered:
# arbiter-operator/scripts/register-oracle-cl.js records them in <install>/health-chains/
# registrations.json (no secret: the seeds are in the per-key files beside it). This tool makes the
# node's health jobs match that record and the template: it creates the missing ones and replaces
# (PUT, validated by the node before it deletes the old one) those that differ. A health job has no
# on-chain identity, so replacing one moves nothing on chain.
#
# Usage:
#   apply-health-jobs.sh --check [--wait SEC]   0 every registered job has a current health job (or
#                                               nothing is registered), 1 one is missing or stale,
#                                               2 could not measure
#   apply-health-jobs.sh --apply [--wait SEC]   0 created/replaced and verified (or nothing to do),
#                                               1 failed (the output names the job), 2 could not reach
#                                               the node
#
# register-oracle.sh runs --apply after a registration, and upgrade-arbiter.sh after its restart.
# Credentials are read from ~/.chainlink-*/.api (or VERDIKTA_CHAINLINK_API_FILE) and never printed;
# the bridge token is read from <install>/external-adapter/.env and never printed either (a job's DAG
# holds it, so no DAG is printed). VERDIKTA_CHAINLINK_URL overrides http://localhost:6688.
# VERDIKTA_INSTALL_ROOT overrides the install directory (default: this script's directory when it
# holds external-adapter/, as in an install, else the repository root); HEALTH_CHAIN_DIR overrides
# <install>/health-chains.
#
set -u

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$SCRIPT_DIR" exec python3 - "$@" <<'PY'
import http.cookiejar, json, os, re, sys, time, urllib.error, urllib.request

try:
    import tomllib
except ImportError:                     # Python < 3.11
    tomllib = None

NAME_PREFIX = "Verdikta arbiter"
MARKER = "healthState(bytes32 key)"     # what makes a cron job one of ours

def install_root():
    env = os.environ.get("VERDIKTA_INSTALL_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.environ["SCRIPT_DIR"]
    if os.path.isdir(os.path.join(here, "external-adapter")):
        return here
    return os.path.abspath(os.path.join(here, "..", ".."))

def chains_dir(root):
    return os.path.abspath(os.environ.get("HEALTH_CHAIN_DIR") or os.path.join(root, "health-chains"))

# ── The node (as apply-job-timeouts.sh) ─────────────────────────────────────
class NodeError(Exception):
    pass

class Node:
    def __init__(self):
        self.url = os.environ.get("VERDIKTA_CHAINLINK_URL", "http://localhost:6688").rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data, {"Content-Type": "application/json"}, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw) if raw else {}
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise NodeError(f"the node at {self.url} did not answer {method} {path.split('?')[0]}: {getattr(e, 'reason', e)}")

    def login(self, wait):
        path = os.environ.get("VERDIKTA_CHAINLINK_API_FILE")
        if not path:
            home = os.path.expanduser("~")
            found = [os.path.join(home, d, ".api") for d in sorted(os.listdir(home)) if d.startswith(".chainlink-")] if os.path.isdir(home) else []
            found = [f for f in found if os.path.isfile(f)]
            if not found:
                raise NodeError("no Chainlink API credentials (~/.chainlink-*/.api)")
            path = found[0]
        try:
            parts = open(path, encoding="utf-8").read().split()
        except OSError as e:
            raise NodeError(f"cannot read the Chainlink API credentials: {e.strerror}")
        if len(parts) < 2:
            raise NodeError("the Chainlink API credentials file does not hold an email and a password")
        deadline = time.monotonic() + wait
        while True:
            try:
                code, _ = self.call("POST", "/sessions", {"email": parts[0], "password": parts[1]})
                if code < 300:
                    return
                if code in (401, 403):
                    raise NodeError(f"the node refused the login (HTTP {code})")
                problem = NodeError(f"the node answered the login with HTTP {code}")
            except NodeError as e:
                if "refused the login" in str(e):
                    raise
                problem = e
            if time.monotonic() >= deadline:
                raise problem
            time.sleep(min(2, max(0.1, deadline - time.monotonic())))

    def jobs(self):
        code, body = self.call("GET", "/v2/jobs?size=1000")
        if code >= 300 or not isinstance(body.get("data"), list):
            raise NodeError(f"the node answered GET /v2/jobs with HTTP {code}")
        return body["data"]

# ── What the node should hold ───────────────────────────────────────────────
class Problem(Exception):
    pass

def read_env_value(path, key):
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return None
    for line in text.splitlines():
        m = re.match(r"\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*?)\s*$", line)
        if m:
            v = m.group(1)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            return v
    return None

def registrations(root):
    path = os.path.join(chains_dir(root), "registrations.json")
    if not os.path.isfile(path):
        return None
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Problem(f"cannot read {path}: {e}")
    keeper = str(data.get("keeper") or "")
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", keeper) or not isinstance(data.get("jobs"), dict) or not data.get("chainId"):
        raise Problem(f"{path} is not a registration record (keeper, chainId, jobs)")
    jobs = {}
    for job_id, key in data["jobs"].items():
        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(key)):
            raise Problem(f"{path}: job {job_id} has no bytes32 key")
        jobs[str(job_id)] = str(key).lower()
    return {"keeper": keeper, "chainId": str(int(data["chainId"])), "jobs": jobs}

def expected_jobs(root):
    """One rendered spec per registered job: {key: {name, toml, dag, schedule, job_id}}, or {} when nothing is registered."""
    reg = registrations(root)
    if reg is None or not reg["jobs"]:
        return {}
    if tomllib is None:
        raise Problem("Python 3.11 or later is needed (tomllib) to read the health job template")
    template_path = os.path.join(root, "chainlink-node", "healthJobSpec")
    try:
        template = open(template_path, encoding="utf-8").read()
    except OSError:
        raise Problem(f"the health job template is missing: {template_path}")
    token = read_env_value(os.path.join(root, "external-adapter", ".env"), "EA_API_TOKEN")
    if not token or not re.fullmatch(r"[A-Za-z0-9_-]{32,}", token):
        raise Problem("no service credential (EA_API_TOKEN) in external-adapter/.env: configure service authentication first")
    out = {}
    for job_id, key in reg["jobs"].items():
        text = (template.replace("{JOB_NAME}", f"{NAME_PREFIX} {job_id}")
                        .replace("{KEEPER_ADDRESS}", reg["keeper"])
                        .replace("{ARBITER_KEY}", key)
                        .replace("<CHAIN_ID>", reg["chainId"])
                        .replace("{EA_API_TOKEN}", token))
        if re.search(r"\{[A-Z_]+\}|<[A-Z_]+>", text):
            raise Problem(f"the health job template has a placeholder this tool does not fill: {re.search(r'[{<][A-Z_]+[}>]', text).group(0)}")
        spec = tomllib.loads(text)
        out[key] = {"name": spec["name"], "toml": text, "dag": spec["observationSource"],
                    "schedule": spec.get("schedule"), "job_id": job_id}
    return out

def is_health_job(job):
    a = job.get("attributes") or {}
    return a.get("type") == "cron" and MARKER in ((a.get("pipelineSpec") or {}).get("dotDagSource") or "")

def live_dag(job):
    return ((job.get("attributes") or {}).get("pipelineSpec") or {}).get("dotDagSource") or ""

def live_schedule(job):
    a = job.get("attributes") or {}
    return (a.get("cronSpec") or {}).get("schedule", a.get("schedule"))

def same(job, want):
    a = job.get("attributes") or {}
    if live_dag(job).strip() != want["dag"].strip() or a.get("name") != want["name"]:
        return False
    s = live_schedule(job)
    return s is None or s == want["schedule"]

def state(node, want):
    """(present and current {key: job}, stale {key: job}, missing [key], foreign health jobs)."""
    health = [j for j in node.jobs() if is_health_job(j)]
    current, stale, missing = {}, {}, []
    for key, w in want.items():
        mine = [j for j in health if key in live_dag(j).lower()]
        good = [j for j in mine if same(j, w)]
        if good:
            current[key] = good[0]
        elif mine:
            stale[key] = mine[0]
        else:
            missing.append(key)
    others = [j for j in health if not any(k in live_dag(j).lower() for k in want)]
    return current, stale, missing, others

def label(want, key):
    return f"job {want[key]['job_id']} (key {key[:10]}…)"

def check(wait):
    root = install_root()
    try:
        want = expected_jobs(root)
    except Problem as e:
        print(f"Cannot tell what the health jobs should be: {e}.")
        return 2
    if not want:
        print("No registered job is recorded (health-chains/registrations.json): no health job is needed.")
        return 0
    node = Node()
    try:
        node.login(wait)
        current, stale, missing, others = state(node, want)
    except NodeError as e:
        print(f"Could not measure the node: {e}.")
        return 2
    for key in missing:
        print(f"  missing: the health job for {label(want, key)}")
    for key in stale:
        print(f"  stale: the health job for {label(want, key)} differs from the template or the registration")
    for job in others:
        print(f"  note: health job {(job.get('attributes') or {}).get('name')!r} is for a key that is not recorded as registered")
    if missing or stale:
        print("Run apply-health-jobs.sh --apply to create or replace them.")
        return 1
    print(f"All {len(current)} registered job(s) have a current health job.")
    return 0

def apply(wait):
    root = install_root()
    try:
        want = expected_jobs(root)
    except Problem as e:
        print(f"Cannot tell what the health jobs should be: {e}.")
        return 1
    if not want:
        print("No registered job is recorded (health-chains/registrations.json): no health job to create.")
        return 0
    node = Node()
    try:
        node.login(wait)
        current, stale, missing, _ = state(node, want)
    except NodeError as e:
        print(f"Could not reach the node: {e}.")
        return 2
    if not stale and not missing:
        print(f"Nothing to do: {len(current)} health job(s), all current.")
        return 0
    failed = []
    for key in missing:
        code, body = node.call("POST", "/v2/jobs", {"toml": want[key]["toml"]}, timeout=60)
        if code >= 300:
            failed.append(f"creating the health job for {label(want, key)}: the node answered HTTP {code}")
        else:
            print(f"Created the health job for {label(want, key)}.")
    for key, job in stale.items():
        code, body = node.call("PUT", f"/v2/jobs/{job['id']}", {"toml": want[key]["toml"]}, timeout=60)
        if code >= 300:
            # PUT validates before it deletes; if the old one is gone anyway, add the new one
            try:
                gone = not any(j.get("id") == job["id"] for j in node.jobs())
            except NodeError:
                gone = False
            if gone:
                code, _ = node.call("POST", "/v2/jobs", {"toml": want[key]["toml"]}, timeout=60)
            if code >= 300:
                failed.append(f"replacing the health job for {label(want, key)}: the node answered HTTP {code}")
                continue
        print(f"Replaced the health job for {label(want, key)}.")
    try:
        current, stale, missing, _ = state(node, want)
    except NodeError as e:
        print(f"Could not verify the health jobs: {e}.")
        return 1
    for key in list(stale) + missing:
        failed.append(f"the node does not hold a current health job for {label(want, key)} after the change")
    if failed:
        for f in dict.fromkeys(failed):
            print(f"  FAILED: {f}")
        return 1
    print(f"All {len(current)} registered job(s) have a current health job.")
    return 0

def main(argv):
    wait = 0
    mode = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--check", "--apply"):
            mode = a
        elif a == "--wait" and i + 1 < len(argv):
            i += 1
            try:
                wait = max(0, int(argv[i]))
            except ValueError:
                print("--wait takes whole seconds"); return 2
        else:
            print("Usage: apply-health-jobs.sh --check|--apply [--wait SEC]"); return 2
        i += 1
    if mode == "--check":
        return check(wait)
    if mode == "--apply":
        return apply(wait)
    print("Usage: apply-health-jobs.sh --check|--apply [--wait SEC]")
    return 2

sys.exit(main(sys.argv[1:]))
PY
