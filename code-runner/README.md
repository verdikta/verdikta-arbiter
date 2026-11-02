# code-runner

The arbiter's code runner for stake-backed security attestation
([design](../docs/development/stake-attestation-design.md) §9). The External
Adapter calls it for a claim; it runs the claim's proof of concept in a fresh,
isolated container and reports what happened. It never judges: the EA turns
gate failures into INVALID, and the jury reads the report.

Node A1 of the build is the service shell, the isolation, the limits, the
deadline and the result taxonomy; node A2a adds the forge claim pipeline:
the `applies`, `testPathsOnly`, `build` and `reproduces` gates
([below](#the-forge-claim-pipeline)); node A1b the image pull by digest from
a registry allowlist, the image cache and the slot and memory admission
([below](#images-and-admission)); node A3a the five integrity checks of §9.5
with the evidence tiers, the `integrity` and `claimedObservable` gates
([below](#integrity-checks)) and the fix check
([below](#the-fix-check)). Later nodes add listing checks (A2b), the report
and context pack (A3b) and the honesty flags (A3c). See [Seams](#seams).

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
refused.

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

`attestation.env` must name the image, platform and unpacked size
`code_review.json`'s `env` names (`ATTESTATION_IMAGE_MISMATCH`,
`ATTESTATION_PLATFORM_MISMATCH`, `ATTESTATION_SIZE_MISMATCH`), and the image
must be a reference Docker resolves exactly as written. These, and what the
claim pipeline would refuse in the request itself (`FRAMEWORK_UNSUPPORTED`,
`COMMAND_MISSING`, `BASELINE_INVALID`, …), are a 400 before admission or any
pull.

| Status | `outcome` | Meaning for the EA |
|---|---|---|
| 200 | `definitive` | Every step ended in a fact the arbiters may settle on. A failed gate means INVALID; all passing goes to the jury. |
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
  "report": null, "reportSha256": null, "contextPack": null
}
```

`image` says how the env image was had (`hit`, `pulled`, or `shared`: a pull
another run started); it is operational and never part of the report, since
it differs between arbiters. `gates` holds `{ status: "pass"|"fail", basis, detail }` per gate decided;
a gate not reached is absent. `facts` holds what the steps observed (the
patch, its flags, the PoC runs; see below). `report`, `reportSha256` and
`contextPack` stay `null` until node A3b.

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
docker create --pull never --platform linux/amd64 --name vcr-<run>-<n> --label verdikta.code-runner=1 …
  --runtime runsc --network none --cap-drop ALL --security-opt no-new-privileges
  --read-only
  --tmpfs /work:rw,exec,nosuid,nodev,size=1024m,mode=0755,uid=10001,gid=10001
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777
  --tmpfs /home/sandbox:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001
  --ipc none --user 10001:10001 --pids-limit 4096 --memory 4096m --memory-swap 4096m --cpus 2
  --hostname sandbox --env TZ=UTC --env LANG=C.UTF-8 --env CI=true --env PYTHONHASHSEED=0
  --env HOME=/home/sandbox --workdir /work
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

`src/claim.js` with `src/forge.js`, `src/git.js`, `src/patch.js` and
`src/junit.js` (design §9.2 steps 3-6, §10.1). For a forge listing
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

**Commands** run as written in the sandbox's `/bin/sh` with pathname expansion
off (`set -f; <command>`). For `testFiles` and `testIds` the runner appends
`--junit --fuzz-seed 0x76657264696b7461` (the seed from `@verdikta/common`)
as arguments (`"$@"`), and every build and test step gets
`FOUNDRY_FUZZ_SEED` too. `$FILES` is one forge glob over the Solidity files
the patch added or changed (`{a.t.sol,b.t.sol}`, glob characters escaped);
`$TEST_IDS` an anchored regex over the exact signatures forge matches
`--match-test` against (`^(?:test_a\(\)|test_b\(uint256\))$`). A listing
must declare `build`, `testFiles` with `$FILES` and `testIds` with
`$TEST_IDS` (`COMMAND_MISSING`, `COMMAND_PLACEHOLDER`, `COMMAND_INVALID`).

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

`facts` (A3b builds the report from them), each an object carrying its
evidence tier (§9.5: `tier: "A"`, observed by the runner from outside the
tested process; `tier: "B"`, reported by a process that ran claim code):
`checkout` (A, above), `patch` (A: bytes, SHA-256, the measured expansion),
`commit` (A: `base`, `poc`), `diff` (A: files, added, removed, binary
files), `testPaths` (A: outside, protected, unreportable), `flags` (A:
`existingTestsModified`, `skipMarkersAdded`, `protectedPathsTouched`,
`frameworkReferences`: forge inline config, JUnit markup, file and
environment cheatcodes, `foundry.toml`, `ffi`), `protectedReset` (A:
`files`), `poc` (B: `testCount`, `runCounts`, the first 200 tests with their
three results, kind and message, per run the command, JUnit status, exit code
and failing harness records, and `integrity`, the report's Integrity object),
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
   summary is not forge's whole report.
3. **Exit-code consistency** (`exitConsistent`): the test command exits
   non-zero exactly when the JUnit records a failure. Without a readable JUnit
   only a non-zero exit is consistent (forge failed before its report, as on a
   compile error); an exit 0 there is an exit before forge's report.
4. **Post-run checksums** (`protectedPathsUnchanged`, `frameworkUnchanged`,
   `dependenciesUnchanged`). Before the build (the image plus the accepted
   patch, before any maker command) the runner takes a reference: a framework
   probe run like the maker's commands (`command -v forge`, `PATH`, and
   `forge config --json`, whose output sees `foundry.toml`, remappings, `.env`,
   the global `~/.foundry/foundry.toml` and the environment alike), and a
   hermetic manifest of `/work` and `$HOME` (GNU `find` records and `sha256sum
   -z` of every file: type, mode, size, hash or link target). After each run
   both are taken again and compared:
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

   Not watched: the rest of forge's cache directory (its ABI cache,
   `test-failures`, fuzz failures, rewritten on every run), the `$HOME`
   caches, `/tmp`, untracked files elsewhere (a state file the PoC writes). Tracked
   files outside the sets go back to the PoC commit by the reset before each
   re-run. A reference that cannot be read is the requester's package, found
   before any claim code runs (`IMAGE_FORGE_MISSING`, `FORGE_CONFIG_INVALID`,
   `IMAGE_WATCH_TOO_LARGE`: a listing over 64 MiB); after a run, the same is a
   definitive failure of the checks.
5. **Static tamper flags** (`tamperFlags`), on the lines the patch added
   (any file under `paths.tests`, shell helpers included), one per kind per
   line, at most 100, in the report's order:

   | Kind | forge form |
   |---|---|
   | `report-path-referenced` | `/proc/…`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/…`, `/dev/tty` (forge's report is its stdout), or JUnit element markup (`<testsuites`, `<testsuite`, `<testcase`) |
   | `exit-during-import` | ending forge's process from test code: `kill -<signal>`, `pkill`, `killall` (an ffi command) |
   | `exit-handler-registered` | a shell `trap … EXIT`/`INT`/`TERM`/`HUP`/`QUIT` |
   | `framework-patched` | a file cheatcode (`writeFile`, `writeFileBinary`, `writeLine`, `writeJson`, `writeToml`, `removeFile`, `removeDir`, `createDir`, `copyFile`) whose path names forge's configuration, the dependencies, `out`, `cache`, `.git` or `.foundry`; inline `fs_permissions` granting write access to the repository root, to those, or outside it; a patch that changes a script a maker's command names |
   | `reporter-patched` | a file cheatcode writing forge-std |
   | `write-outside-repository` | a file cheatcode or an inline `fs_permissions` grant whose path is absolute, under `~` or climbs out (`..`) |

   Solidity has no import-time code or exit handler of its own: a test can
   end forge only through ffi (a signal death, which abstains unless the
   maker's command masks it) and the flags read those commands' text.

The measured checks are what close the routes; the static flags are the
cheap signal a juror can read. Ordinary tests raise none: forge-std imports,
inline fuzz or read-only file settings, a write to a scratch directory the
maker or an inline grant allows, `console.log`, revert messages.

### Tamper routes under forge

| Route | Check that closes it | Tests |
|---|---|---|
| ffi child prints a forged JUnit to forge's stdout (`/proc/$PPID/fd/1`) and kills forge; unmasked | the kill is a signal death: abstain | Docker `junit-forged-early-exit` |
| the same, the maker's command masking the exit (`! forge test …`) | exit-code and framework-summary consistency; `report-path-referenced`, `exit-during-import` | Docker and unit `junit-forged-early-exit` |
| the same, with forge's summary forged too, and the PoC's identity twice | identity completeness | Docker and unit `test-report-duplicate-identity` |
| bytes a test writes into forge's stdout beside forge's own JUnit | the strict reader: unreadable JUnit, an error (A2a) | A2a's Docker inject test |
| a test that skips itself or vanishes on later runs | identity completeness | Docker and unit `test-report-missing-identity` |
| inline `fs_permissions` + `vm.writeFile` rewrites `foundry.toml` (e.g. `ffi = true`) during run 1 | protected and framework checksums, `forge config` fingerprint; `framework-patched` | Docker and unit `protected-file-modified-at-runtime` |
| `vm.writeFile` patches forge-std (the assertion library) | framework and dependency checksums; `reporter-patched` | Docker and unit `reporter-monkeypatched` |
| ffi edits an untracked `lib/` dependency (or `node_modules`) so a later run compiles it | dependency checksums (no static flag catches it: measured) | Docker and unit `dependencies-edited-during-run` |
| `~/.foundry/foundry.toml`, `~/.gitconfig` or `.env` written for later runs | `$HOME`/config checksums, `forge config` fingerprint | unit `$HOME is watched` |
| a `forge` (or another tool) planted on a writable `PATH` directory | `command -v forge` and the PATH directories in the work tree | unit `the forge executable` |
| `.git/config` filter, a hook, a forged index or objects, so the runner's reset writes the claim's bytes | the runner's repository checksums | unit `the runner's repository is watched` |
| forged artifacts in `out/` for runs 2-3 to execute without recompiling, or a compile cache pointing a source at another artifact file | artifacts and the compile cache held to run 1's | unit `artifacts` |
| a maker's command runs a script under `paths.tests`, which the PoC rewrites | `framework-patched` (the patch changes a script a command names) | unit tamper-flag tests |
| a file flood that hides a change | a listing over 64 MiB is a definitive failure | unit snapshot test |

Residual risk (decision 6): within run 1, claim code can still write a new
artifact after forge's compile that runs 2-3 would execute; a forger that
also forges forge's summary and identities exactly can pass checks 1-3 when
the maker's command masks forge's death. Neither changes `reproduces`, which
any PoC can satisfy with a trivially failing assertion: what the checks
protect is that the recorded runs are the image's code under test, and the
jury reads the PoC's source (and A3c's honesty flags).

## claimedObservable

`src/observable.js` (§10.1), decided only on a PoC that reproduced, from
finding.json and the recorded failures alone:

- **The tests finding.json names** are the identifiers in `poc.command` and
  `poc.observable` that are the function name of a test the runner knows (a
  test the patch added, a test of the PoC's files, a baseline test). At
  least one must be named, and every one named must be a test the patch
  added (which, the PoC having reproduced, failed on every run).
- **The observable appears in the recorded failure**: each text in double
  quotes in `poc.observable` appears in the recorded failure message of a
  named test on every run; or, when it quotes nothing, the recorded message
  of a named test (the same on every run) appears in the observable as
  written. Whitespace runs compare as one space.

So a finding names its test and quotes what forge printed:
`"observable": "test_withdraw_drains fails with \"vault balance 0 after one withdraw\""`.
The hunter tool (P5) checks the same rule locally.

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
   applied is always built: `pass` or `fail`, never `not-run`).
4. The maker's full suite (`commands.test`, required with a fix) **once**,
   with the reporter flags, then a snapshot. `fix.pocPasses`: every test the
   patch added has exactly one record and passes. `fix.regressions` /
   `regressionCount`: every baseline `stable` test that does not pass (fails,
   errors, is skipped, missing or duplicated), the first 200 in code-unit
   order.
5. The integrity checks on that run: identity (the PoC's tests and every
   stable identity, each exactly once, none skipped), forge's summary, the
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
  finish. A run is definitive only once every sandbox it started is gone; one
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
`claim.docker.test.js` builds fixture Foundry repositories as env images
locally (`forgeFixture.js`: FROM the pinned base, solc 0.8.31 by SHA-256,
the repository at `/repo`); under Docker's classic image store, where a local
build has no repository digest, it pushes them to a throwaway `registry:2`
on 127.0.0.1 first. `integrity.docker.test.js` runs every A3a fixture in
its forge form against real forge (ffi and file-cheatcode attempts, stdout
mimicking forge's JUnit, `lib/` edits), ordinary PoCs that must raise
nothing, and the fix check. CI
(`.github/workflows/code-runner.yml`) runs the unit tests, and the Docker tests
under `runc` and under the pinned gVisor on the systrap platform.

## Seams

- **Steps** (`src/steps.js`): `claimSteps(request, limits)` returns the steps
  the engine runs, in order (A2a: `src/claim.js`). A step is `async (ctx) => {}`
  with `ctx.exec(argv, { name, timeoutMs, stdin, env, workdir, tee })` (`tee`, a
  `capture.Prefix`, also receives the program's stdout without ever stopping
  it), `ctx.readFile(path, { maxBytes })`, `ctx.gate(name, status, basis, detail)`,
  `ctx.fact(name, value)`, `ctx.openSandbox()` (a second container with the
  same flags, for the fix check), `ctx.remainingMs()` and `ctx.limits`.
- **Forge adapter** (`src/forge.js`): reporter flags, the test identity,
  `classifyRecord`, `$FILES` and `$TEST_IDS`; A2b's baseline reuses them.
- **Integrity** (`src/integrity.js`): `Watch` (the reference and post-run
  snapshots of a sandbox), `summaryConsistency`, `exitConsistency`,
  `identityGap`, `tamperFlags`, `integrityOf`; `src/claim.js`'s `KIT` holds
  the steps both sandboxes run (apply and measure a patch, read what it
  touched, reset, commit, build, a forge run), which `src/fix.js` reuses.
- **Common** (`src/common.js`): `BASE_IMAGE_PINS`, `FORGE_FUZZ_SEED`,
  `pocPatchPathsGate`, `matchesAny` from `@verdikta/common` (A3b moves the
  class limits there too).
- **Launch** (`src/sandbox.js`): `createArgs`, `startArgs`, `execArgs`,
  `removeArgs` and the `Sandbox` class.
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
