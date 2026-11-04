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
+4 GB of RAM while judging. It installs no package: if something is missing, it says what.

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

`arbiter-doctor.sh` reports `svc.code_runner`, `sandbox.runsc`, `sandbox.disk`, `sandbox.conformance`,
`sandbox.trust` and `sandbox.registry`. `upgrade-arbiter.sh` holds the runner's maintenance lock while
it runs and refreshes the sandbox when a new release has no pass yet. If a refresh fails, claims abstain, the
arbiter keeps serving text requests, and the upgrade exits 3 saying what to run.

A disk image is never resized. For another size: `disable --purge`, then `enable --disk-gb N`.

If the lock was left behind (a killed upgrade), `/health` is 503 and the doctor names the file; remove it by hand.
