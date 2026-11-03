#!/bin/bash
#
# Verdikta Arbiter - the 840 s job timeouts on a live node (design §11)
#
# A code-review evaluation works for up to 780 s behind the bridge. Three limits
# in Chainlink 2.23.0 have to allow it, and a template change reaches none of them
# on a running node:
#
#   maxTaskDuration, the bridge's timeout   stored in each job when it is created
#   [JobPipeline] MaxRunDuration            read from config.toml at the node's start;
#                                           the default of 10 m ends a run at 600 s
#
# This tool sets the one key in config.toml and replaces each stale job with
# PUT /v2/jobs/:id (Chainlink validates the spec before it deletes the old job). Each
# job keeps its externalJobID, which is what an OracleRequest's specId and the
# dispatcher's registration name, so nothing happens on-chain and no stake moves. Only
# the two timeouts change, so a text-mode request is treated as before, with a longer
# ceiling. Everything is measured: --check reads the live jobs and the node's effective
# config, and --apply compares what the node answers with what it sent; on any
# difference it puts the old job back.
#
# Usage:
#   apply-job-timeouts.sh --config-check FILE    0 enough, 1 below or unreadable, 2 no file
#   apply-job-timeouts.sh --config FILE          0 enough or set (the old file is kept as
#                                                FILE.backup.<time>), 1 not set, 2 no file.
#                                                Takes effect at the node's next start.
#   apply-job-timeouts.sh --check [--wait SEC]   0 all at target (or no Verdikta job),
#                                                1 a job or the node is below target,
#                                                2 could not measure
#   apply-job-timeouts.sh --apply [--wait SEC]   0 replaced and verified (or nothing to do),
#                                                1 failed, every job as it was or already
#                                                replaced, 2 could not reach the node,
#                                                3 failed and a job could not be restored:
#                                                the output names it and its saved spec
#
# upgrade-arbiter.sh runs --config before its restart and --check/--apply after it.
# Standalone, on a node that declined them:
#   apply-job-timeouts.sh --config ~/.chainlink-<network>/config.toml
#   <restart the arbiter>   then   apply-job-timeouts.sh --apply
#
# Credentials are read from ~/.chainlink-*/.api (or VERDIKTA_CHAINLINK_API_FILE) and
# never printed. VERDIKTA_CHAINLINK_URL overrides http://localhost:6688.
# VERDIKTA_JOB_BACKUP_DIR overrides where each job's old spec is saved
# (<this script's directory>/chainlink-node/jobs/before-840s).
#
set -u

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$SCRIPT_DIR" exec python3 - "$@" <<'PY'
import datetime, http.cookiejar, json, os, re, shutil, stat, sys, tempfile, time, urllib.error, urllib.request

# Mirrors chainlink-node/basicJobSpec and config_template.toml: installer/tests/job-timeouts-values.test.sh reads both.
JOB_SECONDS = 840
JOB_VALUE = "840s"
RUN_SECONDS = 900
BRIDGE = "verdikta-ai"
# Byte for byte what the template holds: a patched config then has nothing to differ on.
RUN_BLOCK = "[JobPipeline]\nMaxRunDuration = \"15m\"\n\n"
OLD_COMMENT = re.compile(r"[ \t]*# increase timeout to \d+s")

UNITS = {"ns": 1e-9, "us": 1e-6, "µs": 1e-6, "ms": 1e-3, "s": 1, "m": 60, "h": 3600}

def go_seconds(text):
    """A Go duration in seconds, or None. Zero needs no unit, as in Go."""
    if not isinstance(text, str):
        return None
    if text == "0":
        return 0
    if not re.fullmatch(r"(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+", text):
        return None
    return sum(float(n) * UNITS[u] for n, u in re.findall(r"(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)", text))

def enough(seconds, need):
    """0 means no limit, to a job task and to the run alike."""
    return seconds is not None and (seconds == 0 or seconds >= need)

# ── config.toml ──────────────────────────────────────────────────────────────
HEADER = re.compile(r"^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$")
KEY = re.compile(r"""^(\s*)MaxRunDuration(\s*=\s*)(["'])([^"']*)\3(.*)$""")

def read_run_key(lines):
    """(index of [JobPipeline] or None, index of its MaxRunDuration or None, the value or None)."""
    section = None
    in_section = False
    for i, line in enumerate(lines):
        header = HEADER.match(line)
        if header:
            in_section = header.group(1).strip() == "JobPipeline"
            if in_section:
                section = i
            continue
        if in_section and not line.lstrip().startswith("#"):
            if re.match(r"\s*MaxRunDuration\s*=", line):
                m = KEY.match(line)
                return section, i, m.group(4) if m else ""
    return section, None, None

