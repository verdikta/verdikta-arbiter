# code-runner

The arbiter's code runner for stake-backed security attestation
([design](../docs/development/stake-attestation-design.md) §9). The External
Adapter calls it for a claim; it runs the claim's proof of concept in a fresh,
isolated container and reports what happened. It never judges: the EA turns
gate failures into INVALID, and the jury reads the report.

This is node A1 of the build: the service shell, the isolation, the limits,
the deadline and the result taxonomy. Later nodes add the image pull and
admission (A1b), the forge steps and gates (A2a), listing checks (A2b), the
integrity checks and the fix check (A3a), the report and context pack (A3b)
and the honesty flags (A3c). See [Seams](#seams).

## Run it

```bash
cd code-runner
npm ci                       # no runtime dependencies; npm ci just checks the lockfile
CODE_RUNNER_TOKEN="$(openssl rand -hex 32)" CODE_RUNNER_RUNTIME=runc npm start
```

It refuses to start when its environment carries anything that looks like a
credential (`*_API_KEY`, `*_TOKEN`, `PRIVATE_KEY`, `IPFS_PINNING_KEY`, ...): the
runner holds no secrets. Start it with its own environment, for example

```bash
env -i PATH="$PATH" HOME="$HOME" CODE_RUNNER_TOKEN=... CODE_RUNNER_RUNTIME=runc npm start
```

### macOS (development): runc

Docker Desktop runs containers in a Linux VM with `runc`; gVisor is not
available there. Set `CODE_RUNNER_RUNTIME=runc`. `DOCKER_HOST` can stay unset:
the runner gives the docker CLI its own empty `DOCKER_CONFIG`, so the CLI uses
the default socket, `/var/run/docker.sock`, which Docker Desktop links to
`~/.docker/run/docker.sock` (set `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`
if that link is turned off). The data root lives inside the VM, so `/health`
reports `freeBytes: null` there; that alone does not make the runner unhealthy.

### Linux (arbiters): gVisor

`CODE_RUNNER_RUNTIME=runsc` (the default) needs gVisor registered as a Docker
runtime named `runsc` in the daemon the runner drives. In production that is
the runner's own `dockerd` with its own socket and a fixed-size loop-mounted
data root (§9.1; the installer sets this up in node A8), and `DOCKER_HOST`
points at its socket, e.g. `unix:///run/verdikta-code-runner/docker.sock`. The
runtime entry in that daemon's `daemon.json`:

```json
{
  "runtimes": {
    "runsc": {
      "path": "/opt/gvisor/20260928.0/runsc",
      "runtimeArgs": ["--platform=systrap", "--overlay2=root:dir=/var/lib/code-runner-scratch,size=4g"]
    }
  }
}
```

- the pinned gVisor release (`20260928.0`, SHA-512-checked; see
  `.github/workflows/code-runner.yml`), registered with `systemctl reload docker`,
  never a restart;
- `--platform=systrap`: no KVM needed;
- `--overlay2=root:dir=…,size=…` caps each container's writable layer (the `self`
  medium fails on kernel 5.4).

`/health` shows the runtime's arguments as the daemon reports them.

## API

Every request carries `Authorization: Bearer <CODE_RUNNER_TOKEN>`; without it
the answer is 401 whatever the route.

### `GET /health`

200 when a run would be admitted, 503 otherwise, with:

```json
{
  "ok": true, "reasons": [],
  "service": "verdikta-code-runner", "version": "0.1.0", "node": "v20.18.1",
  "runtime": "runsc", "runtimeAvailable": true, "runtimeArgs": ["--platform=systrap", "…"],
  "docker": { "reachable": true, "endpoint": "unix:///run/verdikta-code-runner/docker.sock", "serverVersion": "28.0.4", "osType": "linux", "architecture": "x86_64", "error": null },
  "dataRoot": { "path": "/var/lib/verdikta-code-runner/docker", "freeBytes": 38000000000, "error": null },
  "maintenance": false,
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 4096, "buildSeconds": 90, "runSeconds": 360, "…": "…" }
}
```

### `POST /v1/runs`

```json
{
  "listingCid": "Qm…", "bcid": "bafy…",
  "spec": { "…": "code_review.json" },
  "attestation": { "…": "attestation.json" },
  "pocPatch": "<base64 of poc.patch>",
  "fixPatch": null,
  "baseline": { "…": "baseline.json" },
  "finding": { "…": "finding.json" },
  "report": "<report.md>",
  "knownIssues": [],
  "priorFindings": [],
  "eaGates": { "disclosure": "pass" },
  "deadline": 700000
}
```

This extends §7.2's abridged list with `finding`, `report`, `knownIssues`,
`priorFindings` (at most 8) and `eaGates` (build plan, assumption A7: the EA
shares runs; the runner needs these for the report and the context pack).
Patches are base64 so their bytes survive JSON. `deadline` is the **remaining
time in milliseconds** when the EA sends the request (at most 900,000); the
runner stops at receipt + deadline minus `CODE_RUNNER_DEADLINE_RESERVE_MS`.

