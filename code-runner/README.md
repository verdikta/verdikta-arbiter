# code-runner

The arbiter's code runner for stake-backed security attestation
([design](../docs/development/stake-attestation-design.md) §9). The External
Adapter calls it for a claim; it runs the claim's proof of concept in a fresh,
isolated container and reports what happened. It never judges: the EA settles
failed gates ([below](#what-a-failed-check-settles-as)), and the jury reads the report.

Node A1 of the build is the service shell, the isolation, the limits, the
deadline and the result taxonomy; node A2a adds the forge claim pipeline:
the `applies`, `testPathsOnly`, `build` and `reproduces` gates
([below](#the-forge-claim-pipeline)); node A1b the image pull by digest from
a registry allowlist, the image cache and the slot and memory admission
([below](#images-and-admission)); node A2b the listing check the
attestation site runs before escrow opens
([below](#post-v1listing-checks)); node A3a the five integrity checks of
§9.5 with the evidence tiers, the `integrity` and `claimedObservable` gates
([below](#integrity-checks)) and the fix check
([below](#the-fix-check)); node A3b the Verification Report, its hash and the
context pack ([below](#the-report-and-the-context-pack)); node A3c the honesty
flags and the fix check's lint ([below](#honesty-flags-and-the-fix-checks-lint)).
See [Seams](#seams).

## Run it

```bash
cd code-runner
npm ci                       # one runtime dependency: @verdikta/common, pinned exactly
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
available there. Set `CODE_RUNNER_RUNTIME=runc`. The class platform is
`linux/amd64`, which Apple silicon runs only with Docker Desktop's amd64
emulation turned on; without it, `CODE_RUNNER_PLATFORM=linux/arm64` (accepted
with `runc` only) runs the arm64 variant of a multi-platform image, and every
answer reports the platform it used. `DOCKER_HOST` can stay unset:
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
      "path": "/opt/gvisor/20260921.0/runsc",
      "runtimeArgs": ["--platform=systrap", "--overlay2=root:dir=/var/lib/code-runner-scratch,size=4g"]
    }
  }
}
```

- the gVisor release `@verdikta/common` pins (`GVISOR_RELEASE`, today
  `20260921.0`, SHA-512-checked; see `.github/workflows/code-runner.yml`),
  registered with `systemctl reload docker`, never a restart. The runner asks that
  binary its release on every run and refuses any other
  ([below](#the-report-and-the-context-pack));
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
  "gvisor": "release-20260921.0", "gvisorPinned": "release-20260921.0",
  "docker": { "reachable": true, "endpoint": "unix:///run/verdikta-code-runner/docker.sock", "serverVersion": "28.0.4", "osType": "linux", "architecture": "x86_64", "error": null },
  "dataRoot": { "path": "/var/lib/verdikta-code-runner/docker", "freeBytes": 38000000000, "error": null },
  "maintenance": false,
  "capacity": {
    "slots": { "total": 1, "inUse": 0 },
    "memory": { "availableMb": 9800, "committedMb": 0, "reserveMb": 1280,
                "reserve": { "chainlink": 512, "postgres": 256, "aiNode": 512, "localModel": 0 }, "error": null }
  },
  "images": { "allowlist": [{ "entry": "ghcr.io/verdikta", "dev": false }], "inUse": 0, "pullsInFlight": 0,
              "pendingBytes": 0, "diskReserveMb": 1024, "pullTimeoutMs": 90000 },
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 4096, "buildSeconds": 90, "runSeconds": 360, "…": "…" }
}
```

Busy slots are reported, not a failure (they free up). Under `runsc`, a host
whose available memory cannot be measured is not ok: every run would be
refused. So is a host whose `runsc` is not the release `@verdikta/common` pins,
or whose release cannot be measured (`gvisor` is what `<path> --version` said,
`null` when it could not be read; `runc` in local mode).

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
  "eaGates": { "disclosure": "pass", "inScope": "pass" },
  "deadline": 700000,
  "codeClass": "code-standard"
}
```

This extends §7.2's abridged list with `finding`, `report`, `knownIssues`,
`priorFindings` (at most 8, each `{ "bcid", "finding", "report" }`, its `report`
unused) and `eaGates` (build plan, assumption A7: the EA shares runs; the runner
needs these for the report and the context pack), and `codeClass` (optional,
default `code-standard`), whose envelope sets the pack's budget. `eaGates` must be
exactly `disclosure` and `inScope`, both `pass`; `finding`, `knownIssues` and each
prior finding must pass `@verdikta/common`'s validators; the attestation must have
a canonical JSON form. Anything else is a 400 before any work, so neither the report
nor the pack can fail on what the requester sent.
Patches are base64 so their bytes survive JSON. `deadline` is the **remaining
time in milliseconds** when the EA sends the request (at most 900,000); the
runner stops at receipt + deadline minus `CODE_RUNNER_DEADLINE_RESERVE_MS`.

`attestation.env` must name the image, platform and unpacked size
`code_review.json`'s `env` names (`ATTESTATION_IMAGE_MISMATCH`,
`ATTESTATION_PLATFORM_MISMATCH`, `ATTESTATION_SIZE_MISMATCH`), and the image
must be a reference Docker resolves exactly as written. These, and what the
claim pipeline would refuse in the request itself (`FRAMEWORK_UNSUPPORTED`,
`COMMAND_MISSING`, `COMMAND_NOT_ALLOWED`, `BASELINE_INVALID`, …), are a 400
before admission or any pull.

| Status | `outcome` | Meaning for the EA |
|---|---|---|
| 200 | `definitive` | Every step ended in a fact the arbiters may settle on. A failed gate means INVALID, but for an integrity failure with no tamper flag ([below](#what-a-failed-check-settles-as)); all passing goes to the jury. |
| 503 | `abstain` | Error, no commit. `abstain.cause` says why. |
| 400 | `requester_error` | The requester's package is broken (§12): a malformed request, a spec above the class hard limits, an attestation that names another image, or an env image that declares volumes. No claim code ran. `issues[]` names each problem. |
| 401 / 404 / 405 / 413 / 415 | — | Token, route, method, body size (16 MiB), content type. |

A definitive or abstaining answer looks like:

```json
{
  "outcome": "abstain", "runId": "3f2a…",
  "runner": { "version": "0.1.0", "runtime": "runsc", "platform": "linux/amd64" },
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 4096, "buildSeconds": 90, "testSeconds": 180, "runSeconds": 360, "maxPatchBytes": 2000000, "patchExpansionBytes": 50000000, "platform": "linux/amd64" },
  "abstain": { "cause": "oom", "step": "build", "detail": "a process in the sandbox was OOM-killed during the step" },
  "image": { "ref": "ghcr.io/verdikta/env@sha256:…", "cache": "hit", "durationMs": 41 },
  "steps": [ { "name": "build", "outcome": "abstain", "exitCode": 1, "durationMs": 8123,
               "stdout": { "text": "…", "totalBytes": 912, "omittedBytes": 0 }, "stderr": { "…": "…" },
               "cause": "oom", "detail": "…" } ],
  "gates": {},
  "facts": {},
  "report": null, "reportSha256": null, "reportUnavailable": null, "contextPack": null
}
```

`image` says how the env image was had (`hit`, `pulled`, or `shared`: a pull
another run started); it is operational and never part of the report, since
it differs between arbiters. `gates` holds `{ status: "pass"|"fail", basis, detail }` per gate decided;
a gate not reached is absent. `facts` holds what the steps observed (the
patch, its flags, the PoC runs; see below). A definitive answer carries
`report` (`verdikta.claim-report/1`, canonical), `reportSha256` and `contextPack`
([below](#the-report-and-the-context-pack)); an abstention has none of them. A
definitive run on `linux/arm64` (development) has no report, because the schema's
platform is the constant `linux/amd64`: `reportUnavailable` says so, and the gates
and the pack are still there.

### `POST /v1/listing-checks`

The listing check (design §8.2 steps 2-3, §8.3; `src/listing.js`). The
attestation site's validator (node P3a) calls it before it signs an
attestation, so a listing is validated on the runner the arbiters use (build
plan, assumption A4).

```json
{ "spec": { "…": "code_review.json, as drafted" }, "image": "ghcr.io/verdikta/stake-env@sha256:…", "deadline": 900000 }
```

`spec` needs what a claim's run needs (`baseCommit`, `env.from: "foundry"`,
`commands` with `build`, `test`, `testFiles` with `$FILES` and `testIds`
with `$TEST_IDS`, `paths.tests`), and may carry `limits` (the cpus and memory
the check then measures with; time limits are compared with the measured
defaults), `env.image` (must equal `image`), `env.platform`,
`env.unpackedBytes` (checked against the class maximum only: a draft's size
is not attested, so the pull's disk check always reserves the class
maximum, and the answer gives the measured size) and `stake.scope`. Those three fields are the whole
request: a claim field (`pocPatch`, `baseline`, `bcid`, …) is an unknown
field, 400.

It goes through the same engine as a run: the same admission (slots, memory,
the maintenance lock, a deadline that must cover the check's own budget of
720 s), the image pull through the cache, sandboxes with the same flags (one
at a time, so the memory admitted for one covers them), the same step limits
and deadline, the same abstain causes, and the same 400 for the requester's
broken package (an image without the listed commit's objects,
`IMAGE_WORKDIR_FULL`, …). In the first sandbox:

| Step | What |
|---|---|
| image | The env image's unpacked size: the sum of its layer sizes as the runner's daemon lists them (`docker history`); above 6 GB is refused |
| prepare | The claim pipeline's own prepare: the processes recorded, the forced checkout of the listed commit; the work tree's free space (a claim needs 50 MB + 64 MB, else `IMAGE_WORKDIR_FULL`); the listed commit's files, at least one of them in `stake.scope`; then a claim's integrity reference ([below](#the-integrity-reference-at-listing)) |
| compilers | The look at any solc in the image, before any build ([below](#the-official-release-look)): anything that isn't an official release is `SOLC_NOT_OFFICIAL` |
| build | `commands.build`, once, judged by its exit code, then compared with the reference as a claim's build is (every command as a claim runs it: [the forge commands](#the-forge-commands), the reference's forge with its pin) |
| suite | `commands.test` three times with the runner's `--junit --fuzz-seed 0x76657264696b7461` and `FOUNDRY_FUZZ_SEED`, no network, the tracked files reset to the listed commit before runs 2 and 3; after each run a claim's post-run checksums |
| baseline | Every test function the JUnit names (forge's identity, `<file> > <Contract> > <signature>`) with its result on each run, by the claim pipeline's classifier (missing or duplicated on a run = `error`); `stable` = passed all three, the rest `unstable` (common's `baselineSets`), checked with common's `validateBaseline` |
| limits | The defaults (below); above the class caps is too heavy |
| harness | The harness proof (below) |

**Default limits.** From the measured wall-clock times, in ms: P (prepare,
free space, the file list, what a context pack reads, the reference), B (the build,
its cleanup and its comparison), T (the longest suite run, with its reset, cleanup
and snapshot), so they count what a claim's run does. The look is not in them, since
a claim doesn't run it:

```
buildSeconds = ceil(3 B)
testSeconds  = ceil(3 T)
runSeconds   = ceil(3 (P + B + T)) + 2 testSeconds     # runs 2 and 3 of the repeat schedule
```

each at least 1, with the spec's (or the class's) `cpus`, `memoryMb` and
`maxPatchBytes`. Defaults above the class's 90 s build or 360 s run make the
repository **too heavy for v1** (`LISTING_TOO_HEAVY`). The check does not wait
to find out: the build is stopped at 30 s (or less, after a long
preparation), and each suite run at the time beyond which `runSeconds` could
no longer fit 360 s (`(357 s - 3 (P + B)) / 9`). A measured step stopped by its
own limit is that refusal, not an abstain: the time is the answer. The check's
own budget, the deadline and every other limit event (OOM, pids, a dead
sandbox) abstain as for `/v1/runs`. Limits `code_review.json` declares below
the defaults are refused (`LIMITS_BELOW_DEFAULTS`): claims would run out of
time and abstain.

**The harness proof.** The runner's own probe files (fixed in
`src/listing.js`, never the request's) go to one path under `paths.tests`,
outside `paths.protected` and off every tracked file: the directory the
suite's own test files ran from (most files first; `tests/` when
`foundry.toml` says `test = "tests"`), else forge's default
`test/VerdiktaHarness.t.sol` when a glob allows it, else the glob's literal
directory or the glob with its wildcards filled, each tried again with a number (`VerdiktaHarness2.t.sol`
… `9`) when the name is taken. Each probe runs as a claim does, in a fresh
sandbox of its own (the previous one removed first): the claim pipeline's
own functions (`claimSession` in `src/claim.js`: the forced checkout,
`applies`, `testPathsOnly`, the protected reset, the commit, what a context pack reads,
the reference) put it in
place, and its `reproduces` gate judges it under the default limits, with a
snapshot after each run: each
step within its own `buildSeconds` or `testSeconds`, and the probe's whole
run, from its sandbox's launch, within `runSeconds`, as a claim's run is.
Nothing the suite or an earlier probe left in a work tree, `$HOME` or `/tmp`
reaches a probe. The probes without forge-std need only solc 0.4.22 (revert
reasons):

| Probe | Expected |
|---|---|
| A trivially failing test, `assertEq(1, 2)` through the listing's `forge-std/Test.sol`; with a plain `revert` when that does not build | Built, and an **assertion** failure on all three runs of the fixed schedule |
| A test that does not compile (an undeclared identifier), run straight through `testFiles` without the build | No readable JUnit: an **error** |
| A test contract whose `setUp()` reverts | A `setUp()` failure in the JUnit: a **collection error** |

Anything else refuses the listing, since `reproduces` (§10.1) depends on the
distinction: `LEGACY_ASSERTIONS` (forge-std's `assertEq` failed without a
reason, or passed: non-reverting assertions, or `assertions_revert = false`;
a PoC written with them would be an error), `HARNESS_ASSERTION_NOT_REPORTED`
(the failing test was not an assertion on every run: `testFiles` does not run
the PoC's files, or the result is flaky), `HARNESS_ERROR_NOT_REPORTED`,
`HARNESS_TOO_SLOW` (a probe step past its default limit, or a probe's run past `runSeconds`), `HARNESS_NO_PATH`,
`HARNESS_PROBE_REJECTED`, `HARNESS_INTEGRITY_FAILED` ([below](#the-integrity-reference-at-listing)). A listing whose tests use `ds-test` directly,
without forge-std, is proven with the plain revert only.

#### The integrity reference at listing

Node A2c. Without it, an image a claim would refuse could pass this check, and a maker
could list a stake no claim can settle. The check takes the claim pipeline's own steps,
in every sandbox it opens, so there is one code path and nothing to keep in step:

- **The reference.** `claimSession.watch`, then `Watch.reference`, once in the first
  sandbox and once in each probe's. What it refuses comes out unmapped: the same code as a
  claim's, the same 400, in `issues`, not in `listing.refusals`. That covers
  `IMAGE_FORGE_MISSING`, `FORGE_CONFIG_INVALID`, `IMAGE_FORGE_UNWATCHED`,
  `IMAGE_WATCH_ROOT_UNCOVERED`, `IMAGE_WATCH_TOO_LARGE`, `IMAGE_WATCH_LINK_UNCOVERED`,
  `IMAGE_WATCH_UNREADABLE` and `IMAGE_TOOL_MISSING`, each pinned on real forge with a claim
  on the same image. A claim's listing also holds its patch's files and the git objects its
  commit makes (a tree for each directory a path passes through), so the first sandbox's
  listings keep room for what any patch can add: `LISTING_RESERVE`, 320,000 entries and 64 MiB of
  listing under a claim's 1,000,000 and 128 MiB. The work tree's tmpfs bounds the objects (a page
  each, so 262,144 at most), and more than that fails the commit, an abstain. So a listing may
  hold 680,000 entries and 64 MiB, and any ≤ 2 MB patch on an image that passes stays under a
  claim's caps. A real apply and commit is held to this on real forge. Such a patch can still
  abstain on memory or time, since what it writes counts against `--memory`; that is an abstain,
  not this refusal.
- **The build.** `Watch.afterBuild`: `IMAGE_WATCH_CHANGED_BY_BUILD`, as a claim's.
- **The suite.** `Watch.afterRun` after each run, `Watch.afterReset` after the reset
  between runs. A run that changed a watched set is `IMAGE_WATCH_CHANGED_BY_SUITE` at the
  first run that did, in `listing.refusals`, with `detail` and `paths` naming what changed.
  The artifacts of run 1 are what runs 2 and 3 are held to, as a claim's are, so a test that
  rewrites a file under `out/` differently on each run is refused too.
- **The probes.** Their runs go through `reproduces`, so `testFiles` and `testIds` runs
  have one integrity profile: the same argv builder, the same pin, a snapshot after each. A
  probe's run that changes a watched set is `HARNESS_INTEGRITY_FAILED`, the check and the
  paths named, whatever its test did. That catches a trap in a listing's own `forge-std` that
  spares the suite.

`IMAGE_WATCH_CHANGED_BY_SUITE` and `HARNESS_INTEGRITY_FAILED` are the listing's own: no claim
step refuses anything for this, since a claim's run that changes a watched set fails its check.

This measures what fires during the listing. A trap that spares the suite and the probes,
such as repository code only a proof would call, still passes. See the known limits.

The answer (200 when every step was definitive; 503 abstain and 400
requester error as for runs):

```json
{
  "outcome": "definitive", "kind": "listing-check", "checkId": "3f2a…",
  "runner": { "version": "0.1.0", "runtime": "runsc", "platform": "linux/amd64" },
  "limits": { "cpus": 2, "memoryMb": 4096, "pids": 4096, "buildSeconds": 90, "testSeconds": 360, "runSeconds": 720, "…": "…" },
  "abstain": null,
  "image": { "ref": "ghcr.io/verdikta/stake-env@sha256:…", "cache": "pulled", "durationMs": 21000 },
  "listing": {
    "status": "accepted",
    "refusals": [], "warnings": [],
    "image": { "ref": "ghcr.io/verdikta/stake-env@sha256:…", "unpackedBytes": 1400000000 },
    "compilers": { "platform": "linux/amd64", "listAsOf": "2026-11-03", "newest": "0.8.38", "checked": [ { "path": "/opt/verdikta/tools/share/svm/0.8.31/solc-0.8.31", "release": "0.8.31" } ] },
    "checkout": { "…": "as facts.checkout of a run" },
    "timings": { "prepareSeconds": 4.1, "buildSeconds": 14.2, "testSeconds": [21.5, 20.9, 22.1] },
    "baseline": { "version": 1, "baseCommit": "7f3a9c…", "framework": "forge", "runs": 3, "tests": ["…"], "stable": ["…"], "unstable": ["…"], "timings": { "…": "…" } },
    "limits": { "cpus": 2, "memoryMb": 4096, "buildSeconds": 43, "testSeconds": 67, "runSeconds": 255, "maxPatchBytes": 2000000 },
    "suite": { "tests": 41, "stable": 40, "unstable": 1, "exitCodes": [1, 1, 1], "harnessErrors": [[], [], []] },
    "harness": { "path": "test/VerdiktaHarness.t.sol", "probes": [ { "name": "fails", "variant": "forge-std", "verdict": "assertion", "gates": { "…": "…" } } ] },
    "leftoverProcesses": []
  },
  "steps": [ "…" ]
}
```

`listing.status` is `accepted` or `refused`; the check stops at its first
refusal (`refusals[0]`, with `code`, `detail` and, for the checksums' two codes, `paths`). `limits` (top level) is
what the check ran under; `listing.limits` the defaults for
`code_review.json`, and `listing.baseline` the `baseline.json`. Warnings:
`BASELINE_NO_STABLE_TESTS`, `SUITE_HARNESS_ERRORS` (a maker's test contract
whose `setUp` fails: its tests are not in the baseline), `CHECKOUT_CORRECTED`.
`listing` is `null` unless the outcome is definitive. A listing check has no
`gates`, `facts`, report or context pack: the claim functions it reuses gate
into the probes' own record, so nothing in its answer can pass for a claim's
result, and the EA never calls it.

## Class hard limits

`src/classLimits.js` applies `@verdikta/common`'s `CLASS_HARD_LIMITS` (2 CPUs,
4,096 MB, 4,096 pids, 90 s build, 360 s run, 2 GB compressed / 6 GB unpacked
image, 2 MB patch, 50 MB patch expansion, `linux/amd64`) and the bounds in its
`code_review.v1.json`; it holds no values of its own. A spec may only lower
`cpus`, `memoryMb`, `buildSeconds`, `testSeconds`, `runSeconds` and
`maxPatchBytes`; anything above the class maximum, any other key, an image not
pinned by digest, another platform or an unpacked size above 6 GB is a 400
before any Docker call. The process limit is always the class's.

## Isolation

Every check gets a fresh container (`src/sandbox.js`, which builds every argv
the runner gives Docker; `test/unit/sandbox.test.js` pins it exactly):

```
docker create --pull never --platform linux/amd64 --name vcr-<run>-<n> --label verdikta.code-runner=1 …
  --runtime runsc --network none --cap-drop ALL --security-opt no-new-privileges
  --read-only
  --tmpfs /work:rw,exec,nosuid,nodev,size=1024m,mode=0755,uid=10001,gid=10001
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777
  --tmpfs /home/sandbox:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001
  --ipc none --user 10001:10001 --pids-limit 4096 --memory 4096m --memory-swap 4096m --cpus 2
  --hostname sandbox --env TZ=UTC --env LANG=C.UTF-8 --env CI=true --env PYTHONHASHSEED=0
  --env HOME=/home/sandbox --env LD_PRELOAD= --env LD_AUDIT= --env LD_LIBRARY_PATH=
  --env GCONV_PATH= --workdir /work
  --log-driver none --init --entrypoint sleep <image@sha256:…> <keepalive seconds>
```

- No bind mounts, no volumes, no Docker socket, no added capability. Between
  `docker create` and `docker start` the runner checks the container's mounts:
  an image whose `VOLUME` lines would give it anonymous volumes (outside the
  capped scratch layer) is refused as the requester's error before anything
  runs in it. Containers are removed with `--volumes`.
- `--platform linux/amd64`: the class platform is the one that runs, not the
  host's variant of a multi-platform image.
- The entrypoint is the runner's keepalive, not the image's; it ends the
  container shortly after the deadline even if the runner dies.
- `--pull never`: the run never pulls. The pull is a separate step before it,
  by digest only, from the allowlist ([Images](#images-and-admission)). An
  image that is not on the runner's disk when the sandbox is created abstains
  (`image_unavailable`).
- Steps run through `docker exec --user 10001:10001 <container>` and the
  runner's launcher (below), which `exec`s the step's argv unchanged. The
  runner spawns only the docker CLI, always with an argv array and `shell:
  false` (`src/docker.js`); claim content reaches the sandbox only as stdin.
  Results are read as capped streams (`docker exec … cat`), never `docker cp`.
- The docker CLI gets an allow-listed environment (`PATH`, `HOME`,
  `DOCKER_HOST`, `DOCKER_CONFIG`, and the TLS variables with a TCP endpoint)
  and the runner's own empty `DOCKER_CONFIG`: no token, no operator credentials.
- `test/unit/policy.test.js` fails the build if `src/` gains a shell, `eval`, a
  mount flag, the Docker socket, `docker cp` or a host file write.
- The image's `ENV` cannot make the dynamic linker load a file a run can write
  (R20-F1): `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH` and `GCONV_PATH` are empty on
  the container, so the launcher's `/bin/sh`, which starts before any `env -i`, and
  every exec inherit that. `LD_TRACE_LOADED_OBJECTS` and `LD_SHOW_AUXV` can't be
  handled this way, since glibc acts on their names whatever the value, and they load
  nothing: an image setting one fails the start nonce and the run abstains. The
  builder's fixed `ENV` sets none of them.
- The image needs a POSIX `/bin/sh` (the launcher's interpreter) on a path
  owned by root and not writable by uid 10001: checked at launch, before any
  claim code runs, else the run is the requester's error
  (`IMAGE_LAUNCHER_WRITABLE`).

## Read-only root filesystem

Every sandbox runs with `--read-only`. The only writable places are three
memory-backed tmpfs mounts, and their sizes are the scratch cap (1,792 MiB in
all, `SCRATCH_MB`). What is written there is memory charged to the container,
so it counts against `--memory` as well: filling the scratch ends in an OOM,
which abstains.

| Mount | Size | | For |
|---|---|---|---|
| `/work` (the working directory) | 1,024 MiB | `exec`, owned by uid 10001 | The repository's writable copy: the claim's patch, `out/`, `cache/`, and programs such as `solc` |
| `/home/sandbox` (`$HOME`) | 256 MiB | `noexec`, mode 0700 | `~/.foundry` and other per-user caches |
| `/tmp` | 512 MiB | `noexec`, mode 1777 | Temporary files |

The mounts follow what a forge build and test write. `forge build` writes
`out/` and `cache/` in the project, `forge test` writes `~/.foundry/cache`,
and tools use `/tmp`. `test/docker/readonly.docker.test.js` runs a real
`forge build` and `forge test` (the foundry base pinned in `@verdikta/common`,
v1.8.5, and solc 0.8.31) on this root. `--ipc none` drops the `/dev/shm` mount, which would be a fourth
writable place.

Because nothing outside the scratch can be written, claim code cannot create,
replace or retarget anything on `/bin/sh`'s path, whatever the image's
permissions would allow. The same Docker test builds an image that routes
`/bin/sh` through a directory owned by uid 10001, with the round 7-9 setups,
and shows that every such write fails with "Read-only file system". The
launcher path check stays as a second check.

What the env image (P3a) must provide:
- the repository at `/repo`, as its install commands left it. The runner
  forces the checkout ([below](#the-forced-checkout)): every tracked file and
  submodule is rewritten from the listed commit, so the image only needs
  - the listed commit's objects (its commit, trees and blobs) in a
    directory named `.git` under `/repo` (a real directory, not a link): the
    repository's own `.git/objects`, as a clone leaves it (loose objects or
    packs; a shallow clone of the listed commit is enough). Objects reached
    only through `commondir`, alternates, a `.git` file or a link are not
    read. A missing
    object of the listed commit's own tree, or one that does not hash to its
    id, is the requester's error (`IMAGE_OBJECTS_MISSING`,
    `IMAGE_OBJECT_INVALID`);
  - each submodule's commit's objects, wherever its `.git` directory is
    under `/repo` (`.git/modules/<name>`, or the submodule's own `.git`), for
    that submodule to be populated: without them it is left an empty
    directory, as git leaves an unpopulated submodule;
  - its installed dependencies, as untracked or ignored files (`lib/`
    contents outside submodules, `node_modules`, `out/`, `cache/`): they are
    kept as the image built them, unless one sits at a tracked path or on the
    way to one;
  - every entry readable by uid 10001 (`IMAGE_CHECKOUT_UNREADABLE`
    otherwise), and the checkout within the work tree's 1 GiB.

  The image's git state is never used: its config, index, hooks,
  attributes, refs (`HEAD` included: the checkout may be at any commit),
  replace refs, alternates, `commondir`, worktree redirects and submodule
  settings. No filter of the image runs (git LFS included: a tracked file
  holds its committed blob). Its `.git` entries, device nodes, sockets and
  named pipes are not copied into the work tree (none holds a file's bytes,
  and a pipe git or a build opened would block it);
- `git` 2.29 or later (2.34.1 on the foundry base), `/usr/bin/env`, GNU
  `find`, `xargs`, `sort` and `tar`, `wc`, `cat`, `chmod`, `rm`, `mkdir`,
  `forge` and a POSIX `/bin/sh` (the foundry base has them);
- every tool, `solc` included, outside `$HOME` and `/tmp` (both start empty),
  or in the work tree;
- the build and test commands writing only inside the work tree, `$HOME` and
  `/tmp`;
- `/bin/sh` on a path owned by root.

## The launcher and its start nonce

Whether a step's command started is never read from Docker's error text,
whose wording differs between Docker versions and runtimes. Every exec,
including the runner's own probes, runs

```
/bin/sh -c 'printf "vcr-start %s\n" "$1" && shift && exec "$@"' vcr-launch <nonce> <argv…>
```

with a fresh 128-bit nonce the runner generates for that exec
(`src/launcher.js`). The launcher prints `vcr-start <nonce>` as the first line
of stdout and `exec`s the step's argv, so the exit code, the files and the
rest of the output are the program's own; the runner strips the line. Without
it first, the step abstains `step_not_started`, whatever Docker printed (which
goes into the detail). With it, a 127 is the image's own answer: the launcher
ran and found no program.

Claim code cannot fake the line for a command that never started: the nonce
exists only in the runner and the `docker exec` request until the launcher
process exists in the sandbox, and it is new for every exec. Once the
launcher has run, the line is already written; after its `exec` the nonce is
no longer in the process's argv, and it was never in its environment. Claim
code cannot become a later step's launcher either, because the sandbox user
cannot write `/bin/sh` or a directory holding it. What the nonce does not
cover: a claim process that outlives its step and interferes with a later
one inside the sandbox (A2a/A3a's integrity rules), and a docker CLI whose
stream drops after the launcher started, which reports its own exit code
(the inspection after the step catches a daemon that is down, not one dropped
stream).

## Results: definitive or abstain

`src/result.js` (§9.3, §12). A run is **definitive** only when every step
started (the nonce above) and ended in a clean exit code (0-128), and later a JUnit outcome or an integrity
result; gates record their basis (`exit_code`, `junit`, `integrity`, or
`input`: the request's own bytes, such as a patch's size) and cannot be
decided on anything else. Everything else **abstains**:

| `abstain.cause` | When |
|---|---|
| `admission_refused` | The maintenance lock is held; the deadline leaves less than `runSeconds` (also once the image is ready, or it ran out while the image was prepared); the runtime is not registered; every execution slot is in use; the run would cut into the memory reserve; the data root has no room for the pull, even after eviction |
| `docker_unreachable` | The daemon cannot be reached (at admission or during the run) |
| `docker_error` | The daemon refused something the step did not cause |
| `registry_not_allowed` | The env image's registry and repository are not on `CODE_RUNNER_REGISTRY_ALLOWLIST` |
| `pull_failed` | The pull failed: the registry unreachable, the digest unknown to it, bytes that do not hash to the digest, the pull timeout, or a pull that did not finish in the time the deadline leaves before the run |
| `image_mismatch` | The image the digest reference resolves to does not carry that digest, or is of another platform |
| `image_unavailable` | The env image is not on the runner's disk when the sandbox is created |
| `step_timeout` | A step's own wall-clock limit, or the run's (`runSeconds`) |
| `deadline` | The EA's deadline |
| `oom` | The kernel's OOM flag or `oom_kill` counter, or exit 137 |
| `pids_limit` | The `pids.events` counter, a probe that cannot start while `docker stats` shows the pid table full, or a gVisor sandbox crash at the limit (exit 2) |
| `step_not_started` | The launcher's start nonce did not come first on stdout: the step's command did not run |
| `sandbox_died` | The container died or vanished under the step |
| `killed_by_signal` | The step's process died of a signal (exit > 128): not a clean exit |
| `cancelled` | The caller hung up, or the runner is stopping |
| `runner_error` | A bug in the runner |

After every step the runner inspects the container and reads its cgroup
counters (a shell-builtin probe, through the launcher), so an OOM kill or a
refused fork behind an otherwise clean exit code still abstains. A probe that
does not start or does not exit 0 counts against the step: `pids_limit` when
`docker stats` shows the pid table full, `docker_error` otherwise. Counter
files that do not exist (gVisor, or the other cgroup version) are not a
failure.

## The forge claim pipeline

`src/claim.js` with `src/commands.js`, `src/forge.js`, `src/git.js`,
`src/patch.js` and `src/junit.js` (design §9.2 steps 3-6, §10.1). For a forge listing
(`commands.framework: "forge"`, `env.from: "foundry"`), in one sandbox:

| Step | Gate | Decided on |
|---|---|---|
| Record the sandbox's processes (the init and the keepalive); force the checkout: `/work` becomes the listed commit in a fresh repository (below) | — (the requester's error when the image lacks the listed commit's objects) | |
| `poc.patch` at most `maxPatchBytes`, no NUL byte, no copy or rename header (below) | `applies` | `input` |
| `git apply --index` against the listed commit, then the bytes it wrote measured against 50 MB (below) | `applies` | `exit_code` / `input` |
| `git diff --cached --name-status --no-renames`: every touched path (a rename's source included) under `paths.tests`, none under `paths.protected`, each one a report can name | `testPathsOnly` | `exit_code` |
| Protected files reset to `baseCommit`; the result committed (`Verdikta code runner <code-runner@verdikta.invalid>`, `1767225600 +0000`, message `poc.patch`) | — | |
| The integrity checks' reference snapshot ([below](#integrity-checks)); then `commands.build` | `build` | `exit_code` (tier A) |
| Run 1: `commands.testFiles` on the PoC's files; runs 2 and 3: `commands.testIds` on the tests run 1 found; a snapshot after each run | `reproduces` | `junit` (or `integrity`) |
| The five checks of §9.5 on the three runs | `integrity` | `integrity` |
| finding.json against the recorded failures (only once `reproduces` passed) | `claimedObservable` | `junit` |

With `fix.patch`, the fix check runs beside these steps in a second sandbox
and is recorded, never gated ([below](#the-fix-check)).

A failed gate stops the pipeline; the gates after it are not run (absent).
A step that hits a limit, dies or does not start abstains the run, and no
gate is decided on it: an OOM-killed build is an abstain, never a `build`
failure.

### The forge commands

`src/commands.js` (owner decision Q31, R11-F1). **The rule for makers:** a
listing's `build` is `forge build`, and its `test`, `testFiles` and `testIds`
are `forge test`, each followed only by the flags below. The runner parses
the string and runs forge itself. Anything else (a script, an environment
variable, `cd`, `&&`, any other flag) belongs in `commands.setup`, which runs
only while the env image is built, and a forge setting belongs in the default
profile of the repository's `foundry.toml`.

| Command | Must be | May add |
|---|---|---|
| `build` | `forge build` | `--skip test` or `--skip script` |
| `test` | `forge test` | `--match-test`/`--mt`, `--no-match-test`/`--nmt`, `--match-contract`/`--mc`, `--no-match-contract`/`--nmc`, `--match-path`/`--mp`, `--no-match-path`/`--nmp` (each a pattern); `-v` to `-vvvvv`; `--fuzz-runs <1-1000000>`; `--isolate` |
| `testFiles` | `forge test --match-path $FILES` | `-v` to `-vvvvv`; `--fuzz-runs`; `--isolate` |
| `testIds` | `forge test --match-test $TEST_IDS` | `--match-path $FILES`; `-v` to `-vvvvv`; `--fuzz-runs`; `--isolate` |

The reasons: `--skip` leaves tests or scripts out of the build (they compile
in run 1, where the artifact check allows it); the matching filters let the
full suite leave out what cannot run in the sandbox (fork tests); `--fuzz-runs`
fits a suite into its time limits; `--isolate` is a suite's own semantics;
verbosity only adds logs to forge's report. In `testFiles` and `testIds` the
runner chooses the tests, so another filter could only hide them.

**The grammar.** Tokens separated by spaces. A token is unquoted (letters,
digits, `_ . / : , + @ % = -`) or one whole value in single quotes (printable
ASCII: a pattern with a space, a glob or a regex character, such as
`--no-match-path 'test/fork/**'`). A value follows its flag as the next token
or after `=`. `$FILES` and `$TEST_IDS` (or `${FILES}`, `${TEST_IDS}`) are whole
unquoted tokens, only where the table has them. Each flag at most once. Patterns
are 1 to 512 characters. No shell metacharacter outside a quoted value, no line
break or control character anywhere, no environment assignment, no `env`, no path to
forge, no other subcommand, no positional argument, no short option but
verbosity, no flag the table does not list (a flag forge hides from its
`--help` included), and never `--junit` or `--fuzz-seed`, which are the
runner's. Everything else is `COMMAND_NOT_ALLOWED`, naming the command and the
offending token, a requester error before any sandbox, at claim time and at
listing time alike; a missing command is `COMMAND_MISSING`, one over 2,000
characters `COMMAND_INVALID`, a `testFiles` or `testIds` without its placeholder
`COMMAND_PLACEHOLDER`.

**How forge runs.** There is no shell around the maker's text. The step's argv is
`/usr/bin/env -i PATH=<the image's PATH> TZ=UTC LANG=C.UTF-8 CI=true
PYTHONHASHSEED=0 HOME=/home/sandbox XDG_DATA_HOME=/opt/verdikta/tools/share
VERDIKTA_TOOLS=/opt/verdikta/tools FOUNDRY_CONFIG=foundry.toml FOUNDRY_SOLC=<the pin>
FOUNDRY_EXTERNAL_COMPILERS=[] FOUNDRY_FUZZ_SEED=<seed> <forge> <subcommand>
<flags…>`, in `/work`: forge at the real path the runner probed in the image
(`command -v forge`; a forge path holding `=` or a control character, which env
could not run as a program, is `IMAGE_FORGE_MISSING`). Each flag and its value are one
argv element (`--name=value`). The launcher prints its start nonce and `exec`s
that argv; nothing interprets it. Nothing of the image's `ENV` but `PATH` reaches
forge, `FOUNDRY_*` included. forge sees four `FOUNDRY_*`, all the runner's: the seed,
`FOUNDRY_CONFIG` at forge's own default, so a `.env` cannot move its configuration,
`FOUNDRY_SOLC`, the pinned compiler, and `FOUNDRY_EXTERNAL_COMPILERS` empty
([below](#the-compiler-is-pinned)). The two
`/opt/verdikta` values are the builder's fixed `ENV`, set here as constants: forge
finds the solc releases the maker's setup installed under `XDG_DATA_HOME`. The runner
reads `forge config --json` through the same argv, so the configuration the
integrity checks watch is the one every command runs with. For a test run the
runner appends `--junit --fuzz-seed 0x76657264696b7461` (the seed from
`@verdikta/common`). `$FILES` is one forge glob over the Solidity files the patch
added or changed (`{a.t.sol,b.t.sol}`, glob characters escaped); `$TEST_IDS` an
anchored regex over the exact signatures forge matches `--match-test` against
(`^(?:test_a\(\)|test_b\(uint256\))$`).

### The forced checkout

`src/checkout.js` with `src/objects.js` (owner decision Q25, "force the
checkout"; design §9.2 step 3). Before any claim code runs, `/work` becomes
the listed commit, whatever the image's install commands did to its
checkout:

1. The runner makes two repositories with its own settings (`git init
   --template=`, so no hook is copied in): `/work/.git`, the one the claim
   steps use, and a staging store. The image's files are copied into `/work`
   without any `.git` entry (at any depth), device node, socket or named
   pipe. The loose objects and packs of every `objects` directory inside a
   `.git` directory of `/repo` are copied into the staging store as plain
   files, each with its own bytes (a hard link is read as the file it is),
   in byte order, the first copy of a name kept; nothing else of theirs (no
   `info/alternates`, multi-pack-index or commit-graph).
2. The runner reads the listed commit, its trees level by level, each
   submodule's commit (the one its gitlink records) and trees, and every
   blob, out of the staging store, and re-hashes each one itself
   (`<type> <size>\0<content>`, SHA-1, or SHA-256 when `baseCommit` has 64
   hex digits). The store's answer is never trusted: an object that does not
   hash to its id, has the wrong type or is malformed (a tree out of git's
   order, a duplicate name, `.git`, `.`, `..`, an empty name, a symbolic link
   Linux cannot hold) is the requester's error, as is a missing object of
   the listed commit's own tree. A submodule whose commit, a tree or a blob
   is missing is left an empty directory. Bounds: 512 MiB of files (every
   path counted), 200,000 entries, 128 levels, 4,000-byte paths.
3. The verified blobs, the runner's own trees of the whole tree (each
   submodule's files as ordinary paths) and its root commit (`Verdikta code
   runner`, `1767225600 +0000`, message `listed commit <baseCommit>`) go
   into `/work/.git` as packs the runner writes (`git index-pack --stdin`:
   git stores the bytes and judges no path). git must then agree on the
   commit and tree ids, and `read-tree` builds the index from that commit:
   a path git will not check out is refused there.
4. Every tracked path is replaced, never written through: each directory on
   the way to one must be a real directory (a symbolic link, file, pipe or
   device node there is removed and a directory made, from the top down),
   whatever sits at the path itself is removed (a directory with all it
   holds included), and git checks the files out into the empty places
   (`git checkout-index --all --index`). The work tree must then match the
   index exactly, and the staging store is removed: `/work` holds one
   repository, the runner's.
5. `facts.checkout` records what was found, never judged: `commit` and
   `tree` (the runner's commit of the listed tree), `paths`, `corrected` and
   the first 100 `correctedPaths` (tracked paths the image had differently,
   counted by git in the fresh repository before the rewrite),
   `directoriesMade`, `emptySubmodules`, `gitRemoved` and
   `gitEntriesRemoved`.

The requester's errors, all before any claim code runs:
`IMAGE_CHECKOUT_MISSING` (no `/repo`), `IMAGE_TOOL_MISSING` (no
`/usr/bin/env` or `git`), `IMAGE_CHECKOUT_UNREADABLE`,
`IMAGE_OBJECTS_MISSING`, `IMAGE_OBJECT_INVALID` (also a path git will not
check out under the runner's settings, such as `git~1` or a symbolic link
named `.gitmodules`), `IMAGE_CHECKOUT_TOO_LARGE`, and `IMAGE_WORKDIR_FULL`
(the checkout and dependencies leave too little room to apply a claim). An
image whose checkout differs from the listed commit is corrected and run, not
refused.

Every git call and every checkout script starts with an empty environment
(`/usr/bin/env -i`, then the runner's fixed variables), so nothing the image
sets with `ENV` (`GIT_CONFIG_*`, `GIT_TRACE`, `GIT_TEMPLATE_DIR`,
`TAR_OPTIONS`, ...) reaches them, and runs in one of the runner's two
repositories (`src/git.js` refuses any other `GIT_DIR`). Protected paths are
reset to the runner's commit of the listed tree, and the PoC commit's parent
is that commit.

**git runs only in the sandbox.** The patch reaches it as stdin of
`docker exec`; what the patch touches is what git says, from its `-z`
output. Every git call fixes the settings that would change an outcome or
run something (`src/git.js`): no system or global config, no hooks or
fsmonitor, no line-ending conversion, whitespace never refuses a patch,
diffs with no external driver or rename detection, the index compared by
content (no ignored stat data, no sparse checkout), `LC_ALL=C`. No attribute
driver runs: `.git/info/attributes`, the source above every
`.gitattributes`, is
`* !filter !diff !merge !text !crlf !eol !ident !working-tree-encoding`, so
a patched file can never be a clean or smudge filter, a textconv or a merge
driver, and no conversion changes a file's bytes.

**Expansion is measured, not counted** (owner decision Q26). git applies the
patch in the sandbox, in the fresh repository, under its memory, pids and time
limits. The runner then reads from its own index what the patch wrote: the
postimage bytes of every path it created or modified (`git diff --cached
--raw`, then each blob's `%(objectsize)`), summed, counted once per path. More
than `patchExpansionBytes` is an `input` failure (`PATCH_EXPANSION`), the same
gate as before; the measured figure is in the reason and in
`facts.patch.expansionBytes`.

Getting the blame right (§9.2 step 3): the patch is refused only when the
patch is what ran out of room.
- Before applying, the runner checks the work tree has `patchExpansionBytes`
  plus a 64 MB margin of free disk. If not, the image's checkout and
  installed dependencies left too little room — the requester's package, not
  the hunter's patch: `IMAGE_WORKDIR_FULL`, before any apply.
- With that room confirmed, running out of it (`ENOSPC`) as git applies, or
  the apply's own 90 s budget, is the patch materialising more than it may:
  `PATCH_EXPANSION`, `input`. Running out of **memory** while applying is an
  ordinary resource abstain (owner decision Q28), never charged to the patch;
  so are the run's own deadline, budget and cancellation.

**The host-side checks** (`src/patch.js`, before git sees the patch) parse no
meaning: `maxPatchBytes`; no NUL byte (no patch git writes holds one, and git
reads a header field only up to one); no copy (`copy from`) and no rename
(`rename from` / `to`, and git's older `rename old` / `new`), each of which
rebuilds a whole existing file from one header line; and no binary change (a
`GIT binary patch` or `Binary files … differ` / `Files … differ` entry, owner
decision Q28) — a PoC adds or edits text test files, and a binary postimage
can name an existing object the patch's bytes do not bound. A moved file is a
deletion and an addition (`git diff --no-renames`). `fix.patch` gets the same
host-side checks, binary changes included (node A3a's rule,
[below](#the-fix-check)).

**Commands** are plain forge commands the runner parses and runs itself
([above](#the-forge-commands)). A listing must declare `build`, `testFiles`
with `$FILES` and `testIds` with `$TEST_IDS`.

**The schedule is fixed:** three runs whenever run 1 found a test the patch
added, whatever run 1 showed and however much time is left. The tests the
patch added are run 1's test functions (`test*`, `invariant*`,
`statefulFuzz*`, `table*`, `check*`, `prove*`) in the PoC's files whose identity is not in
`baseline.json`; the identity is `<file> > <Contract> > <signature>`.
`reproduces` passes when every one of them fails as an assertion on all three
runs. Any pass, skip, error, missing or duplicated record on any run fails
it, as does a run with no readable JUnit or a failing `setUp()` or
`constructor()` in a PoC suite; the detail names the first one, run by run,
in code-unit order of identity.

**Assertion vs error** (`src/forge.js`). A forge test fails one way: the test
function ran and reverted (an assertion helper, a `require`, a revert from
the code under test). That is an assertion failure, the same line the §8.2
harness proof draws between a trivially failing and a trivially broken test.
A campaign of one invariant predicate has no message on its record, only forge's
`[FAIL: <reason>]` text, so for invariants the reason is read there (R21-F2), up to
forge's framing, whatever line breaks it holds (R22-F2).
Errors are everything else: no JUnit (a compile error, such as an import that
does not resolve), a failed `setUp()`, `constructor()` or `afterInvariant()`,
a failure whose body never ran (no reason, as when a `beforeTestSetup` call
reverts, or forge's default `(gas: 0)` in the record's own `system-out`, read
where forge writes it, right after `[FAIL: <reason>] <signature> `, however
long the reason: a test body that ran always used gas), and failures forge raises itself at the
pinned version: a refused or failed cheatcode (`vm.<name>: …`), `testFail*`
(removed), the EVM failing (`EvmError:` other than `Revert`), fuzz or
invariant set-up, a fuzz test whose inputs `vm.assume` all rejected,
table-test fixtures, incomplete symbolic execution. Legacy, non-reverting
assertions fail without a reason, so a listing built on them fails the
harness proof.

**The JUnit** is forge's stdout, read up to 8 MiB and parsed strictly
(`src/junit.js`): UTF-8, no DOCTYPE (so no entity can be declared: entity
expansion is off), only the five predefined entities and character
references, no comments, CDATA or processing instructions, exactly one root
and only forge's shape (`testsuites` > `testsuite name="<file>:<Contract>"`
> `testcase` with at most one `failure`, `error` or `skipped`), with caps on
depth, elements and attributes. Anything else is an unreadable JUnit, an
error on that run. A test that logs XML gets it escaped into a `system-out`,
which is never read as markup; bytes a test writes straight to forge's stdout
make a second document or stray text, so the JUnit is unreadable rather than
richer.

**Between steps that ran claim code** (after the build and after each run),
every process but the ones recorded before any claim code ran is stopped and
killed on every pass until none is alive (shell builtins and `/proc`; a
sandbox where that does not converge abstains `docker_error`). A process
counts as gone only when every one of its tasks is a zombie, and a task's
state is read after the last `) ` of its whole stat file, since the process
name before it is the process's own to choose, and before runs 2 and 3 the tracked files go back
to the PoC commit (`git reset --hard`). The number killed is in
`facts.leftoverProcesses`.

`facts` (the report is built from them, [below](#the-report-and-the-context-pack)),
each an object carrying its evidence tier (§9.5: `tier: "A"`, observed by the
runner from outside the tested process; `tier: "B"`, reported by a process that ran
claim code): `checkout` (A, above), `compiler` (A: `solc`, what forge is pinned to,
[below](#the-compiler-is-pinned)), `patch` (A: bytes, SHA-256, the measured expansion),
`commit` (A: `base`, `poc`), `diff` (A: files, added, removed, binary
files), `testPaths` (A: outside, protected, unreportable), `flags` (A:
`existingTestsModified`, `skipMarkersAdded`, `protectedPathsTouched`,
`frameworkReferences`: forge inline config, JUnit markup, file and
environment cheatcodes, `foundry.toml`, `ffi`), `protectedReset` (A:
`files`), `poc` (B: `testCount`, `runCounts`, the first 200 tests with their
three results, kind and message, per run the command, JUnit status, exit code
and failing harness records, `integrity`, the report's Integrity object, and
`report`, the form the report carries),
`integrity` (A: per sandbox the failed checks with their evidence and the
changed paths), `fix` (B, [below](#the-fix-check)) and `leftoverProcesses`
(A: `steps`). A gate's basis gives its tier: `exit_code`, `input` and
`integrity` are A, `junit` is B.

## Integrity checks

`src/integrity.js` (design §9.5, §20 decision 6). gVisor separates the
sandbox from the host, not the grader from the program inside it: forge,
which writes the JUnit, runs the claim's code as the same user. So the PoC's
results are trusted only when all five checks pass; any failure sets
`gates.integrity` to `fail` (basis `integrity`, the detail names every
failed check and its first evidence) and fails `reproduces` with it. The
checks are measured by the runner wherever they can be, after every claim
process of the run is dead:

1. **Identity completeness** (`identityComplete`): every test the patch
   added has exactly one record on every run whose JUnit was read, and none
   is skipped. A missing record (renamed, skipped, never collected) is not a
   demonstrated failure; a duplicated identity makes neither record trusted.
2. **Framework-summary consistency** (`summaryConsistent`): forge 1.8.5
   writes its own summary of each suite into the suite's `<system-out>`
   (`Suite result: ok|FAILED. P passed; F failed; S skipped; finished in …`)
   and counts on `<testsuite>` and `<testsuites>` (`tests`, `failures`,
   `errors`, `skipped`). They must agree with the records; a JUnit with no
   summary is not forge's whole report. One allowance (R21-F2): forge's summary
   counts an invariant campaign as one result, while the JUnit expands it into a
   record per predicate and per handler failure, and which predicates share a campaign
   is not in the JUnit. So for those records the summary is held to a range (at least
   one failed result if any failed, at most one per record); everything else is exact,
   as are the XML counts.
3. **Exit-code consistency** (`exitConsistent`): the test command exits
   non-zero exactly when the JUnit records a failure. Without a readable JUnit
   only a non-zero exit is consistent (forge failed before its report, as on a
   compile error); an exit 0 there is an exit before forge's report.
4. **Post-run checksums** (`protectedPathsUnchanged`, `frameworkUnchanged`,
   `dependenciesUnchanged`). Before the build (the image plus the accepted
   patch, before any maker command) the runner takes a reference: a framework
   probe (`command -v forge` and `PATH` from the image's environment, then
   `forge config --json` run exactly as the maker's commands run forge, the
   same argv, environment and directory, so its output, which sees
   `foundry.toml`, remappings, `.env` and the global
   `~/.foundry/foundry.toml` alike, is the configuration every command runs
   with), and a
   hermetic manifest of `/work` and `$HOME` (GNU `find` records and `sha256sum
   -z` of every file: type, mode, size, hash or link target). After each run
   both are taken again and compared, the files first: forge runs for its
   configuration only once they are measured; later probes run the
   reference's real path (a link followed), never a link a run could
   retarget; and a forge in the work tree is run only while its own manifest
   entry is hashed and the reference's (one the reference cannot hash is
   `IMAGE_FORGE_UNWATCHED`):
   - protected: work-tree paths under `paths.protected`, tracked or not, and
     the runner's own repository (`/work/.git`: config, attributes, index and
     objects decide what the reset between runs writes; it is read again after
     each of the runner's resets);
   - dependencies: everything under forge's `libs`, `node_modules/` and
     `dependencies/` (Soldeer), new files included;
   - framework: forge's path and resolved configuration; the root
     `foundry.toml`, `remappings.txt`, `.env`, `foundry.lock`, `soldeer.lock`;
     `$HOME` but its caches (`~/.foundry/cache`, `~/.cache`); `PATH`
     directories and solc inside the work tree; forge-std under the
     dependencies (the assertion library, forge's "reporter module"); and the
     build's artifacts (`out`, and forge's compile cache
     `<cache_path>/solidity-files-cache.json`, which names the artifact files a
     later run loads instead of compiling), which may change during the first
     run (forge compiles what the build left out, e.g. after `forge build
     --skip test`) and never after it.

   **Symbolic links: the kernel resolves them** (R6-F1, R7-F1; node A3a's
   attempt 2). The listing is physical (`find` never follows a link), so a
   file listed in a set is reached through real directories only and a write
   to it changes its hash. The ways to reach other bytes through a watched
   path are a symbolic link in a set and one on the way to a set's root, and
   only those are followed:
   - every link in a set (the protected paths, the dependencies, the
     framework, and the artifacts from run 1) is resolved by the kernel inside
     the sandbox, in one hermetic exec per snapshot and level (`LINKS_SCRIPT`:
     `cd -P` and `$PWD` for a directory, `realpath -e` for anything else; the
     runner never computes a path from a link's text);
   - the kernel's answer is part of the link's own entry (`=> d /work/vendor/pkg`,
     `=> f …`, or `=> ?` when it resolves to nothing), so a link on the way
     retargeted between runs, or a target a run creates, is a change;
   - what a link leads to in the work tree joins the link's set (a directory
     with everything listed under it, or the file), and its own links are
     followed for that set in the next round: `lib/pkg -> ../bridge/../payload`
     with `bridge -> vendor/nested` watches `vendor/payload/`, where the kernel
     goes;
   - a link at or above a set's root (`libs = ["deps/lib"]` with `deps` a
     link, forge's `cache` directory a link, a protected glob's literal
     directory a link) hides everything under the root from the listing, so
     the kernel resolves the root itself, which then counts as a link of its
     set: exactly what it leads to joins (for forge's cache, only the compile
     cache). Tracked paths never lie behind a link: the forced checkout makes
     every directory on the way to one real;
   - a watched link whose real target is in, or (a directory) holds, a place
     builds and runs write to is `IMAGE_WATCH_LINK_UNCOVERED`, naming the link
     and its target: `/tmp`, `$HOME`, the work tree's root, the runner's
     repository, forge's `out`, `cache`, `broadcast` and `snapshots`
     directories (from `forge config`), `paths.tests`; so is one leading to a
     directory outside the work tree, which is not listed (a link inside it
     could lead back to where runs write, unseen). A file the set already
     watches is fine where it is (forge's executable in its cache directory,
     R1-F3), and an artifact link's target in `out/` is an artifact. A file
     on the read-only root needs nothing watched: it never changes, and its
     real path holds no link;
   - links outside the sets are never followed. That is complete: a write
     through any link lands on its real target, which the checksums see
     whenever it is in a set, and the sets are closed under the links they
     hold. A link outside them reaches nothing more than an untracked file at
     the link's own path would, which the check never watched; a maker who
     wants a linked source watched lists it under `paths.protected`;
   - a link a patch adds cannot sit in a set while `paths.tests` stays out of
     the sets (`testPathsOnly` admits only paths under it, and the protected
     reset restores `paths.protected`). Where a maker's `paths.tests`
     overlaps one (`**/*.t.sol` matches under `lib/`), such a link is the
     claim's: its check fails (`the patch adds a link inside the
     dependencies`), it is never followed, and the image is not refused.

   **Every configured root is one the snapshots cover** (R8-F1): forge's
   `out`, `cache_path` and every `libs` entry must be plain paths in the
   work tree (the listing holds `/work` and `$HOME` only, so artifacts or
   dependencies in `/tmp`, or a directory on the read-only root, would go
   unwatched); `solc` and the `PATH` directories may also be on the read-only
   root or in `$HOME`, but not in `/tmp`, a `$HOME` cache or through `..`;
   `out` and the dependency directories may not lie in the runner's repository
   or in forge's cache directory either (the snapshots sort those out first:
   the cache is skipped but for its compile cache, so `out = "cache/artifacts"`
   would be watched as nothing); and a `PATH` directory in the work tree may
   not lie in the runner's repository, forge's `out`, `cache`, `broadcast`
   or `snapshots` directories, or under `paths.tests` (a patch's file there
   would be a command). Anything else is `IMAGE_WATCH_ROOT_UNCOVERED` before any maker
   command, naming the setting and its value; nothing is dropped silently.
   "Outside the work tree" is checked step by step (R16-F1): the read-only
   root protects a link there, not what it leads to. A1's launcher check walks
   each path one component at a time from `/`, and each symbolic link directly in
   a directory it is given. One whose way meets anything the sandbox user can write,
   or owns on a mount it can write, is `IMAGE_WATCH_ROOT_UNCOVERED`, even when it
   ends back on the root (a run could retarget the link on the way), as is a
   directory the sandbox cannot list (mode 0111: a link inside it would go unseen).
   `/repo` is the sandbox user's in a builder image, but on the read-only root, so a
   tool that links into it passes. The order is the point:
   - first thing in a sandbox, before the forced checkout, while the work tree,
     `$HOME` and `/tmp` are empty: the directories the runner's own tools come from
     (a snapshot's `find` and `sha256sum`, `git`), so a dangling link to a file a
     patch would later add is never a tool. Claims, the fix check and the listing
     check alike;
   - before forge first runs (for `forge config`, after the patch): the image's
     `PATH` directories outside the work tree and `$HOME`; and forge's real path or a
     `PATH` directory under `paths.tests` is refused there, since a patch's file
     would be forge or a command;
   - then `solc`, which only forge's configuration names.

   What passes is out of the sandbox user's reach, so it needs no asking again
   after a run. A program on the read-only root that itself runs something in the
   work tree is the image's own text, which no walk can see.
   `PATH` is read as the shell reads it from `/work`, where forge runs and
   its children look commands up (R11-F2): an empty entry or `.` is `/work`, a relative entry
   lies under it, and only a real `./` prefix is stripped (`.bin` is
   `/work/.bin`).

   The host's work is linear in the listing: the closure is deduplicated by
   (set, link) and by (set, real tree) before anything is queued, and each
   tree joins by one range of the sorted listing with a skip pointer per set,
   so every listed entry is visited at most once per set. It is also capped:
   at most 1,000,000 entries in a listing, 50,000 watched links, 16 levels of
   linked trees (one exec each). 20,000 links to `.` are one batch of 20,000
   paths and one pass (attempt 1 scanned the listing once per link). Each
   path is resolved from `/work`, as forge resolves it.

   **What the build changes is the image's doing** (owner decision Q32). `forge
   build` compiles and runs nothing of the claim's, so the files held to the
   reference are compared right after it. A change is the requester's error,
   `IMAGE_WATCH_CHANGED_BY_BUILD`, never a failed check on an honest claim: a compiler
   in the image that writes into `lib/`, say. A compiler that waits past the build is
   not caught this way: `forge test` always compiles again, and forge runs `solc
   --version` on every start ([the check's scope](#the-checks-scope)).

   **Where forge itself writes is not held to the reference** (R21-F1), whatever else
   names it: its `out` and `cache_path` are outside the protected and dependency sets
   even under a protected glob (`out/**`, `**/*.json`) or a `libs` entry (`out =
   "lib/out"`), since every honest compile would otherwise fail those checks. The
   artifacts and the compile cache are held from run 1 on, as above. "Where forge
   writes" also means the settings a plain run writes to besides those two
   (`RUN_OUTPUT_SETTINGS`: an invariant's `failure_persist_dir` takes a counterexample
   on an honest PoC's first failure, the corpus and frontier directories,
   `test_failures_file`, `build_info_path`); outside the work tree they are refused.

   That is for what appears there. **Forge's output must be plain and hold nothing
   watched in the image the reference sees**, or the image is refused before any maker
   command or claim code (R22-F1, `IMAGE_WATCH_ROOT_UNCOVERED`): a watched input already
   there (`out = "lib"` beside `lib/pkg/`, `out/**` over a build the setup ran), since a
   compile may rewrite it and a run's change to it must not become the artifact the
   later runs are held to; and a link there or on the way there (`out -> build/x`), since
   forge writes through it to where no rule here names it.

   **The compiler is pinned** ([below](#the-compiler-is-pinned)). And **a compiler in the
   work tree is refused** right after the checkout, before any patch (R24-F1,
   `IMAGE_WATCH_ROOT_UNCOVERED`): forge runs a configured `solc` even to print its
   configuration, so a patch that replaced it would run before the reference is taken.
   A maker's compiler goes in the builder's tools folder, and a release named by version
   is forge's own to find. `vyper.path` is held to the same, since the pin does not cover
   it. `foundry.toml` may not use `extends` (R25-F1), it and `.env` may not be links, and a
   root file forge reads may not lie under `paths.tests` unless protected. A `fix.patch`
   that changes one is a failed fixed build, a fact (R25-F2).

   **A listed Solidity file that sets a path by inline configuration is refused** right
   after the checkout, before any patch (R23-F1, `IMAGE_WATCH_ROOT_UNCOVERED`): `///
   forge-config: default.invariant.failure_persist_dir = "lib/x"`. forge applies it when
   it runs a test and `forge config` never shows it. The scan is by text, of every
   `*.sol` in the work tree: a `forge-config:` line naming a `_dir`, `_file` or `_path`
   key, or holding a backslash, which could be a TOML escape spelling one. An over-match
   costs a requester error at the listing. A claim's own annotation is its own: not
   scanned, and its write fails its own check.

   **A watched link that leads nowhere yet is judged by where it would land** (R21-F1,
   round 22, `IMAGE_WATCH_LINK_UNCOVERED`): `alias -> out` with a protected
   `alias/Exploit.t.sol/**`, or `lib/x -> /opt/y -> /work/out/…`. It resolves to nothing
   until run 1 compiles, and then its entry would change on an honest claim. So a link
   whose landing (`realpath -m`) is where builds and runs write is refused like one
   that already resolves there.

   **What a snapshot cannot read is never unchanged** (R13-F1). A file with no
   hash (mode 000, say) has nothing to compare: in a watched set it fails that
   set's check as soon as a run leaves it ("run 1: out/payload.bin cannot be
   read"), even when an earlier snapshot could not read it either, so bytes
   changed behind mode 000 are never accepted as run 1's artifact. A directory
   `find` cannot list or enter can hide anything, on the way to a watched root
   as well as under one (forge reaches `build/out` by its path through a
   `build/` at mode 0111), and nothing honest makes one, so one anywhere in the
   listing fails `frameworkUnchanged`. At the reference either is the image's
   error, `IMAGE_WATCH_UNREADABLE`. A file outside the sets is not read by any
   check.

   Not watched: the rest of forge's cache directory (its ABI cache,
   `test-failures`, fuzz failures, rewritten on every run), the `$HOME`
   caches, `/tmp`, untracked files elsewhere (a state file the PoC writes). Tracked
   files outside the sets go back to the PoC commit by the reset before each
   re-run. A reference that cannot be read is the requester's package, found
   before any claim code runs (`IMAGE_FORGE_MISSING`, `FORGE_CONFIG_INVALID`,
   `IMAGE_FORGE_UNWATCHED`, `IMAGE_WATCH_LINK_UNCOVERED`, `IMAGE_WATCH_ROOT_UNCOVERED`, `IMAGE_WATCH_UNREADABLE`, `IMAGE_WATCH_CHANGED_BY_BUILD` (after the build), `IMAGE_TOOL_MISSING`
   when the image has no `realpath`, `IMAGE_WATCH_TOO_LARGE`: a listing over
   128 MiB or over a cap above); after a run, the same is a definitive failure
   of the checks.

   A possible later hardening, not in this node: make the watched sets
   unwritable to the sandbox user during the runs, with the checksums as the
   backup. The sandbox runs as the files' owner without the capabilities to
   change ownership, so that means restructuring A1's sandbox.
5. **Static tamper flags** (`tamperFlags`), on the lines the patch added
   (any file under `paths.tests`, shell helpers included), one per kind per
   line, at most 100, in the report's order:

   | Kind | forge form |
   |---|---|
   | `report-path-referenced` | `/proc/…`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/…`, `/dev/tty` (forge's report is its stdout), or JUnit element markup (`<testsuites`, `<testsuite`, `<testcase`) |
   | `exit-during-import` | ending forge's process from test code: `kill -<signal>`, `pkill`, `killall` (an ffi command) |
   | `exit-handler-registered` | a shell `trap … EXIT`/`INT`/`TERM`/`HUP`/`QUIT` |
   | `framework-patched` | a file cheatcode (`writeFile`, `writeFileBinary`, `writeLine`, `writeJson`, `writeToml`, `removeFile`, `removeDir`, `createDir`, `copyFile`) whose path names forge's configuration, the dependencies, `out`, `cache`, `.git` or `.foundry`; inline `fs_permissions` granting write access to the repository root, to those, or outside it |
   | `reporter-patched` | a file cheatcode writing forge-std |
   | `write-outside-repository` | a file cheatcode or an inline `fs_permissions` grant whose path is absolute, under `~` or climbs out (`..`) |

   Solidity has no import-time code or exit handler of its own: a test can
   end forge only through ffi (a signal death, which abstains: the runner runs
   forge itself, so no maker's command can mask it) and the flags read those
   commands' text.

The measured checks are what close the routes; the static flags are the
cheap signal a juror can read. Ordinary tests raise none: forge-std imports,
inline fuzz or read-only file settings, a write to a scratch directory the
maker or an inline grant allows, `console.log`, revert messages.

### The compiler is pinned

Owner decision Q37. A patch that changed what names the compiler would have forge run its
compiler before the reference is taken, and refusing each way of naming one left the next.
So the runner sets it: right after the forced checkout, before any patch, it reads `forge
config --json` on the listing's own files, and every later forge run has `FOUNDRY_SOLC` in
its fixed environment (`integrity.pinCompiler`, `forge.forgeEnvironment`). That read is the
only forge run without the variable (`forge.listedConfigArgv`); `forge.forgeArgv` refuses to
build any other without it. Each sandbox reads for itself, the fix check's too.

| The listing names | `FOUNDRY_SOLC` |
|---|---|
| A release (`solc` or `solc_version`, a whole `x.y.z`) | That release |
| A file outside the work tree | That absolute path, once walked: it may not lead through a place the sandbox can write |
| A file in the work tree | Nothing: refused, `IMAGE_WATCH_ROOT_UNCOVERED` |
| Nothing | Empty: the sources' pragmas pick among the installed releases, as forge does by itself |

forge's environment beats `foundry.toml`, `extends`, a `.env` and `FOUNDRY_CONFIG`, so what a
patch or a fix does to any of those no longer picks a compiler. Pinned on real forge, with a
marker showing the planted compiler never ran and a control showing the same route runs it
without the pin. With the variable empty, sources that need two real releases build and test
offline, with or without an `offline` key, and `auto_detect_solc = false` does not send forge
to `solc` on `PATH`.

The pin does not stand alone. Under a release, or empty, forge runs whatever the installed
release's path leads to: with `svm/0.8.32/solc-0.8.32` a link into `test/`, forge runs what a
patch put there (the Docker test "why the walk stays"). And with the variable empty a pragma can
pick any installed release, so the walk covers all of them, not only one the listing names. So
"no patch or file in the tree can choose the compiler" holds only with the refusals above in
place. It says nothing about what the installed bytes do: those are the maker's, and the listing
check [reads them](#the-official-release-look). A
`.vy` file's compiler is not covered by the variable, so `vyper.path` keeps its refusal.

An external compiler adapter (`external_compilers`, which forge runs in every build) is a
compiler the pin does not name. A listing that names one is refused before any patch, and
forge's fixed environment keeps the list empty, so no later file can add one (R24-F1, round
27). A solver named by a path in the work tree is refused the same way, in `foundry.toml` or
in a listed file's inline configuration: a patch could replace what the maker's own symbolic
tests rely on. A program a proof's own test starts during a run (ffi, or a solver the proof's
own inline configuration names) is not a compiler: it runs under the integrity checks, like
any claim code.

A proof whose pragma the listing's release cannot compile fails `build`, as it did before the
pin: `check` shows it first.

The comparisons read forge's configuration under the same pin as the reference, so the pin
is no change: the reference confirms forge reads `solc` as the pin, and refuses otherwise. A
`solc` a run writes no longer shows in that configuration, since the pin wins, so what holds
such a write is the files themselves: `foundry.toml`, `.env` and `$HOME` are watched.

### The official-release look

Owner Q35 condition 2, node A2c (`integrity.officialCompilers`). At listing, right after the
reference and before any build, the runner hashes the compilers in the image, in the sandbox,
and refuses what isn't an official release: `SOLC_NOT_OFFICIAL`, in `listing.refusals`, every
problem named.

**Official** means the file's SHA-256 is the one `binaries.soliditylang.org/<platform>/list.json`
gives the build it names under `releases`. So a prerelease doesn't count. The class platform is
`linux/amd64`. `linux/arm64` is a development setting (runc only) and uses the same rule on that
site's `linux-arm64` list, which starts at 0.8.31.

| What it reads | What must hold |
|---|---|
| Everything under `svm/` (`$XDG_DATA_HOME/svm`), whichever release the listing names: with the variable empty a pragma can pick any | `x.y.z/solc-x.y.z`, a plain readable file, with that release's bytes. `.global-version` and `x.y.z/.lock`, as plain files, are what forge's own install leaves. Anything else there is refused: a link, another name, a directory it cannot read |
| The file the pin names outside the work tree (owner Q37 condition 2), through its links | The bytes of any release on the list. An official file stays pinned; anything else is refused |
| A `solc` in each `PATH` directory, through its links | The same. forge doesn't run it under the pin (a test plants one), so this isn't needed for that: it keeps the rule "any solc" from resting on that fact |

**What forge downloads isn't always official, by this definition.** On `linux/amd64` it fetches the
official list, except `0.4.0`–`0.4.9` from `crytic/solc`: the list starts at 0.4.10, and those can't
pass the harness proof anyway (its plainest probe needs 0.4.22). On `linux/arm64` its downloads from 0.8.31 up are
the official bytes, and below that it fetches `nikitastupin/solc`, so a release forge installs below 0.8.31 is
refused on that development platform. The arm64 Docker fixtures use the official `linux-arm64` files. A Docker
test runs forge's own install on the runner's platform and pins this.

**Where the hashes come from.** `src/solcReleases.json`, generated by `scripts/solc-releases.js` from those
lists. `--write` adds what upstream has and refuses to change a hash already there; `--check` exits 1 when
upstream has a release the table lacks. `.github/workflows/solc-releases.yml` runs `--check` weekly. A release
newer than the table is refused, and the detail names the table's newest and its date. A maker on a brand-new
solc waits for a runner update.

**Only the listing reads it.** A claim never does, so two arbiters on different runner versions can't split on
a new release, and only the runner the builder calls needs the current table. That's why it isn't in
`@verdikta/common`, and why the claim tests named "Known limit" still show what a fake `solc` does to a claim:
those run the claim pipeline alone, on an image the listing check now refuses.

**Why the answer can be trusted, and holds later.** forge has already started a configured compiler to read its
configuration, so whatever that left running is killed first (`cleanup:compilers`): nothing of the maker's is alive
while the bytes are read and their hashes reported. The bytes sit on the read-only root, on no path through a place
the sandbox can write (the walk in `pinCompiler`), and the attestation binds the image by digest.

**What this leaves predicted.** That nothing else runs as solc rests on forge's lookup at the pinned version: the
pin's file, or `svm/x.y.z/solc-x.y.z`. The sandbox has no way to watch what forge execs. forge is pinned by digest, the
look covers more than the lookup needs, and a Docker test plants a compiler at each other place (`v0.8.33/`,
`0.8.34-fake/`, `0.8.35+fake/`, `0.8.36/solc`, `0.8.31/solc`, `solc` on `PATH`, a `.env` moving `XDG_DATA_HOME` or
`HOME`) and shows it never runs. A forge pin bump re-runs that test.

**What it doesn't cover.**
- **Repository code a proof calls through ffi.** Recorded below.
- **`vyper`.** A `.vy` file in the tree makes forge run `vyper` from `PATH` or `vyper.path` on every compile, and
  there's no official hash list to read it against. Refusing every `vyper` would refuse real Vyper projects. A
  fake `vyper` stays a compiler route, recorded below. `vyper.path` in the work tree keeps its refusal.

### What a failed check settles as

The runner only reports this; the settling is the EA's (node A4b). Owner decision Q35:

- **A tamper flag settles INVALID**, even when another check also failed. The flags
  read only the lines the hunter's patch added, so a maker's files cannot trip them,
  and a hunter can see them in `check` first.
- **Any other failed check settles with all weight on DUPLICATE:** bond back, no
  award, no model called, and the justification names the check in a fixed
  machine-readable form.
- **A `reproduces` failure on its own stays INVALID**, whatever integrity says: a
  test the patch added passed, errored, was skipped, went missing or appeared twice
  on a run, or the patch added none. Only a `reproduces` failure caused by integrity
  alone follows the two rules above.

The reason is that the runner cannot always tell claim code from a trap in the
maker's files, and a forfeited bond would pay the maker for the trap. This lowers
that cost; it does not settle the class. A trapped listing still doesn't pay the
honest hunter, so the maker keeps the stake on that claim. It earns no bond, and the
record shows the claim. A caught cheater loses only what the round costs: at most the
prepay, about $3.50 instead of $13.50 on a $1k listing from the example figures, and
each such claim can hold later claims and `close()` for up to the reveal window.
That griefing is to be revisited before mainnet.

On-chain these claims are DUPLICATE, so the record has to show the difference: per
listing, "claims that failed integrity: N" with the check's name, from the
justification. It stays neutral. Hunters can raise that count on purpose, so it
doesn't prove a trap and doesn't imply the maker caused it.

**What settlement reads.** All of it is in fields of common's `verdikta.claim-report/1`,
so the EA needs no `basis`, no `detail` and nothing outside the schema:

| Question | Fields of `verdikta.claim-report/1` |
|---|---|
| A tamper flag? | `poc.integrity.tamperFlags` is not empty |
| Which other check failed? | Whichever of `identityComplete`, `summaryConsistent`, `exitConsistent`, `protectedPathsUnchanged`, `frameworkUnchanged` and `dependenciesUnchanged` under `poc.integrity` is false |
| Did `reproduces` fail on its own? | `gates.reproduces` is `fail`, and `poc.testCount` is 0 or any of `pass`, `error`, `skip`, `missing` and `duplicate` under `poc.runCounts` is above 0 |
| Did it fail only through integrity? | `gates.reproduces` is `fail`, `poc.testCount` is above 0, and every counted run is `fail` (or `notRun`) |

`facts.poc` carries these fields under the same names. `gates.reproduces.basis` agrees
for a reader of the runner's result: `integrity` exactly when `reproduces` failed only
through integrity. Two things in `src/claim.js` keep the fields sufficient, and common's
rules hold on every run: a test's result is `error` on a run with a failed harness record in the
PoC's files (the report has no field for that record, and the gate fails on it), and a
test's `kind` is the one its three runs imply. `test/helpers/settlementFacts.js` lays
each result out in the schema and reads these fields, for the unit and Docker tests.

### The check's scope

**Scope of the post-run checksums (owner decisions Q32, Q35).** The check assumes an
env image from the attested builder, and the two facts that make that an
assumption it can rely on are:

- **Production trust accepts only images signed by the builder key.** The External
  Adapter enforces this, not the runner: its front gates
  (`external-adapter/src/codeReview/frontGates.js`) call `@verdikta/common`'s
  `validateAttestation`, which checks the signature against the trusted-builder
  set, the hashes of the files it binds, and the image digest, platform and size
  against `code_review.json`. Anything else is a requester error before the runner
  is called. The runner only compares the attestation's image with the spec's. Dev
  trust exists only under `CODE_REVIEW_TRUST=dev`, only on the chains in
  `DEV_TRUST_CHAIN_IDS` (Base Sepolia and a local node), and only for a statement
  signed as dev, against `CODE_REVIEW_DEV_KEYS`.
- **The image's final stage is fixed** (`stake-attestation/builder/src/dockerfile.js`
  in verdikta-applications): `FROM` the pinned base, with a fixed `ENV` (`PATH`,
  `XDG_DATA_HOME`, `VERDIKTA_TOOLS`) and no `RUN`. Only `/repo` and
  `/opt/verdikta/tools` differ from the pinned base. Both are maker-controlled, and
  the tools folder comes last on `PATH`.

Within that:

- **These block a merge:** routes a hunter can use alone, routes that help claim code,
  and runner misreadings that hit honest claims with no maker's files involved
  (R21-F2 and R22-F2 were this kind).
- **These do not:** routes that need a maker's files to make an honest claim fail.
  They stay defects, recorded below as known limits, and the refusals the runner
  already has for them stay.
- **The residual** is only a trap the maker's setup plants that helps claim code win
  (a program in the tools that itself runs something from the work tree, say: the
  image's own text, which no check inside the sandbox can read). It is recorded, not
  closed. It is not harmless to everyone but the maker. Since owner decision Q34
  (design §8.8) a listing needs the project's proof, so a stranger can't stage a valid
  finding on a project's own record that way, but they can on a fork or a copy, which
  is why it stays written down here as a residual.

**Known limits (Q35).** Open, recorded, and to be reviewed before mainnet. The tests named
"Known limit" in `test/docker/integrity.docker.test.js` pin the claim pipeline's side of these as it
is today, not as it is wanted; `test/docker/listing-integrity.docker.test.js` pins what the listing check
does about them. The runner has no clock faking: nothing in `src/` sets the sandbox's time.

Node A2c changed this table, and only as far as its tests show. On an image from the attested builder, a
`solc` that isn't an official release no longer reaches a claim: it's refused at listing, by Docker tests on
the named file, each installed release and `PATH`, with fake compilers of each kind below. No other program
is covered.

| Known limit | Where it lands | What it costs an honest hunter | What may reduce it |
|---|---|---|---|
| A program in the image other than `solc` (`vyper`, on a `.vy` file), or repository code, that writes a watched place during a run | A failed integrity check with no tamper flag: the runner cannot tell it from claim code | Bond back, no award, prepay spent. The maker keeps the stake on that claim and earns no bond | The listing's suite and probes get the checksums (`IMAGE_WATCH_CHANGED_BY_SUITE`, `HARNESS_INTEGRITY_FAILED`), which catches one that fires on what they run, not one that spares them |
| A fake `vyper` that exits with an error on a test it hasn't seen, with a `.vy` file in the tree | The `build` gate, or `reproduces` on its own if it waits for the compile `forge test` always does. Both stay INVALID | Bond to the maker, prepay spent, and the maker keeps the stake | `check` shows it first, unless it is date-keyed. The look doesn't read `vyper`: there's no official list to read it against |
| A false rejection at `reproduces`, from a trap or from a misreading nobody has found yet | `reproduces` on its own, which stays INVALID | Bond to the maker, prepay spent | `check` shows it first. A misreading with no maker's files involved blocks a merge once found, as R21-F2 and R22-F2 did |
| Repository code a proof calls through ffi | Whichever of the rows above its effect matches | As that row | Nothing at listing: the look doesn't cover it, and nothing at listing runs code only a proof would call. A hunter can read the code it calls |
| A trap keyed on the date, in repository code or `vyper` | Whichever of the rows above its effect matches | As that row, with no warning: `check` doesn't catch it, because the runner fakes no clock | In `solc` it is refused at listing, whatever the date, because the bytes aren't official. Repository code and `vyper` stay |

The routes the review raised, against that scope (each has its test):

| Route | Through the attested builder? | Side | What happens |
|---|---|---|---|
| A run leaves a watched file unreadable, or a directory unlistable, a watched root's ancestor included (R13-F1) | Yes: a hunter alone | **Blocks: hunter alone.** Closed | Its check fails |
| `out = "lib"` beside `lib/pkg/fixture.json`, a run rewriting that dependency (R22-F1) | Yes: a hunter, on such a listing | **Blocks: hunter alone.** Closed | Refused before any claim code: no claim runs on that image |
| `solc = "test/solc"` or `"0.8.31/solc"`, a patch replacing it with a wrapper, whose bytes would become the reference (R24-F1); `vyper.path` the same | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | Any compiler file in the work tree is refused right after the checkout, before any patch: `IMAGE_WATCH_ROOT_UNCOVERED`. The tools folder is where a maker's compiler goes |
| A patch changing what names the compiler: `extends` into a file under `paths.tests` (R25-F1), `foundry.toml` or `.env` a link, a root file forge reads under `paths.tests` and not protected | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | `IMAGE_WATCH_ROOT_UNCOVERED`: `extends` and the links right after the checkout, the rest before forge first runs |
| `fix.patch` changing forge's own configuration to select a compiler it adds (R25-F2) | Yes: a hunter, where `foundry.toml` is not protected | **Blocks: hunter alone.** Closed | A failed fixed build, a fact; the fixed tree is never built, and the claim's outcome doesn't move |
| A `.env` with `FOUNDRY_CONFIG` moving forge's configuration into a file a patch or a fix could change (R25-F1, R25-F2, round 26) | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | forge's fixed environment sets `FOUNDRY_CONFIG` to its own default, and forge loads a `.env` without overriding what is set |
| Any other way a patch or a fix changes what names the compiler (Q37) | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed by the pin | `FOUNDRY_SOLC` wins over `foundry.toml`, `extends`, `.env` and `FOUNDRY_CONFIG`; the planted compiler never runs |
| An external compiler adapter, or a solver named by a path, that a patch replaces (R24-F1, round 27) | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | Refused before any patch: `IMAGE_WATCH_ROOT_UNCOVERED`. `FOUNDRY_EXTERNAL_COMPILERS` is fixed empty |
| An installed release, named by version, that is a link through the work tree a patch could fill (R24-F1, round 26) | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | What is directly in the tools folder's `svm/` is walked right after the checkout: `IMAGE_WATCH_ROOT_UNCOVERED` |
| A compiler, named or installed, by a way through `/proc` (`/proc/self/cwd/test/solc`, or a link on the root to it): the work tree to forge, a pid gone by the next step to the walk (found on A2c's own attempt to get past the listing) | Yes: a hunter, on such a listing | **Blocks: helps claim code.** Closed | The walk refuses anything through `/proc`: `IMAGE_WATCH_ROOT_UNCOVERED`, at listing and at a claim |
| `/opt/verdikta/tools/bin` itself, or a link in it, leads through the work tree, directly or by a chain back to the root (R16-F1) | Yes: the maker's setup | **Blocks: helps claim code.** Closed | `IMAGE_WATCH_ROOT_UNCOVERED` first thing in a sandbox, listing included |
| A suite or PoC with invariants: a campaign's summary counted as a mismatch, a one-predicate failure read as an error, a multi-line reason lost (R21-F2, R22-F2) | Yes: any honest claim | **Blocks: runner misreading, no maker's files.** Closed | Forge's campaign counts accepted within a range; the reason read up to forge's framing |
| A `PATH` directory that cannot be listed (R16-F1) | No: the builder's `chmod -R a+rX` | Refused anyway | `IMAGE_WATCH_ROOT_UNCOVERED` |
| A runner's tool behind a link through the work tree; a dangling tool link a patch would fill (R16-F1) | No: those directories are the base's bytes | Refused anyway | `IMAGE_WATCH_ROOT_UNCOVERED` first thing in a sandbox, listing included |
| A patch's file as forge, or a `PATH` directory under `paths.tests` (R16-F1) | No: forge is the base's, first on `PATH` | Refused anyway | `IMAGE_WATCH_ROOT_UNCOVERED` before forge first runs |
| An image `ENV` of `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `GCONV_PATH` (R20-F1) | No: the `ENV` is fixed | Fixed anyway | Empty on the container |
| A `solc` in the image that isn't an official release: the named file, any installed release, `PATH` (A2c) | Yes: the maker's setup | Needs a maker's files. Refused at listing | `SOLC_NOT_OFFICIAL`, before any build. A claim never reads the list |
| A `vyper` in the image, with a `.vy` file in the tree (A2c) | Yes: the maker's setup | **Known limit** | Not read by the look. What it writes shows at the build or the listing's runs if it fires there |
| A suite, or a trap in the listing's `forge-std`, that writes a watched place (A2c) | Yes: the maker's repository | Needs a maker's files. Refused at listing | `IMAGE_WATCH_CHANGED_BY_SUITE`, `HARNESS_INTEGRITY_FAILED`, the paths named |
| A program in the image other than a `solc` the look refuses, that writes a watched place in the build | Yes: the maker's setup | Needs a maker's files. Refusal kept | `IMAGE_WATCH_CHANGED_BY_BUILD`: a requester error, at listing and at a claim |
| `paths.protected` or `libs` over forge's own output, nothing there yet (`out = "lib/out"`, `out/**`, a test's artifact with `--skip test`; R21-F1) | Yes: the maker's listing | Needs a maker's files. Handled | Where forge writes is not held to the reference: the honest claim passes, and the artifacts are held from run 1 on |
| The same over what the image already has there (`out/**` over a prebuilt `out/`; R22-F1), through a link that leads there once forge has compiled (R21-F1, round 22), or forge's output behind a link | Yes: the maker's setup or listing | Needs a maker's files. Refusal kept | Refused before any maker command or claim code: `IMAGE_WATCH_ROOT_UNCOVERED`, `IMAGE_WATCH_LINK_UNCOVERED`, at listing and at a claim |
| `[invariant] failure_persist_dir = "lib/persist"`: an honest invariant PoC writes a counterexample into a dependency directory on its first failure | Yes: the maker's `foundry.toml` | Needs a maker's files. Handled | Forge's own output: the honest claim passes |
| The same by inline configuration in a listed contract (`/// forge-config: …failure_persist_dir`; R23-F1) | Yes: the maker's source | Needs a maker's files. Refusal kept | Refused right after the checkout, before any patch: `IMAGE_WATCH_ROOT_UNCOVERED`, at listing and at a claim |
| A setup that makes a watched listing unreadable or too large, or a watched link uncovered | Links and size yes, modes no | Needs a maker's files. Refusal kept | The reference's requester errors, at listing and at a claim. At listing the caps keep room for a claim's patch |
| A program the image ships other than `solc` (`vyper`), or repository code a PoC calls (ffi, cheatcodes), that writes a watched place during a run | Yes: the maker's setup or repository | **Known limit** | A failed check with no tamper flag: bond back, no award. The claim side is pinned by Docker "Known limit" (with a fake `solc`, which the listing now refuses) |
| A fake `vyper` that exits with an error on a test it has not seen | Yes: the maker's setup | **Known limit** | The `build` gate, or `reproduces` on its own: INVALID. The claim side is pinned by Docker "Known limit" (with a fake `solc`, which the listing now refuses) |
| A false rejection at `reproduces` | Yes: a trap, or a misreading not yet found | **Known limit** | INVALID. A misreading with no maker's files involved blocks a merge once found |
| A trap keyed on the date, in repository code or `vyper` | Yes: the maker's setup or repository | **Known limit** | As its effect, and `check` doesn't catch it: the runner fakes no clock. In `solc` it is refused at listing |
| A program on the read-only root that itself runs something a run can change, to help claim code | Yes: the maker's setup | Residual (Q32) | Recorded above |

### Tamper routes under forge

| Route | Check that closes it | Tests |
|---|---|---|
| ffi child prints a forged JUnit to forge's stdout (`/proc/$PPID/fd/1`) and kills forge; unmasked | the kill is a signal death: abstain | Docker `junit-forged-early-exit` |
| the same, the maker's command masking the exit (`! forge test …`) | the command is `COMMAND_NOT_ALLOWED` (attempt 3); were forge's death masked, exit-code and framework-summary consistency, `report-path-referenced`, `exit-during-import` | Docker (refused) and unit `junit-forged-early-exit` |
| the same, with forge's summary forged too, and the PoC's identity twice, behind a wrapper (`sh -c …`) | the wrapper is `COMMAND_NOT_ALLOWED`; identity completeness | Docker (refused) and unit `test-report-duplicate-identity` |
| bytes a test writes into forge's stdout beside forge's own JUnit | the strict reader: unreadable JUnit, an error (A2a) | A2a's Docker inject test |
| a test that skips itself or vanishes on later runs | identity completeness | Docker and unit `test-report-missing-identity` |
| inline `fs_permissions` + `vm.writeFile` rewrites `foundry.toml` (e.g. `ffi = true`) during run 1 | protected and framework checksums, `forge config` fingerprint; `framework-patched` | Docker and unit `protected-file-modified-at-runtime` |
| `vm.writeFile` patches forge-std (the assertion library) | framework and dependency checksums; `reporter-patched` | Docker and unit `reporter-monkeypatched` |
| ffi edits an untracked `lib/` dependency (or `node_modules`) so a later run compiles it | dependency checksums (no static flag catches it: measured) | Docker and unit `dependencies-edited-during-run` |
| `~/.foundry/foundry.toml`, `~/.gitconfig` or `.env` written for later runs | `$HOME`/config checksums, `forge config` fingerprint | unit `$HOME is watched` |
| a `forge` (or another tool) planted on a writable `PATH` directory | `command -v forge` and the PATH directories in the work tree | unit `the forge executable` |
| `.git/config` filter, a hook, a forged index or objects, so the runner's reset writes the claim's bytes | the runner's repository checksums | unit `the runner's repository is watched` |
| forged artifacts in `out/` for runs 2-3 to execute without recompiling, or a compile cache pointing a source at another artifact file | artifacts and the compile cache held to run 1's | unit `artifacts` |
| a maker's command runs a script under `paths.tests`, which the PoC rewrites | the command is `COMMAND_NOT_ALLOWED`: a command names no script (a pattern naming a test file is not a script, so a PoC editing that file raises no flag) | unit `commands.test.js`, tamper-flag tests |
| a maker's command running forge with another configuration: `FOUNDRY_PROFILE`, `--config-path`, `--root`, a path flag, a hidden alias such as `--compiler-version`, through `env`, by an absolute path, `env -u` (R11-F1) | the grammar refuses every such command (`COMMAND_NOT_ALLOWED`, the token named) at claim and listing time; the runner runs forge itself, from `/work`, with its own environment; an image `ENV` of `FOUNDRY_*` never reaches it | unit `commands.test.js`, `forgeargv.test.js`, Docker "A3a R11-F1 (attempt 3)" |
| a file flood that hides a change | a listing over 128 MiB or 1,000,000 entries is a definitive failure (before any claim code: `IMAGE_WATCH_TOO_LARGE`; at the listing check, over 64 MiB or 680,000 entries) | unit snapshot and cap tests |
| a change behind a watched link (`lib/pkg -> ../vendor/pkg`, a symlinked `lib/`, a link inside the tree a link leads to) | the kernel resolves each watched link in the sandbox; its target joins the link's set, transitively | unit and Docker "A3a R6-F1" |
| a set's root behind a link (`libs = ["deps/lib"]`, `deps -> third_party`; `cache` a link) | the kernel resolves the root itself; exactly what it leads to joins | unit "a link at or above a set's root", Docker "A3a R6-F1 (round 7)" |
| `..` after a link in the middle (`lib/pkg -> ../bridge/../payload`, `bridge -> vendor/nested`) | the kernel's answer (`vendor/payload`) is what is watched, never a path computed from the link's text | unit and Docker "A3a R6-F1 (round 7)" |
| a watched link into forge's `cache/` (or `out/`, `broadcast/`, `snapshots/`, `.git`, `paths.tests`, `/tmp`, `$HOME`, the work tree's root, a directory outside the work tree) | `IMAGE_WATCH_LINK_UNCOVERED`, the link and its target named | unit and Docker "A3a R6-F1 (round 7)" |
| a link on the way retargeted between runs, or a dangling watched link's target created | the kernel's answer is part of the link's entry: a change | unit "links whose targets change", Docker "A3a R6-F1 (round 7)" |
| many links (20,000 to `.`) to make the host's work quadratic | deduplication before queueing, one range per tree, caps on links and levels: linear and bounded | unit and Docker "A3a R7-F1" |
| forge's `out`/`cache_path` (or a `libs` entry, `solc`, a `PATH` directory) configured where the snapshots list nothing (`/tmp`), or `out`/a lib inside the cache directory or `.git` (R8-F1) | `IMAGE_WATCH_ROOT_UNCOVERED` before any maker command | unit, pipeline and Docker "A3a R8-F1" |
| an image `ENV` naming a shared object at a path a run can write: `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `GCONV_PATH` (R20-F1) | empty on the container, so the launcher and every step inherit the empty value | unit `sandbox.test.js`, Docker "A3a R20-F1" |
| a helper, `solc` or the runner's own tool (`find`, `sha256sum`) reached through a `PATH` directory or link on the read-only root whose way leads through the work tree, even back to the root, or a `PATH` directory that cannot be listed (R16-F1) | A1's launcher check walks each one before any claim code: `IMAGE_WATCH_ROOT_UNCOVERED` | pipeline and Docker "A3a R16-F1" |
| a claim's write to an artifact in run 1, under a glob that also names `out/` (R21-F1) | what forge writes is held as an artifact from run 1 on, not to the reference; the residual below | unit, pipeline and Docker "A3a R21-F1" |
| a run rewriting an existing dependency or protected file that `out` or `cache_path` lies over (R22-F1) | `outputConflicts` refuses the image at the reference | unit, pipeline and Docker "A3a R21-F1 (round 22) and R22-F1" |
| a watched link dangling into forge's output, /tmp or $HOME, resolved later (R21-F1, round 22) | `?` answers carry the landing; `watchLinks` refuses them like resolved ones | unit, pipeline and the same Docker test |
| a forged summary on a suite with invariants (R21-F2) | outside the campaign range it fails `summaryConsistent`; the XML counts stay exact | unit and Docker "A3a R21-F2" |
| a link the patch adds inside a watched set (only where `paths.tests` overlaps one) | that set's check fails; never followed, never the image's error | unit and Docker "a link the patch adds" |
| bytes changed behind an unreadable file in a watched set or `out/`, or anything hidden by an unlistable directory, a watched root's ancestor or a link's target included (R13-F1) | what a snapshot cannot read is never unchanged: the check fails; at the reference, `IMAGE_WATCH_UNREADABLE` | unit, pipeline and Docker "A3a R13-F1" |

Residual risk (decision 6): within run 1, claim code can still write a new
artifact after forge's compile that runs 2-3 would execute. That does not
change `reproduces`, which any PoC can satisfy with a trivially failing
assertion: what the checks protect is that the recorded runs are the image's
code under test, and the jury reads the PoC's source (and A3c's honesty
flags).

## claimedObservable

`src/observable.js` (§10.1), decided only on a PoC that reproduced, from
finding.json and the recorded failures alone:

- **The tests finding.json names** are the identifiers in `poc.command` and
  `poc.observable` that are the function name of a test the runner knows (a
  test the patch added, a test of the PoC's files, a baseline test). At
  least one must be named, and every one named must be a test the patch
  added (which, the PoC having reproduced, failed on every run).
- **The observable appears in the recorded failure**: each text in double
  quotes in `poc.observable` appears in the failure message of a named test
  on every run; or, when it quotes nothing, the message of a named test (the
  same on every run) appears in the observable as written. The message is
  forge's own, whole, or the form the report carries (repository-relative,
  at most 2,000 characters): either matches. Whitespace runs compare as one
  space.

So a finding names its test and quotes what forge printed:
`"observable": "test_withdraw_drains fails with \"vault balance 0 after one withdraw\""`.
The hunter tool (P5) checks the same rule locally.

## The report and the context pack

`src/report.js`, `src/pack.js`, `src/runtime.js` (design §9.3, §9.4, §10.3 item 5,
§10.4; node A3b).

### The report

Built field by field from what the run measured, validated and hashed by
`@verdikta/common` (`validateClaimReport`, `reportSha256`), in its canonical form.
So nothing else reaches it: no duration, host name, path or per-run directory. The
same claim gives the same hash, under these rules:

| Rule | How |
|---|---|
| Input digests | From the request's bytes: `pocPatchSha256`, `fixPatchSha256`, `attestationSha256` (SHA-256 of the attestation's canonical JSON), `envImage`, `listingCid`, `bcid`, `baseCommit`; `eaGates` as the EA sent them, which can only be both `pass` |
| The runtime | Measured on every run: `<path> --version` of the binary `docker info` names, read as `runsc version release-YYYYMMDD.N`. Under `runsc`, any release but `GVISOR_RELEASE`, or one that cannot be measured (a relative path, a binary that fails), abstains `admission_refused` and fails `/health`. `runc` is recorded as `runc`, which common's validator warns about (local mode). The runner and its daemon share a host (§9.1), so the path is local |
| A test's message | Only when byte-identical on all three runs of the schedule, else `null` (one failure beside two skipped records has nothing to agree with). A clock, an unseeded random value or a per-run directory moves between runs, and is measured doing so. The results stand either way; `facts.poc.tests` keeps forge's text |
| A flaky test | A test whose results (`pass`, `fail`, `error`) disagree across the schedule is reported as `error` on all three runs with one fixed message, whichever run passed, in `runCounts` too (past the 200 tests the report lists). It disproved the claim either way, so what the settlement reads (`settlementFacts.js`) is unchanged; `facts.poc.tests` keeps what each run did. `skip`, `missing` and `duplicate` are integrity's, and stay |
| What a hunter writes | Cannot make a report invalid, which would make every arbiter abstain: a test id over 1,024 characters becomes a prefix plus its SHA-256; messages are well-formed and cut on a whole character; a tamper flag past the report's last line number (a padded test file) is file-level. The JUnit reader already refuses control characters and surrogates in a record |
| What a requester sends | Refused before any work: see the request above, and `BASELINE_INVALID` for a stable test id a regression could not name |

**The report has no field for the compiler the run pinned** (owner decision Q37). It
is a function of the image and the listed commit, which it records; the answer holds
it as `facts.compiler`.

**Known limits.** A message constant on one host and different on another stays
in the report: a container id read through an inline `fs_permissions` (which works
from a PoC without the listing's consent), a kernel string through ffi, a clock
rounded to the day. Three runs on one host cannot see it, and Docker cannot fake
`CLOCK_REALTIME`. That claim's hash differs between arbiters; no settlement reads a
message. A PoC that happens to fail on all three runs on one host and not on another
gives different verdicts: design §9.3, and G2's exit criterion. `fix.*` is one suite
run and informational. `gates[…].detail` is not hashed and can name a run: it is for
operators, not for anything every arbiter must agree on.

### The context pack

Read before any claim code runs, right after the patch's commit, from git's objects
by commit id, never the work tree: `git diff -W --full-index <listed> <poc>`, `git
cat-file --batch` on `<commit>:<path>`, `git grep -n -w -F -I -z -e <symbol> <listed>`
(with the commit stripped from each line), `git ls-tree`. Then a pure function of those
reads and the request's documents, so a later step cannot reach it. Nothing is
assembled again. A patch that fails `applies` or `testPathsOnly` has no pack: no jury
reads it. `cat-file` and `grep` are read as streams, record by record and line by
line, so an early binary file or a huge match out of scope costs only what is kept of it
and hides nothing after it.

```json
{
  "version": 1, "codeClass": "code-standard", "budgetTokens": 60000, "usedTokens": 41200, "sha256": "…",
  "tiers": [
    { "rank": 3, "name": "source", "status": "full", "asked": 3, "delivered": 2, "omitted": { "outOfScope": 1 }, "cut": 0, "bytes": 9000, "bytesIncluded": 9000, "tokens": 2250 },
    { "rank": 4, "name": "callSites", "status": "truncated", "asked": 31, "delivered": 12, "omitted": { "outOfScope": 9, "pastCap": 10 }, "cut": 0,
      "symbols": { "found": 4, "withSites": 3, "noSites": 1, "overCap": 0, "longLines": 0 }, "bytes": 2400, "bytesIncluded": 2400, "tokens": 600 },
    "…"
  ],
  "files": [ { "name": "00-manifest.json", "tier": "manifest", "text": "…" }, { "name": "01-poc-diff.patch", "tier": "poc", "text": "…" }, "…" ]
}
```

`files` go to the AI Node in order, as named attachments (`attachments`,
`attachmentNames`): A4b sends nothing of `report.md`, `finding.json`, the known
issues or the prior findings beside them. The first is the manifest, which says what
each tier kept.

**Nothing leaves silently (measured).** Everything gathered from a list goes through
one account (`Tally`): an item is delivered, or omitted with a reason from a fixed
list, and an account that does not add up stops the run as a runner error. The
manifest gives each tier `asked`, `delivered`, `omitted` and `cut` (what was delivered
in part), with `asked = delivered + the sum of omitted`, counts and fixed codes only:
no path, name or other text of the request. A tier's `status` is computed from them:

| Status | When |
|---|---|
| `full` | Something was delivered, and nothing was lost |
| `truncated` | Something was delivered, and something was lost |
| `dropped` | Nothing was delivered, and something was lost |
| `empty` | Nothing was delivered, and nothing was lost |

*Lost* means left out for a cap, a read limit, a size bound or the budget: `overBudget`,
`pastCap` (a site past 10 for its symbol), `unreadable` (a `git grep` line whose path
did not fit what is read of a line), `unread` (a path git never answered for), anything in
`cut`, a symbol past the 16 searched for, or a PoC line too long to read whole. The other
reasons are facts about the request or the repository, which no larger limit would
have changed, and they leave the status alone: `outOfScope`, `notInCommit`, `notAFile`,
`notAskable` (a path that is not one line), `duplicate`, `noDiff`, and `binary`, since
the jury reads text whatever the budget. A binary file gets no file of its own; a juror
can see it was named in `finding.json`, and the count says one was left out.

Each tier counts what it holds. `poc` and `source` count files, `claim`, `fix` and `tree`
their one or two files, `knownIssues` and `priorFindings` entries (each whole or not at
all). `callSites` counts the lines `git grep` answered with, and `symbols` beside them
what was searched for (`found = withSites + noSites + overCap`).

| Rank | Tier | Share | What |
|---|---|---|---|
| 1 | `poc` | 30% | `poc.patch` with function context; each PoC file's full text |
| 2 | `claim` | 10% | `finding.json` (canonical), `report.md` |
| 3 | `source` | 24% | The in-scope files `finding.affectedPaths` names, at the listed commit |
| 4 | `callSites` | 5% | At most 10 in-scope call sites of each of at most 16 symbols the PoC's added lines call (`.name(`, `.name{…}(`, `new Name`), without `vm.`, `console.` and the language's own, one per line: `symbol: path:line: text` |
| 5 | `knownIssues` | 12% | `known_issues.json`, one entry per line, each within 8 KB: its id, title and class stay, then its paths and its description give way. A shortened entry counts in `cut` |
| 6 | `priorFindings` | 19% | Up to 8 summaries, one per line: `bcid`, `title`, `claimedClass`, `rootCause`, 5 of `affectedPaths`, `observable`; never a prior `report.md`. A summary that lost paths or text to its bound counts in `cut` |
| 7 | `fix` | | `fix.patch`, as text |
| 8 | `tree` | | The listed commit's first two levels |

Each of tiers 1-6 first takes up to its share, in order. What is left goes back up in
order, then to tiers 7 and 8. So a hunter who pads `poc.patch` or `report.md`, or names
200 huge files, cannot push out the known issues and the prior findings a juror needs
to find a duplicate, and 8 summaries always fit. Over budget the lowest tiers go first.
A file is cut on a whole character, at a line end where that keeps at least half, with
a line saying how much was shown; a tier of entries keeps whole entries.

**A token** is `ceil(UTF-8 bytes / 4)`, plus 160 bytes per file for the AI Node's fence
lines. On real files (cl100k): Solidity 4.2-4.9 bytes per token, prose 5.4, so a full
pack is about the design's 60k. Hex, base64 and CJK cost more (1.4-2): text written to
cost more can reach about 2.9 × on the hunter-written tiers, as operator spend. No
tokenizer is pinned, and providers count differently.

**Evidence stays data.** Each item is one file, so the AI Node's content-hash fence
(`ai-node/src/lib/code-review/claim-prompt.ts`) wraps it alone, and a hostile item
cannot close its block or open the next one's. File names are the runner's own
(`03-source-001.txt`): a path or a word of the hunter's reaches no name, only the text
inside the fence. Every text opens with the runner's own `# ` line, so none can start
`data:`, which the AI Node would decode or refuse.

## Honesty flags and the fix check's lint

`src/scanner.js`, `src/semgrepPin.js`, `rules/` (design §9.2 step 9, §9.5, §10.6;
node A3c). Tier-A facts about what a test does, for the jury's fourth question.
They reach `poc.honestyFlags` and `findings`, never `poc.integrity` and never a
gate: under the owner's Q35 a tamper flag settles INVALID, and these must not.

### The pin

| What | Where | Checked |
|---|---|---|
| `semgrep/semgrep` 1.181.0, by the index digest | `src/semgrepPin.js` | Digest and platform measured at each run and on `/health`; the version in Semgrep's answer |
| The honesty rules (Semgrep) | `rules/honesty.yml`, rule set `2026.10` | SHA-256 before use |
| The bug rules, byte for byte the builder's | `rules/solidity.yml`, rule set `2026.10` | SHA-256 before use |
| The rules that read text | `TEXT_RULES` in `src/scanner.js` | Their hash, in the test below |

A change to any of them needs a new `RUNNER_VERSION`: `inputs.runner` is what ties a
report to them, and `test/unit/scanner.test.js` fails otherwise, by
`test/fixtures/scanner-pin-history.json`. `@verdikta/common` pins the rule-set version,
not this digest. The builder's baseline scan pins the same release in
verdikta-applications, with no check between the two repositories. Nothing needs them
to agree: what the builder finds goes to the maker privately and is never hashed.

The runner never pulls this image. The installer warms it (node A8). Missing or wrong,
`/health` says so under `scanner` and a claim abstains before any work
(`image_unavailable`, `image_mismatch`). The image cache never evicts it.

### What the runner forces

| Semgrep's behaviour, measured on 1.181.0 | What the runner does |
|---|---|
| A directory target with a `.semgrepignore` of `*`: scans nothing, no error, exit 0 | Explicit targets, under names it chooses (`f0.sol`), with no other file in the tree; the bytes come on stdin |
| With no ignore file, its own list skips `test/`: every ordinary PoC would scan nothing, and read as clean | The same |
| `// nosemgrep`, `// nosem` drop a flag | `--disable-nosem` |
| `.semgrep.yml`, `.semgrep/` | Never in the tree; `--config` names the runner's file |
| `--baseline-commit` runs `core.fsmonitor` from `.git/config` | The repository is built in the scanner's sandbox from the runner's bytes: no `.git` a claim could have touched |
| Past 10,000 matches of one rule in one file: **every** result of that file dropped, a warning, exit 0 | Read: the rule is stated, the file is stated unread, and its cheatcode names stay flags |
| A `pattern-regex` rule also matches comments, so a comment could reach that cap | The rules that read text are not in Semgrep |
| A wall-clock limit per rule | `--timeout 0`: a slow host must not change a flag |
| **Under gVisor, stdout is cut at 65,536 bytes with exit 0** (runc: whole) | `--output` to a file, read with `cat`: whole under both |
| A rule it skipped is listed in `skipped_rules` beside its results, and reads like one that found nothing | Any skipped rule, or another engine, abstains |
| `solidity.yml`'s ellipsis rule used more than 2 GiB on a crafted 16 KiB file, killing the engine | `--max-memory 1024`: a per-file `Out of memory`, exit 0, a stated fact |
| `--x-…` flags | Not used: Semgrep says they are not its API |

The bytes are read from git's objects by id, before any claim code runs, and put in one
form (`normaliseSource`): well-formed UTF-8, no NUL, every line end solc's documentation
names a line feed, with a line number carried back to git's. Today this is a safeguard more than a
fix: solc 0.8.31 runs code after a lone CR in a comment and refuses the other separators,
and Semgrep's parser honours a CR too.

forge compiles an import of any name (`import "./Helper.txt"` works), so every file the
patch adds or changes goes to Semgrep as Solidity, `.sol` first. Only a `.sol` file's parse
failure is stated: a JSON fixture that does not parse is not a scan that failed. A file past a
limit is stated by any name, so padding a `.txt` hides nothing.

### A scan that could not finish

It must never read as "no flags", since a hunter gains from that.

| Cause | In | Result |
|---|---|---|
| A parse failure, whole or partial | The file | `unread-file`, `unread-part` with its lines, on a `.sol` file; in a file not wholly read, a cheatcode's name on any line is `unread-reach`, whatever is around it and whatever the file's name, since what the parser lost can be wider than it says |
| A rule past the match cap | The file | That rule, file-level; `unread-file`, by any name; the names stay flags |
| Semgrep's memory bound (`Out of memory`) | The file | `unread-file`, by any name; the names stay flags |
| Past a limit below, not a regular file, or not reported as read | The file | `not-scanned` with its reason, by any name; the names stay flags |
| Any other error kind, a non-zero exit, an answer it cannot account for, a rule or a path it was not given | The tool | Abstain (`runner_error`, step `scan`) |
| The step's timer, OOM, a dead sandbox | The host | Abstain, as for any step |
| The image missing or wrong, or the rule files changed | The install | `/health`, and abstain before any work |

Stated facts rank above every rule, so padding cannot push one out of the 50. A hunter
can force one of them, but it costs a visible fact, and the names on the file's lines stay flags as
far as text can tell.

**Limits, and why these numbers.** Semgrep gets at most 64 files and 64 KiB in all; the text
rules read 4 MiB a file and 16 MiB in all. They are measured, not timed:

| Shape, in one file (an Apple M-series host under load, runc, arm64) | 1 MiB | 128 KiB | 64 KiB |
|---|---|---|---|
| `x = a+a+a+…` | over 150 s | 56 s | 9 s |
| `a.etch.etch.etch…` | | over 100 s | 36 s, then the match cap |
| `a.etch;` flood | | 2 s, the match cap | 32 s, 8,194 flags |
| `x = !!!!…a`, `a=a=a=…` | the engine is killed | 6 s, 3 s | 2 s, 2 s |
| Nested `(((…)))` | 20 s | 2 s | 2 s |
| Bug rules: `t.call{value: 1}("");x();y();z();` flood | | | 63 s |
| Bug rules: `t.call{value: 1}("");m[t] = 1;` flood | | | `Out of memory` in 38 s |

On a GitHub runner (amd64) the worst shape at 64 KiB, the `a.etch;` flood, took 69 s under runc and
156 s under gVisor; the Docker tests print these on every run. A scan's timer is 240 s, and the
scan's budget 420 s, outside `runSeconds`: a claim's run may spend all of `runSeconds`, and a
listing's limits know nothing of a hunter's file, so this could otherwise turn any listing's run
into an abstention. Admission and the pull's window leave only 60 s for it, an honest scan's
(under 6 s under gVisor). Past that the one deadline bounds it, which only a hostile file on a
listing near the class maximum can reach.

The scanner's sandbox has every sandbox's flags, with fixed limits (2 CPUs, 2 GiB, 512
pids) since a spec may ask for 256 MiB. It opens last, once the claim's sandboxes are closed,
so admission holds at least its memory and no more sandboxes than before.

### The rules

| Rule (`verdikta.honesty.…`) | Severity | Reads |
|---|---|---|
| `storage-overwrite` | high | `vm.store`, `setArbitraryStorage`, `copyStorage`, `loadAllocs`, stdstore's `checked_write` |
| `code-overwrite` | high | `etch`, `deployCodeTo` |
| `call-mocked` | high | `mockCall`, `mockCallRevert`, `mockCalls`, `mockFunction` |
| `process-started` | high | `ffi`, `tryFfi` |
| `cheatcode-raw-call` | high | A low-level call on `address(vm)`, `VM_ADDRESS`, `HEVM_ADDRESS` |
| `cheatcode-signature` (text) | high | A state-changing cheatcode's signature or selector |
| `store-shaped-call`, `store-named-arguments` (text) | medium | `store` with three arguments on another receiver, or with named arguments |
| `cheatcode-address` (text) | medium | The cheatcode address by value |
| `network-reach` | medium | Forks, RPC, `transact` |
| `filesystem-write` | medium | Writing, copying, removing files |
| `clock` | medium | `rewind`, `warp`/`roll` backwards, to 0 or to `type(T).max`, `unixTime`, `sleep` |
| `filesystem-read` | low | Reading files or their metadata |
| `block-environment` | low | `setBlockhash`, `prevrandao`, `chainId`, `fee`, `coinbase` and the like, nonces, `setEnv` |

**The clock.** The framework gives every test forward moves: `vm.warp`, `skip`, `vm.roll`.
Beyond that: moving block time or numbers backwards or to the end of their type, which no
chain does, and reading or waiting on the host's own clock, which makes a result depend on
when it ran. A clock stubbed through a mock or a store is `call-mocked` or `storage-overwrite`.

**`$X.store`, decided by fixtures.** `vm.store(...)` alone misses `Vm cheat = vm;
cheat.store(...)`, `Vm(HEVM_ADDRESS).store(...)` and a hunter's own interface on the
cheatcode address. `$X.store($A, $B, $C)` catches all of them, and also a contract's own
three-argument `store`; `vault.store(1)` stays clean. These flags are facts for the jury and
not gates, so a false positive costs a line a juror reads past, with the receiver in front of
them, while a miss is what a dishonest hunter is looking for. So the wide form stays, under its
own rule id, a severity below the literal one, in words that say it may be a contract's own
function. Names that are common on contracts (`fee`, `chainId`, `exists`) stay on `vm` alone,
and a call through an alias there is missed; they change little.

**What a flag says of a hunter.** A flag's message says whether the patch added its lines. A
file the patch changes is scanned whole, so a maker's `vm.store` in it is seen but not put on
the hunter. The kept 50 go by severity, then the patch's own lines first.

### The fix check's lint

Facts only: the claim's gates are as they would be without it. Over the files the fix changed,
read before any of its code runs, under the same limits as a PoC's.

**`forge fmt --check`** on the `.sol` ones, last, once the claim's sandboxes are closed, in a fresh
sandbox of the env image holding only the listed `foundry.toml` and the fixed bytes. No claim code
has run there and none runs beside it, so a fix's own code cannot reach what it reads, a fix that
changes `foundry.toml` changes nothing, and its time is the scan's budget, not the run's. It goes
through `forgeArgv`, one file a call: beside another file, one it cannot parse goes unreported. Exit
1 means a diff or a parse failure, and what it printed says which. A long sum or chain can abort it
with exit 134, seen on arm64, which is a stated finding too, since a fix's lint must not abstain the
claim. Its diff quotes source, so only the path is kept. A maker's `[fmt] ignore` globs do not match
the runner's flat names, so a file they exempt can read as unformatted: a fact about formatting.
If there is no forge in that sandbox (an image whose forge lives in the work tree), or the listed
`foundry.toml` is over 1 MiB, it is `forge-fmt.not-run`: never clean, and never the requester's error.

**Semgrep** with the bug rules and `--baseline-commit` over all of them, so what the listed commit
already had is not the fix's. A listed version past the limits is not scanned, and
`verdikta.scan.no-baseline` says its findings are not told apart from the listed commit's. A fact the
runner states outlives the bound of 50.

`commands.lint` is not read: the lint is the runner's own argv, and the grammar in `src/commands.js`
is unchanged. A scan that fails on the host abstains, as every step of the fix check does.

### Known limits

- **A determined hunter can hide from static rules:** a cheatcode address computed at run time,
  a signature built by `string.concat`, a call in assembly through a computed address. The rules
  cannot follow these. The jury reads the test's source, and §10.6's adversarial fixtures measure
  what is left.
- **In a file no parser wholly read, what always stands is the stated fact.** The names on its lines
  are a best effort on the text, which cannot follow every alias.
- **The text rules read comments:** a test that names a cheatcode's signature in a comment is
  flagged. The cost is small, since these strings have no business there.
- **A crafted file at the edge of the memory bound** could read differently between hosts. No gate
  reads it, and it is the same class as A3b's recorded limit on report hashes.
- **`// forgefmt: disable-…`** in a fix makes forge fmt pass that code. It is a fact about
  formatting, and nothing settles on it.
- **Any runner that takes claims needs the image:** `/health` is not `ok` without it.

## The fix check

`src/fix.js` (§9.2 step 8, §20 decision 14). Only when the claim carries
`fix.patch`; informational, never a gate. A second sandbox (`ctx.openSandbox`,
the same flags) is started before the PoC's own steps and runs beside them;
admission holds the spec's memory for both (`sandboxes: 2`, `src/server.js`),
and the engine refuses a step that opens more sandboxes than the run was
admitted for. In it:

1. The forced checkout, then `poc.patch` with its `applies` and
   `testPathsOnly` checks, protected paths reset, committed: the check runs
   the PoC with the fix. A PoC that fails there fails the fix check.
2. `fix.patch` on top: the same host-side checks as `poc.patch` (size, no
   NUL, no rename or copy, **no binary change**), `git apply`, the measured
   expansion, and every touched path outside `paths.tests` and
   `paths.protected` and nameable in a report (source allowed; tests and
   protected paths not). Committed (`fix.patch`). `fix.applies`.
3. The reference snapshot, then `commands.build`. `fix.builds` (a fix that
   applied is always built: `pass` or `fail`, never `not-run`). A reference
   that cannot be read here (the fix broke `foundry.toml`, say) is the fix's
   doing, since the PoC's sandbox read the same tree without it: `builds:
   fail` with the reason, never the requester's error.
4. The maker's full suite (`commands.test`, required with a fix) **once**,
   with the reporter flags, then a snapshot. `fix.pocPasses`: every test the
   patch added (as the PoC's own run 1 reported them, this run's when the
   PoC's sandbox has none) has exactly one record and passes, and no PoC
   suite failed before its tests ran (a `setUp` that now fails). `fix.regressions` /
   `regressionCount`: every baseline `stable` test that does not pass (fails,
   errors, is skipped, missing or duplicated), the first 200 in code-unit
   order.
5. The integrity checks on that run: identity (the PoC's tests and every
   stable identity, each exactly once, none skipped, no PoC suite failing
   before its tests), forge's summary, the
   exit code, the checksums and the static flags of both patches.
   `fix.integrity`.

One run of the suite rather than the PoC and the suite apart: a second run in
the same sandbox would execute what the first run's claim code left behind.
A step that hits a limit abstains the whole run: an informational fact is
still one every arbiter must agree on. `facts.fix` (tier B) carries
`present`, `applies`, `builds`, `pocPasses`, `regressions`,
`regressionCount`, `integrity` (the report's fields), `detail` (why it
applied or not, how the build ended), `patch` and `diff` (tier A), the fix
sandbox's `checkout` and `leftoverProcesses`, and `suite` (the run). Without
`fix.patch` it takes the not-run values.

**Binary changes in fix.patch are refused** (this node's rule, beside owner
decision Q28 for poc.patch). A fix to Solidity source is text; a binary
postimage can name an existing object whose size the patch's bytes do not
bound; keeping one host-side scan for both patches means the measured
expansion and the diff facts mean the same thing for both; and since the
fix is informational, refusing one costs the hunter nothing: the report says
`applies: fail` with the reason.

## Images and admission

`src/admission.js`, `src/images.js` and `src/registry.js` (design §9.1,
§9.2 steps 1-2, §9.6, §12). Before any sandbox, in this order:

1. **Admission.** A1's checks (maintenance lock, deadline against
   `runSeconds`, daemon, runtime), then:
   - **an execution slot** (`CODE_RUNNER_SLOTS`, default 1), held from
     admission until every sandbox of the run is gone. A sandbox that could
     not be removed keeps the slot, its memory and the image held: the runner
     retries the removal in the background (2 s, doubling to 60 s; the GC may
     get there first) and releases them only once it is gone;
   - **the memory reserve**, as in verdikta-agents' sandbox-kit: the host's
     `MemAvailable` (`/proc/meminfo`), less the memory limits of the runs
     already admitted (their whole limit, whatever they use yet) and this
     run's limit, must leave the reserve. The reserve is headroom for
     Chainlink, Postgres and the AI Node on top of what they use now, and
     the largest local (Ollama) model, which an evaluation may load at any
     time (`CODE_RUNNER_RESERVE_*_MB`; the installer, A8, sets the model's).
     Memory that cannot be measured refuses under `runsc`; under `runc`
     (macOS has no `/proc/meminfo`) it is admitted with a warning.
2. **The env image.** In the time that still leaves `runSeconds`:
   - **The allowlist.** `CODE_RUNNER_REGISTRY_ALLOWLIST` (default
     `ghcr.io/verdikta`): entries `host[:port][/path]`, matched on the
     image's registry host exactly and on whole path components
     (`ghcr.io/verdikta` allows `ghcr.io/verdikta/env`, not
     `ghcr.io/verdikta-x/env`). References are read as Docker resolves
     them: no host means Docker Hub (`docker.io`, `library/` for one name),
     so Docker Hub is `docker.io/<namespace>`. A loopback entry
     (`127.0.0.1:5000`, `localhost:5000`, `[::1]:5000`) is a **dev** entry
     for a local `registry:2`: never in the default, marked `dev` in
     `/health` and at startup. Not on the list: `registry_not_allowed`, with
     no Docker call.
   - **By digest only.** `src/registry.js` `pullArgs()` is the only place a
     `docker pull` argv is built (`test/unit/policy.test.js`), and it takes
     `name@sha256:<hex>` and nothing else: `docker pull --quiet --platform
     <platform> <host/path@sha256:…>`, the canonical name, so what is pulled
     is what was checked. A tag, a tag beside the digest, upper case or any
     form Docker would read otherwise is refused (the spec's image is a 400).
     The daemon checks every byte against the digest, so a registry (or the
     CDN it redirects blob downloads to) can only make the pull fail.
   - **The size check first.** A pull needs the attested unpacked size plus
     the compressed layers while they are extracted (at most the class's
     2 GB; the containerd image store keeps them), on top of the bytes pulls
     in flight had reserved when the free space was sampled and
     `CODE_RUNNER_DISK_RESERVE_MB`, all against the free space of the data
     root (`CODE_RUNNER_DATA_ROOT`, else the
     daemon's `DockerRootDir`). The sandboxes' scratch is memory (tmpfs), so
     the image is all a run adds to the disk. Free space that cannot be
     measured refuses a pull under `runsc`, and is allowed with a warning
     under `runc` (Docker Desktop's data root is inside its VM).
   - **LRU eviction** makes the room: least recently used first, one image
     at a time, until the pull fits. Only images whose every reference is on
     the allowlist; never a base image pinned in `@verdikta/common`
     (`BASE_IMAGE_PINS`, by digest), an image a run holds (from before its
     pull until its sandboxes are gone) or a pull is fetching, an image any
     container uses, or a dangling image. `docker image rm` is never forced,
     so the daemon refuses an image in use too. Last use is kept in memory:
     after a restart the images found count as least recently used.
   - **Verified before use.** After the pull, and for a cached image, the
     image the digest reference resolves to must carry that digest and be of
     the platform that runs (`image_mismatch` otherwise). A cached image of
     another platform is pulled again for this one.
   - **Concurrent runs.** Presence, the disk check, eviction and starting a
     pull happen under one lock, so two runs never count the same free bytes;
     two runs that need the same image share one pull. Waiting for the lock
     and everything done under it follow the run's window and cancellation:
     each Docker call is cut off and nothing further starts, so no run holds
     the lock, or its slot, past its time (`admission_refused` when the time
     ran out before any pull of its own, `cancelled` when the caller left). A run that runs out of
     time while it waits abstains (`pull_failed`) and the pull carries on for
     the others (and for the EA's retry); the pull itself stops at
     `CODE_RUNNER_PULL_TIMEOUT_SECONDS` (default 90, §11's budget).

Every failure abstains: an error with no commit (§12, "Registry or
image-pull failure"), never a verdict.

## Time

- Admission refuses a run whose deadline, less the reserve, cannot cover
  `runSeconds`.
- Each step is bounded by its own limit, the run's `runSeconds` and the
  deadline less the reserve (5 s by default). The first to pass kills the
  container (`docker rm --force --volumes`) and the run abstains with that
  cause.
- Teardown has until the deadline itself, never longer: the answer is sent by
  then, and a removal still running carries on in the background for the GC to
  finish. Each sandbox's removal waits for its own launch (the fix check's may
  still be in `docker create`), so its container is removed once it exists and
  the slot and memory stay held until then (A3a). A run is definitive only once every sandbox it started is gone; one
  that could not be removed (or not by the deadline) abstains `docker_error`.
- Every Docker control call has its own timeout, and the run stops at the
  deadline even if a step is stuck outside Docker.
- Step logs keep the first and last 32 KiB of stdout and of stderr
  (`src/capture.js`); reads through `readFile` stop at their cap.

## Cleanup and maintenance

- Every sandbox is removed when its run ends, whatever happened.
- Stopping (SIGTERM, SIGINT) admits no new run, cancels the runs in flight and
  waits until each has removed its sandboxes.
- One process per instance: the listener is the lock. A second process with
  the same configuration fails to listen before its startup GC can touch the
  first one's containers.
- No run is admitted until the startup GC has removed what an earlier process
  of this instance left (A1b): those sandboxes hold no slot or memory in the
  new process, so until they are gone the capacity they use would look free.
  Admission opens only once a listing finds none left (a removal's exit code
  alone is not taken as proof; the GC counts a failed removal as done only
  when every error is "No such container"). A sweep that fails is retried
  every 5 s; meanwhile runs abstain `admission_refused` and `/health` is 503
  with the reason (`capacity.held`).
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
| `CODE_RUNNER_PLATFORM` | `linux/amd64` | `linux/arm64` only with `runc`, for Apple silicon without amd64 emulation. |
| `DOCKER_HOST` | CLI default | The daemon the runner drives. |
| `CODE_RUNNER_DOCKER_BIN` | `docker` | The docker CLI. |
| `CODE_RUNNER_DATA_ROOT` | the daemon's `DockerRootDir` | Where `/health` measures free bytes. |
| `CODE_RUNNER_STATE_DIR` | `code-runner/.state` | The runner's `DOCKER_CONFIG` and default lock file. |
| `CODE_RUNNER_MAINTENANCE_FILE` | `<state>/maintenance` | The maintenance lock. |
| `CODE_RUNNER_INSTANCE` | `default` | Label scope for the GC. |
| `CODE_RUNNER_GC_INTERVAL_SECONDS` | `60` | `0` turns the timer off. |
| `CODE_RUNNER_DEADLINE_RESERVE_MS` | `5000` | Time kept for teardown and the response. |
| `CODE_RUNNER_REGISTRY_ALLOWLIST` | `ghcr.io/verdikta` | Where env images may be pulled from: `host[:port][/path]` entries, comma or space separated. A loopback host is a dev entry (a local `registry:2`). |
| `CODE_RUNNER_SLOTS` | `1` | Runs at once (1-16). |
| `CODE_RUNNER_RESERVE_CHAINLINK_MB` | `512` | Memory headroom kept for Chainlink. |
| `CODE_RUNNER_RESERVE_POSTGRES_MB` | `256` | For Postgres. |
| `CODE_RUNNER_RESERVE_AI_NODE_MB` | `512` | For the AI Node. |
| `CODE_RUNNER_RESERVE_LOCAL_MODEL_MB` | `0` | The largest local (Ollama) model; the installer sets it when Ollama runs. |
| `CODE_RUNNER_DISK_RESERVE_MB` | `1024` | Space that stays free on the data root after a pull. |
| `CODE_RUNNER_PULL_TIMEOUT_SECONDS` | `90` | A pull's own limit (1-900). |
| `LOG_LEVEL` | `info` | JSON lines on stdout. |

## Tests

```bash
npm test                                   # unit tests, no Docker
CODE_RUNNER_RUNTIME=runc npm run test:docker    # needs a Docker daemon
CODE_RUNNER_RUNTIME=runsc npm run test:docker   # Linux with gVisor registered as runsc
```

The Docker tests pull `ubuntu:24.04` and the foundry base pinned in
`@verdikta/common` by digest (for `CODE_RUNNER_PLATFORM`, which they set to
`linux/arm64` on Apple silicon under runc, where the base's arm64 variant of
the same release runs), run one test per abstain cause, check the real
isolation of a container and remove everything they start.
`pull.docker.test.js` runs a throwaway `registry:2` (`registry.js`) on the
daemon host's network, listening on 127.0.0.1 only (under Docker Desktop that
is the VM, where the daemon is), pushes small fixture images to it and
removes them from the daemon, so that the runner has to pull them: the pull by
digest (the registry's log holds no request by tag), an unreachable or
non-allowlisted registry, a digest the registry lacks, a corrupted blob,
another platform, LRU eviction around a pinned, a held and a
container-used image, and the slot limit.
`claim.docker.test.js` and `listing.docker.test.js` build fixture Foundry repositories as env images
locally (`forgeFixture.js`: FROM the pinned base, solc 0.8.31 by SHA-256,
the repository at `/repo`); under Docker's classic image store, where a local
build has no repository digest, it pushes them to a throwaway `registry:2`
on 127.0.0.1 first. `integrity.docker.test.js` runs every A3a fixture in
its forge form against real forge (ffi and file-cheatcode attempts, stdout
mimicking forge's JUnit, `lib/` edits), ordinary PoCs that must raise
nothing, and the fix check. `listing-integrity.docker.test.js` runs one test per
refusal code of the listing check's integrity (each a claim's too, on the same
image), the official-release look by every route, and ordinary projects that must pass,
with an honest claim on them. CI
(`.github/workflows/code-runner.yml`) runs the unit tests, and the Docker tests
under `runc` and under the pinned gVisor on the systrap platform.
`report.docker.test.js` runs the catalogue's three determinism fixtures against
real forge: the same claim in two containers with other clocks and hostnames, one at
`--cpus 0.25` (the test holds that forge really took longer), gives the same verdict,
report hash and pack hash. Cross-host is G2's.

## Seams

- **Steps** (`src/steps.js`): `claimSteps(request, limits)` returns the steps
  the engine runs, in order (A2a: `src/claim.js`). A step is `async (ctx) => {}`
  with `ctx.exec(argv, { name, timeoutMs, stdin, env, workdir, tee })` (`tee`, a
  `capture.Prefix`, also receives the program's stdout without ever stopping
  it), `ctx.readFile(path, { maxBytes })`, `ctx.gate(name, status, basis, detail)`,
  `ctx.fact(name, value)`, `ctx.openSandbox()` (a second container with the
  same flags, for the fix check), `ctx.remainingMs()` and `ctx.limits`.
- **Forge commands** (`src/commands.js`): `parseCommand(key, text)`,
  `commandIssues(commands, key)`, `forgeArgs(parsed, values)`, the allowlists
  (`COMMANDS`, `FLAGS`). The one grammar: `checkForgeSpec` (claims) and
  `validateListingRequest` (the listing check, A2c) both use it.
- **Forge adapter** (`src/forge.js`): `forgeArgv(tool, args)` (forge's whole
  argv: `env -i`, its fixed environment, the probed forge), `forgeEnvironment`,
  `toolProblem`, `FORGE_WORKDIR`, reporter flags, the test identity,
  `classifyRecord`, `$FILES` and `$TEST_IDS`; A2b's baseline reuses them.
- **Claim session** (`src/claim.js`): `claimSession(request, limits, { adopt })`
  gives the claim pipeline's step functions over one state (`prepare`,
  `applies`, `testPathsOnly`, `resetAndCommit`, `watch`, `build`,
  `reproduces`, `pocRun`, `cleanup`); `adopt` takes the processes, the
  checkout and the integrity reference of a session that already prepared the
  sandbox. `claimSteps` runs
  them in order, with the fix check's start and end around them; the listing
  check (`src/listing.js`) runs them on its suite and its probes, gating into a scope of its
  own. No maker command runs without the reference, whose forge and pin every
  run uses. `KIT` holds the steps both of a claim's sandboxes
  run (apply and measure a patch, read what it touched, reset, commit, build,
  a forge run), which `src/fix.js` reuses.
- **Integrity** (`src/integrity.js`): `Watch` (the reference and post-run
  snapshots of a sandbox; `tool()` is the forge the maker's commands run),
  `discoverForge`, `summaryConsistency`, `exitConsistency`,
  `identityGap`, `tamperFlags`, `integrityOf`.
- **Common** (`src/common.js`): everything the runner reads from
  `@verdikta/common`: `CLASS_HARD_LIMITS`, `SPEC_LIMIT_MAXIMA`, `OCI_PLATFORM`,
  `BASE_IMAGE_PINS`, `FORGE_FUZZ_SEED`, `GVISOR_RELEASE`, `SEMGREP_RULES_VERSION`,
  `REPORT_LIMITS`, `getCodeClass`, `pocPatchPathsGate`, `matchesAny`,
  `splitByStakeScope`, `baselineSets`, the validators and the report's hash. No
  local copy of any of them is left in `src/` (`test/unit/common.test.js`).
- **Scanner** (`src/scanner.js`, `src/semgrepPin.js`): `readChanged` (a commit's changed files, by id),
  `prepareTargets`, `prepareFix`, `openScanner`, `scanPoc`, `scanFix`, `fmtFindings`, and the pure parts
  (`semgrepArgv`, `parseScan`, `honestyFlags`, `fixFindings`, `boundFlags`, `boundFindings`). The engine's
  `ctx.openSandbox({ image, limits, tool })` runs a tool's image, `ctx.beginToolBudget(ms)` restarts the
  run's timer for it, and `executeRun({ preflight, minMemoryMb, toolReserveMs })` checks and holds for it.
- **Report** (`src/report.js`): `buildReport(result, request, { gvisor, platform })`,
  `assembleReport`, `finishClaim` (the server's), `pocReportForm` (the form `facts.poc.report`
  holds). A4b reads the report; `test/helpers/settlementFacts.js` is its mirror.
- **Pack** (`src/pack.js`): `gatherPackInputs(ctx, …)` (the sandbox's reads),
  `assemblePack({ request, inputs })` (pure), `TIERS`, `symbolsOf`, `summaryOf`.
  The engine's `ctx.contextPack(pack)` carries it beside the facts.
- **Runtime** (`src/runtime.js`): `measureRuntime`, `runtimeProblem`; `docker.runtimeVersion(path)`.
- **Launch** (`src/sandbox.js`): `createArgs`, `startArgs`, `execArgs`,
  `removeArgs` and the `Sandbox` class. The engine's sandbox handles
  (`ctx.openSandbox()`, and the first one) have `close()` (`ctx.closeSandbox()`
  for the first): a step done with a sandbox removes it, as the listing
  check does before each fresh probe sandbox.
- **Admission** (`src/admission.js`): `admitRun` (A1's checks) and
  `Capacity` (slots, the memory reserve), whose ticket the engine releases
  once the run's sandboxes are gone. `executeRun({ sandboxes })` passes how
  many sandboxes the run opens at once to admission, which holds
  `memoryMb` for each (A3a: 2 with a fix check), and the engine refuses a
  step that opens more.
- **Images** (`src/images.js`, `src/registry.js`): `ImageCache.acquire()`
  (allowlist, disk check, LRU eviction, pull, verify) gives a lease the
  engine releases with the ticket; `parseImageRef`, `parseAllowlist`,
  `pullArgs`.
- **Launcher** (`src/launcher.js`): `launcherArgv`, `newNonce`, `StartGate`;
  every exec goes through `Sandbox.runLaunched`.
- **Result** (`src/result.js`): `ABSTAIN`, `DEFINITIVE_BASIS`, `Abstain`,
  `RequesterError`, `makeGate`, `classifyExec`.