def config_check(path):
    try:
        lines = open(path, encoding="utf-8").read().splitlines(keepends=True)
    except FileNotFoundError:
        print(f"No Chainlink config at {path}.")
        return 2
    except OSError as e:
        print(f"Cannot read {path}: {e.strerror}.")
        return 2
    _, _, value = read_run_key(lines)
    if value is None:
        print(f"{path} has no [JobPipeline] MaxRunDuration: Chainlink 2.23.0 runs its default of 10m, below the {RUN_SECONDS} s a code-review job needs.")
        return 1
    seconds = go_seconds(value)
    if seconds is None:
        print(f"{path}: MaxRunDuration = {value!r} is not a duration.")
        return 1
    if not enough(seconds, RUN_SECONDS):
        print(f"{path}: MaxRunDuration = {value} is below the {RUN_SECONDS} s a code-review job needs.")
        return 1
    print(f"{path}: MaxRunDuration = {value} is enough.")
    return 0

def config_set(path):
    try:
        text = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        print(f"No Chainlink config at {path}.")
        return 2
    except OSError as e:
        print(f"Cannot read {path}: {e.strerror}.")
        return 1
    lines = text.splitlines(keepends=True)
    section, key_at, value = read_run_key(lines)
    if value is not None:
        seconds = go_seconds(value)
        if seconds is None:
            print(f"{path}: MaxRunDuration = {value!r} is not a duration; left as it is. Fix it by hand.")
            return 1
        if enough(seconds, RUN_SECONDS):
            print(f"{path}: MaxRunDuration = {value} is enough.")
            return 0
        m = KEY.match(lines[key_at])
        lines[key_at] = f"{m.group(1)}MaxRunDuration{m.group(2)}\"15m\"{m.group(5)}\n"
    elif section is not None:
        lines.insert(section + 1, "MaxRunDuration = \"15m\"\n")
    else:
        # Before its first sub-table, as the template has it; else at the end.
        first = next((i for i, l in enumerate(lines) if (HEADER.match(l) and HEADER.match(l).group(1).strip().startswith("JobPipeline."))), None)
        if first is not None:
            lines.insert(first, RUN_BLOCK)
        else:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.append("\n" + RUN_BLOCK.rstrip("\n") + "\n")
    backup = f"{path}.backup.{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    try:
        shutil.copy2(path, backup)
        fd, tmp = tempfile.mkstemp(prefix=".config-", dir=os.path.dirname(os.path.abspath(path)))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("".join(lines))
            os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
            os.replace(tmp, path)
        except OSError:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    except OSError as e:
        print(f"Could not write {path}: {e.strerror}. It is unchanged.")
        return 1
    print(f"{path}: MaxRunDuration set to 15m (it takes effect at the node's next start). The old file is {backup}.")
    return 0

# ── The node ─────────────────────────────────────────────────────────────────
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

    def effective_run_limit(self):
        code, body = self.call("GET", "/v2/config")
        if code >= 300:
            raise NodeError(f"the node answered GET /v2/config with HTTP {code}")
        text = ((body.get("data") or {}).get("attributes") or {}).get("config")
        if not isinstance(text, str):
            raise NodeError("the node's /v2/config holds no config")
        _, _, value = read_run_key(text.splitlines())
        if value is None:
            raise NodeError("the node's effective config names no [JobPipeline] MaxRunDuration")
        return value

def is_arbiter_job(job):
    a = job.get("attributes") or {}
    dag = (a.get("pipelineSpec") or {}).get("dotDagSource") or ""
    return a.get("type") == "directrequest" and re.search(r"name=\"%s\"" % BRIDGE, dag) is not None

def bridge_attr(dag):
    """The match of the bridge task's timeout attribute, or None."""
    m = re.search(r"name=\"%s\"" % BRIDGE, dag)
    if not m:
        return None
    return re.compile(r"timeout=\"([^\"]*)\"").search(dag, m.end(), dag.find("]", m.end()) if dag.find("]", m.end()) >= 0 else len(dag))

def read_job(job):
    a = job["attributes"]
    dag = a["pipelineSpec"]["dotDagSource"]
    timeout = bridge_attr(dag)
    return {"id": job["id"], "name": a.get("name"), "external": a.get("externalJobID"),
            "task": a.get("maxTaskDuration"), "bridge": timeout.group(1) if timeout else None, "dag": dag}

def is_stale(job):
    j = read_job(job)
    return not (enough(go_seconds(j["task"]), JOB_SECONDS) and enough(go_seconds(j["bridge"]), JOB_SECONDS))

def toml_string(text):
    return json.dumps(text, ensure_ascii=False)