| Status | `outcome` | Meaning for the EA |
|---|---|---|
| 200 | `definitive` | Every step ended in a fact the arbiters may settle on. Gates (from A2a on) decide INVALID or the jury. |
| 503 | `abstain` | Error, no commit. `abstain.cause` says why. |
| 400 | `requester_error` | The requester's package is broken (§12): a malformed request, or a spec above the class hard limits. No work was done. `issues[]` names each problem. |
| 401 / 404 / 405 / 413 / 415 | — | Token, route, method, body size (16 MiB), content type. |

A definitive or abstaining answer looks like:

```json
{
  "outcome": "abstain", "runId": "3f2a…",
  "runner": { "version": "0.1.0", "runtime": "runsc" },
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 4096, "buildSeconds": 90, "testSeconds": 180, "runSeconds": 360, "maxPatchBytes": 2000000, "patchExpansionBytes": 50000000, "platform": "linux/amd64" },
  "abstain": { "cause": "oom", "step": "build", "detail": "a process in the sandbox was OOM-killed during the step" },
  "steps": [ { "name": "build", "outcome": "abstain", "exitCode": 1, "durationMs": 8123,
               "stdout": { "text": "…", "totalBytes": 912, "omittedBytes": 0 }, "stderr": { "…": "…" },
               "cause": "oom", "detail": "…" } ],
  "gates": {},
  "report": null, "reportSha256": null, "contextPack": null
}
```

`report`, `reportSha256` and `contextPack` stay `null` until node A3b.

## Class hard limits

`src/classLimits.js` is a local copy of `@verdikta/common`'s
`CLASS_HARD_LIMITS` (2 CPUs, 4,096 MB, 4,096 pids, 90 s build, 360 s run, 2 GB
compressed / 6 GB unpacked image, 2 MB patch, 50 MB patch expansion,
`linux/amd64`) until node A3b switches to the package. A spec may only lower
`cpus`, `memoryMb`, `buildSeconds`, `testSeconds`, `runSeconds` and
`maxPatchBytes`; anything above the class maximum, any other key, an image not
pinned by digest, another platform or an unpacked size above 6 GB is a 400
before any Docker call. The process limit is always the class's.

## Isolation

Every check gets a fresh container (`src/sandbox.js`, which builds every argv
the runner gives Docker; `test/unit/sandbox.test.js` pins it exactly):

```
docker run --detach --pull never --name vcr-<run>-<n> --label verdikta.code-runner=1 …
  --runtime runsc --network none --cap-drop ALL --security-opt no-new-privileges
  --user 10001:10001 --pids-limit 4096 --memory 4096m --memory-swap 4096m --cpus 2
  --hostname sandbox --env TZ=UTC --env LANG=C.UTF-8 --env CI=true --env PYTHONHASHSEED=0
  --log-driver none --init --entrypoint sleep <image@sha256:…> <keepalive seconds>
```

- No bind mounts, no volumes, no Docker socket, no added capability. The
  entrypoint is the runner's keepalive, not the image's; it ends the container
  shortly after the deadline even if the runner dies.
- `--pull never`: the runner never pulls implicitly (the controlled pull is
  A1b). An image that is not on the runner's disk abstains (`image_unavailable`).
- Steps run through `docker exec --user 10001:10001 <container> <argv…>`. The
  runner spawns only the docker CLI, always with an argv array and `shell:
  false` (`src/docker.js`); claim content reaches the sandbox only as stdin.
  Results are read as capped streams (`docker exec … cat`), never `docker cp`.
- The docker CLI gets an allow-listed environment (`PATH`, `HOME`,
  `DOCKER_HOST`, `DOCKER_CONFIG`, and the TLS variables with a TCP endpoint)
  and the runner's own empty `DOCKER_CONFIG`: no token, no operator credentials.
- `test/unit/policy.test.js` fails the build if `src/` gains a shell, `eval`, a
  mount flag, the Docker socket, `docker cp` or a host file write.
- The env builder must give the repository in the image to uid 10001.

## Results: definitive or abstain

`src/result.js` (§9.3, §12). A run is **definitive** only when every step
ended in a clean exit code (0-128), and later a JUnit outcome or an integrity
result; gates record their basis (`exit_code`, `junit`, `integrity`) and
cannot be decided on anything else. Everything else **abstains**:

| `abstain.cause` | When |
|---|---|
| `admission_refused` | The maintenance lock is held; the deadline leaves less than `runSeconds`; the runtime is not registered |
| `docker_unreachable` | The daemon cannot be reached (at admission or during the run) |
| `docker_error` | The daemon refused something the step did not cause |
| `image_unavailable` | The env image is not on the runner's disk |
| `step_timeout` | A step's own wall-clock limit, or the run's (`runSeconds`) |
| `deadline` | The EA's deadline |
| `oom` | The kernel's OOM flag or `oom_kill` counter, or exit 137 |
| `pids_limit` | The `pids.events` counter, or a gVisor sandbox crash at the limit (exit 2) |
| `sandbox_died` | The container died or vanished under the step |
| `killed_by_signal` | The step's process died of a signal (exit > 128): not a clean exit |
| `cancelled` | The caller hung up, or the runner is stopping |
| `runner_error` | A bug in the runner |

