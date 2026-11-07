# The code-review sandbox

Optional. A node needs it only to judge stake claims (code classes 133 and 134, or class 5555 with
code review on); text-mode requests never use it. [Design](../../../docs/development/stake-attestation-design.md) §9.1, §16.

## What it installs

```bash
<install>/code-review-sandbox.sh enable          # or answer yes when install.sh or upgrade-arbiter.sh offers it
```

| What | Where |
|---|---|
| gVisor, the release `@verdikta/common` pins, SHA-512 checked | `/opt/gvisor/<release>/runsc` |
| A disk image, 40 GB by default (`--disk-gb`, at least 12), allocated up front | `/var/lib/verdikta-code-runner.img`, mounted at `/var/lib/verdikta-code-runner` |
| Its own Docker daemon and containerd: units `verdikta-code-runner-disk`, `-containerd`, `-docker`, on at boot | `/etc/verdikta-code-runner/`, socket `/run/verdikta-code-runner/docker.sock` |
| The code runner, on `127.0.0.1:8090` with a token; started and stopped with the arbiter | `<install>/code-runner/` (`.env`, `logs/`) and `<install>/code-runner-state/` (token, pass, lock) |
| The pinned Foundry base and Semgrep images, on its daemon | the disk |
| `CODE_REVIEW_*`, `CODE_RUNNER_*` and `NETWORK_CHAIN_ID` | `<install>/external-adapter/.env` |

It needs root or passwordless sudo, the free disk (the image plus 10 GB left over), and about +2 vCPU and
+4 GB of RAM while judging, on a host that meets the [host requirements](#host-requirements). It installs
no package: if something is missing, it says what.

## Host requirements

- **Dedicated vCPUs, 4 or more**, not shared or burstable.
- **8 GB of RAM.**
- **An SSD**, with room for the disk image (above).

The conformance self-test that `enable` runs is the gate. A host that passes it can judge claims, and
one that fails it cannot, whatever its figures. The list above comes from the few hosts measured below.

**Why a host fails.** Before any claim, the runner prepares the sandbox inside gVisor. Part of that is
two walks over many small files: the runner's own tool directories (`integrity.requireImmutableTools`,
the step `prepare:tools`), then the work tree and the image's other watched paths (the reference
`watch`, steps `integrity:reference:*`). Every file costs gVisor system calls, and on a slow or shared CPU those add up. The listing
check times the whole preparation and refuses the listing as `LISTING_TOO_HEAVY` when 3 × the
preparation + 2 s is above the class's 360 s run (`minimumRunSeconds` in `code-runner/src/listing.js`;
the 360 s is `CLASS_HARD_LIMITS.runSeconds` in `@verdikta/common`). So a preparation over about 119 s
fails on its own, and one close to that leaves too little time for the build and the suite, which the
check refuses the same way. The self-test's canary goes through this check, so a slow host fails
`enable` with:

```
preparing the sandbox took N s; 3x that alone is above the class's 360 s run
```

or with a `step_timeout` in a step of the preparation, such as `prepare:tools`. `enable` then prints a
line pointing to this section.

**A quick check (optional).** It times 3,000 small file writes in a gVisor sandbox. gVisor is installed
first thing in `enable` and stays after a failed one (`ls /opt/gvisor` shows the release). Run it a few
times:

```bash
sudo /opt/gvisor/<release>/runsc --platform=systrap --network=none do /bin/bash -c \
  'd=$(mktemp -d); time (for i in $(seq 3000); do echo x > "$d/$i"; done); rm -rf "$d"'
```

On the hosts that passed, `real` was about 1 s or less, and the repeats stayed close to each other.
Several seconds, or repeats that swing widely, point to a slow or shared CPU. The self-test still decides.

**What has been measured.** Only a few hosts so far, so take these as a hint, not a benchmark:

| Host | Preparation | Quick check | Self-test |
|---|---|---|---|
| A dedicated 4-vCPU CI VM | not recorded | not recorded | passes |
| A shared-CPU 4-vCPU VPS | 186 s | 1.9 to 11 s | fails |
| An 8-vCPU VPS, on the same kernel (5.4) as the one that failed | not recorded | about 0.5 s | passes |

## What it leaves alone

The arbiter's Docker: it never restarts or reloads `docker.service` or `containerd.service`, never
reads or writes `/etc/docker`, and never touches `cl-postgres` or `chainlink`. Its daemon adds no iptables
rules, so `arbiter-firewall.sh` and Docker's own rules are unaffected. It adds one host interface, `vcr0`,
a bridge with a link-local address and nothing attached. It cannot see the arbiter's containers or images,
and the arbiter's Docker cannot see its. Pulls and scratch can fill only its disk.

`disable` and `enable` restart the External Adapter, only if its settings changed. That is the one
arbiter process they touch.

## The conformance self-test

`enable` warms the images and runs a fixed canary listing and claim through the real runner under
gVisor, then compares the report's hash with the one `@verdikta/common` publishes. It takes a few
minutes, port 5987 on loopback, and needs `ghcr.io` and `binaries.soliditylang.org`. A pass is kept
in `code-runner-state/conformance.json` and holds for that runner, gVisor and common release.

The runner holds itself to it: with no pass for its version, gVisor, common release and its own source, its
`/health` is 503 and claims abstain. A new pass counts with no restart. Nothing else on the node notices: text
requests never call the runner. `register-oracle.sh` refuses a code class, or 5555 with code review on, without a pass. It also refuses one job on both 133 and 134, which would make
it eligible for both price tiers: `VA_REGISTER_JOB_IDS` names the jobs of a registration, so each
class gets its own.

## Afterwards

| Command | |
|---|---|
| `code-review-sandbox.sh status` | 0 ready, 1 not installed, 2 installed and not ready, 4 this host cannot |
| `code-review-sandbox.sh self-test` | Run the canary again |
| `code-review-sandbox.sh warm` | Pull the pinned images again |
| `code-review-sandbox.sh disable` | Off; the disk image stays |
| `code-review-sandbox.sh disable --purge` | Off, and the disk image is freed. gVisor stays: another sandbox may share it |

The runner's Docker daemon leaves mounts in its exec root, `/run/verdikta-code-runner/exec`, when it stops.
A first enable that fails, and `disable`, unmount everything there once that daemon and its containerd have
stopped, and nothing outside it (never `/run/docker`, the arbiter's). Anything that stays is named, and
`disable` then exits 1. On a host where an earlier release left them, `disable` removes them.

`arbiter-doctor.sh` reports `svc.code_runner`, `sandbox.runsc`, `sandbox.disk`, `sandbox.conformance`,
`sandbox.trust` and `sandbox.registry`. `upgrade-arbiter.sh` holds the runner's maintenance lock while
it runs and refreshes the sandbox when a new release has no pass yet. If a refresh fails, claims abstain, the
arbiter keeps serving text requests, and the upgrade exits 3 saying what to run.

A disk image is never resized. For another size: `disable --purge`, then `enable --disk-gb N`.

If the lock was left behind (a killed upgrade), `/health` is 503 and the doctor names the file; remove it by hand.