def toml_multiline(text):
    # The DAG as a TOML basic multi-line string: a first newline would be trimmed, so one is added.
    escaped = text.replace("\\", "\\\\").replace("\"\"\"", "\"\"\\\"")
    return "\"\"\"\n" + escaped + "\"\"\""

SPEC_KEYS = ("contractAddress", "minIncomingConfirmations", "minContractPaymentLinkJuels", "requesters")

def toml_for(job, task, dag):
    a = job["attributes"]
    spec = a.get("directRequestSpec") or {}
    chain = spec.get("evmChainID") or a.get("evmChainID")
    lines = [
        "type = \"directrequest\"",
        f"schemaVersion = {int(a.get('schemaVersion') or 1)}",
        f"name = {toml_string(a.get('name') or '')}",
        f"externalJobID = {toml_string(a['externalJobID'])}",
        f"contractAddress = {toml_string(spec['contractAddress'])}",
        f"maxTaskDuration = {toml_string(task)}",
    ]
    if chain is not None:
        lines.append(f"evmChainID = {toml_string(str(chain))}")
    if spec.get("minIncomingConfirmations") is not None:
        lines.append(f"minIncomingConfirmations = {int(spec['minIncomingConfirmations'])}")
    if spec.get("minContractPaymentLinkJuels") is not None:
        lines.append(f"minContractPaymentLinkJuels = {toml_string(str(spec['minContractPaymentLinkJuels']))}")
    if spec.get("requesters"):
        lines.append("requesters = [" + ", ".join(toml_string(r) for r in spec["requesters"]) + "]")
    if a.get("gasLimit") is not None:
        lines.append(f"gasLimit = {int(a['gasLimit'])}")
    if a.get("forwardingAllowed"):
        lines.append("forwardingAllowed = true")
    lines.append("observationSource = " + toml_multiline(dag))
    return "\n".join(lines) + "\n"

def new_dag(dag):
    t = bridge_attr(dag)
    if t is None:
        return None
    head, tail = dag[:t.start()], dag[t.end():]
    return head + f"timeout=\"{JOB_VALUE}\"" + OLD_COMMENT.sub("", tail, count=1)

def what_differs(sent, got, dag):
    """Why the job the node answered with is not the one sent, or None."""
    a, b = sent["attributes"], got.get("attributes") or {}
    problems = []
    for key in ("name", "type", "schemaVersion", "externalJobID", "gasLimit", "forwardingAllowed"):
        if a.get(key) != b.get(key):
            problems.append(f"{key} came back as {b.get(key)!r}")
    was, now = a.get("directRequestSpec") or {}, b.get("directRequestSpec") or {}
    for key in SPEC_KEYS + ("evmChainID",):
        if was.get(key) != now.get(key):
            problems.append(f"directRequestSpec.{key} came back as {now.get(key)!r}")
    if ((b.get("pipelineSpec") or {}).get("dotDagSource")) != dag:
        problems.append("the DAG came back changed")
    if not enough(go_seconds(b.get("maxTaskDuration")), JOB_SECONDS):
        problems.append(f"maxTaskDuration came back as {b.get('maxTaskDuration')!r}")
    return "; ".join(problems) or None

def backup_dir():
    return os.environ.get("VERDIKTA_JOB_BACKUP_DIR") or os.path.join(os.environ["SCRIPT_DIR"], "chainlink-node", "jobs", "before-840s")

def by_external(jobs, external):
    return next((j for j in jobs if (j.get("attributes") or {}).get("externalJobID") == external), None)

def check(wait):
    node = Node()
    try:
        node.login(wait)
        jobs = [j for j in node.jobs() if is_arbiter_job(j)]
        limit = node.effective_run_limit()
    except NodeError as e:
        print(f"Could not measure the node: {e}.")
        return 2
    rc = 0
    if not enough(go_seconds(limit), RUN_SECONDS):
        print(f"The node runs [JobPipeline] MaxRunDuration = {limit}, below {RUN_SECONDS} s. Set it with --config, then restart the node.")
        rc = 1
    else:
        print(f"The node runs [JobPipeline] MaxRunDuration = {limit}.")
    if not jobs:
        print("This node has no Verdikta job yet: nothing else to measure.")
        return rc
    stale = [j for j in jobs if is_stale(j)]
    for job in stale:
        j = read_job(job)
        print(f"  stale: {j['name']} ({j['external']}): maxTaskDuration {j['task']}, bridge timeout {j['bridge'] or 'none'}; wanted {JOB_VALUE}")
    if stale:
        rc = 1
    else:
        print(f"All {len(jobs)} job(s) allow {JOB_VALUE}.")
    return rc