After every step the runner inspects the container and reads its cgroup
counters, so an OOM kill or a refused fork behind an otherwise clean exit code
still abstains.

## Time

- Admission refuses a run whose deadline, less the reserve, cannot cover
  `runSeconds`.
- Each step is bounded by its own limit, the run's `runSeconds` and the
  deadline less the reserve (5 s by default). The first to pass kills the
  container (`docker rm --force`) and the run abstains with that cause.
- Every Docker control call has its own timeout, and the run stops at the
  deadline even if a step is stuck outside Docker.
- Step logs keep the first and last 32 KiB of stdout and of stderr
  (`src/capture.js`); reads through `readFile` stop at their cap.

## Cleanup and maintenance

- Every sandbox is removed when its run ends, whatever happened.
- GC (`src/gc.js`) removes containers carrying this instance's label that no
  live run owns, or that are past their expiry label: at startup and every
  `CODE_RUNNER_GC_INTERVAL_SECONDS`.
- The maintenance lock is a file (`CODE_RUNNER_MAINTENANCE_FILE`, default
  `code-runner/.state/maintenance`). While it exists, runs are refused and
  `/health` is 503. The installer holds it during install and upgrade (A8);
  remove a stale one by hand.

## Configuration

| Variable | Default | |
|---|---|---|
| `CODE_RUNNER_TOKEN` / `CODE_RUNNER_TOKEN_FILE` | required | The shared bearer token (32+ printable characters), or a file holding it. Not both. |
| `CODE_RUNNER_HOST` / `CODE_RUNNER_PORT` | `127.0.0.1` / `8090` | Loopback only (`127.x.x.x`, `::1`) unless `CODE_RUNNER_ALLOW_REMOTE_BIND=true`. |
| `CODE_RUNNER_SOCKET` | — | Listen on this Unix socket (mode 0600) instead. |
| `CODE_RUNNER_ALLOW_REMOTE_BIND` | — | `true` permits another address (remote placement mode). |
| `CODE_RUNNER_RUNTIME` | `runsc` | `runsc` (gVisor) or `runc` (macOS development). |
| `DOCKER_HOST` | CLI default | The daemon the runner drives. |
| `CODE_RUNNER_DOCKER_BIN` | `docker` | The docker CLI. |
| `CODE_RUNNER_DATA_ROOT` | the daemon's `DockerRootDir` | Where `/health` measures free bytes. |
| `CODE_RUNNER_STATE_DIR` | `code-runner/.state` | The runner's `DOCKER_CONFIG` and default lock file. |
| `CODE_RUNNER_MAINTENANCE_FILE` | `<state>/maintenance` | The maintenance lock. |
| `CODE_RUNNER_INSTANCE` | `default` | Label scope for the GC. |
| `CODE_RUNNER_GC_INTERVAL_SECONDS` | `60` | `0` turns the timer off. |
| `CODE_RUNNER_DEADLINE_RESERVE_MS` | `5000` | Time kept for teardown and the response. |
| `LOG_LEVEL` | `info` | JSON lines on stdout. |

## Tests

```bash
npm test                                   # unit tests, no Docker
CODE_RUNNER_RUNTIME=runc npm run test:docker    # needs a Docker daemon
CODE_RUNNER_RUNTIME=runsc npm run test:docker   # Linux with gVisor registered as runsc
```

The Docker tests pull `ubuntu:24.04` by digest, run one test per abstain cause,
check the real isolation of a container and remove everything they start. CI
(`.github/workflows/code-runner.yml`) runs the unit tests, and the Docker tests
under `runc` and under the pinned gVisor on the systrap platform.

## Seams

- **Steps** (`src/steps.js`): `claimSteps(request, limits)` returns the steps
  the engine runs, in order. A1 returns none. A step is `async (ctx) => {}`
  with `ctx.exec(argv, { name, timeoutMs, stdin, env, workdir })`,
  `ctx.readFile(path, { maxBytes })`, `ctx.gate(name, status, basis, detail)`,
  `ctx.openSandbox()` (a second container with the same flags, for the fix
  check), `ctx.remainingMs()` and `ctx.limits`.
- **Launch** (`src/sandbox.js`): `runArgs`, `execArgs`, `removeArgs` and the
  `Sandbox` class.
- **Admission** (`src/admission.js`): A1b adds slots, the memory reserve and
  the disk check for the pull.
- **Result** (`src/result.js`): `ABSTAIN`, `DEFINITIVE_BASIS`, `Abstain`,
  `makeGate`, `classifyExec`.