def apply(wait):
    node = Node()
    try:
        node.login(wait)
        jobs = [j for j in node.jobs() if is_arbiter_job(j)]
    except NodeError as e:
        print(f"Could not reach the node: {e}.")
        return 2
    stale = [j for j in jobs if is_stale(j)]
    if not stale:
        print(f"Nothing to replace: {len(jobs)} Verdikta job(s), none stale.")
        return 0
    # A DAG the tool cannot edit stops the run before anything changes.
    for job in stale:
        if new_dag(job["attributes"]["pipelineSpec"]["dotDagSource"]) is None:
            j = read_job(job)
            print(f"{j['name']} ({j['external']}) has no bridge timeout to change: replace it by hand. Nothing was changed.")
            return 1
    saved = backup_dir()
    try:
        os.makedirs(saved, exist_ok=True)
        specs = {}
        for job in stale:
            a = job["attributes"]
            spec_path = os.path.join(saved, f"{a['externalJobID']}.toml")
            with open(spec_path, "w", encoding="utf-8") as f:
                f.write(toml_for(job, a["maxTaskDuration"], a["pipelineSpec"]["dotDagSource"]))
            specs[job["id"]] = spec_path
    except OSError as e:
        print(f"Could not save the old specs under {saved}: {e.strerror}. Nothing was changed.")
        return 1

    for job in stale:
        a = job["attributes"]
        name, external = a.get("name"), a["externalJobID"]
        old_dag = a["pipelineSpec"]["dotDagSource"]
        old_toml = toml_for(job, a["maxTaskDuration"], old_dag)
        dag = new_dag(old_dag)
        problem = None
        answered = None
        try:
            code, body = node.call("PUT", f"/v2/jobs/{job['id']}", {"toml": toml_for(job, JOB_VALUE, dag)}, timeout=60)
            if code >= 300:
                problem = f"the node answered HTTP {code}"
            else:
                answered = body.get("data") or {}
                problem = what_differs(job, answered, dag)
        except NodeError as e:
            problem = str(e)
        if problem is None:
            print(f"  {name} ({external}): replaced, {JOB_VALUE}, same id.")
            continue
        print(f"  {name} ({external}): {problem}.")
        # Where is the job now? PUT validates before it deletes, so a refusal leaves it
        # as it was; after that it may be gone, or there under what the node made of it.
        try:
            current = node.jobs()
            row = by_external(current, external)
            if row is None and answered:
                row = next((j for j in current if j["id"] == answered.get("id")), None)
            if row is not None and row["attributes"].get("externalJobID") == external:
                if row["attributes"]["pipelineSpec"]["dotDagSource"] == old_dag:
                    print(f"  {name}: unchanged on the node. Nothing else was tried.")
                    return 1
                if what_differs(job, row, dag) is None:
                    print(f"  {name}: replaced after all, {JOB_VALUE}, same id.")
                    continue
            if row is not None:
                code, _ = node.call("PUT", f"/v2/jobs/{row['id']}", {"toml": old_toml}, timeout=60)
            else:
                code, _ = node.call("POST", "/v2/jobs", {"toml": old_toml}, timeout=60)
            if code >= 300:
                raise NodeError(f"the node answered HTTP {code}")
            back = by_external(node.jobs(), external)
            if back is None or back["attributes"]["pipelineSpec"]["dotDagSource"] != old_dag:
                raise NodeError("the node does not show it back")
        except NodeError as e:
            print(f"COULD NOT RESTORE {name} ({external}): {e}. Its old spec is {specs[job['id']]}: POST it to the node, or the on-chain registration of that job id goes unanswered. Directory: {saved}")
            return 3
        print(f"  {name}: the old job is back, under the same id. Nothing else was tried.")
        return 1
    print(f"Replaced {len(stale)} job(s). The old specs are under {saved}.")
    return 0

args = sys.argv[1:]
wait = 0
if "--wait" in args:
    i = args.index("--wait")
    try:
        wait = float(args[i + 1])
    except (IndexError, ValueError):
        print("--wait needs a number of seconds", file=sys.stderr)
        sys.exit(64)
    del args[i:i + 2]
if args[:1] == ["--config-check"] and len(args) == 2:
    sys.exit(config_check(args[1]))
if args[:1] == ["--config"] and len(args) == 2:
    sys.exit(config_set(args[1]))
if args == ["--check"]:
    sys.exit(check(wait))
if args == ["--apply"]:
    sys.exit(apply(wait))
print("usage: apply-job-timeouts.sh --config-check FILE | --config FILE | --check [--wait SEC] | --apply [--wait SEC]", file=sys.stderr)
sys.exit(64)
PY
