# Release Runbook

Step-by-step process for cutting a new release of **verdikta-arbiter**. Follow every section in order; do not skip steps even if they seem redundant — that's the point of a runbook.

## Prerequisites

- You are on the `main` branch with a clean working tree.
- You have push access to `origin`.
- CI is green on the latest commit.

## 1. Decide on a version

Pick the next version following [semver](https://semver.org/):

| Change type | Bump |
|---|---|
| Breaking contract ABI / config format | Major |
| New feature, new script, new provider | Minor |
| Bug fix, docs-only, dependency update | Patch |

```bash
VERSION="1.x.y"   # set your version here
```

## 2. Run the public-release checklist

Open [`docs/public-release-checklist.md`](public-release-checklist.md) and verify every P0 and P1 item is **Done**. If any are not, stop and resolve them first.

## 3. Automated verification

Run these from the repo root. Every command must pass cleanly.

```bash
# Required governance files
ls -1 README.md LICENSE .gitignore

# No tracked .env files
git ls-files | grep -E '(^|/)\.env$' && echo "FAIL: .env tracked" && exit 1 || echo "OK"

# Quick secret scan
git ls-files | xargs rg -n 'AKIA|ASIA|ghp_|github_pat_|sk-|PRIVATE_KEY=' \
  --glob '!**/.env.example' --glob '!**/package-lock.json' \
  && echo "FAIL: possible secret" && exit 1 || echo "OK"

# Arbiter-operator tests compile
cd arbiter-operator && npx hardhat compile && cd ..

# AI-node tests
cd ai-node && npm test -- --passWithNoTests && cd ..

# External-adapter tests
cd external-adapter && npm test -- --forceExit && cd ..
```

## 3b. Testnet canary gate (class 5555)

Backend arbiter changes — External Adapter, AI Node, Chainlink job specs,
`@verdikta/common` bumps — reach mainnet only after the same build has served a
real request on Base Sepolia. Class **5555** is reserved for this: ten arbiter
identities on the testnet VPS register it (they also serve 128), so a request
with `requestedClass = 5555` is answered only by nodes we control. Do not
register 5555 on mainnet or on nodes you do not upgrade first.

1. **Upgrade the canaries first.** On the testnet VPS, for every install
   directory (see [Unattended Installation and Upgrade](../installer/docs/installation/unattended.md)):

   ```bash
   cd ~/verdikta-arbiter && git pull
   ./installer/bin/upgrade-arbiter.sh --unattended --target-dir <install-dir>
   ```

   Then confirm each adapter reports the build you expect:

   ```bash
   curl -s http://localhost:<adapter-port>/version
   ```

   Run it on the arbiter host (over ssh). Once an install has closed its ports
   (`arbiter-firewall.sh`, see `installer/docs/maintenance/upgrading.md`), the
   adapter's port no longer answers from outside the host, so a remote
   `curl http://<host-ip>:8080/version` times out by design.

   `verdiktaCommon` is the installed `@verdikta/common`; `release` is the commit
   stamped by the upgrade. Also check the AI Node serves its production build:
   `<install-dir>/arbiter-status.sh` shows `Mode: production build (next start)`
   and `<install-dir>/arbiter-doctor.sh --quiet` prints no `svc.ai_node_mode`
   warning (a failed build falls back to `next dev`, which the canary request
   would not notice).

   Exit 3 means the upgrade finished but a job step did not, and the last lines
   say which. `JOB TIMEOUTS FAILED:` stops the release: a canary request finishes
   well inside the old 300 s, so it would not notice a job left at the old limits.
   Confirm each node with `<install-dir>/apply-job-timeouts.sh --check` (exit 0:
   every live job allows 840 s and the node runs `MaxRunDuration` 15 m). Replacing a
   stale job keeps its job id: no re-registration, no stake moves.

2. **Check the e2e wallet.** The L4 run pays `maxTotalFee` (≈ 0.0018 ETH) plus
   gas per scenario from the wallet whose key lives in the `e2e` GitHub
   Environment; its address is printed as `[l4] wallet=` by every run. Top it up
   from a Base Sepolia faucet when it is below ~0.005 ETH:

   ```bash
   cast balance <wallet> --rpc-url https://sepolia.base.org --ether
   ```

3. **Run the canary request** against class 5555 with the versions the
   arbiters must report:

   ```bash
   gh workflow run e2e.yml --ref main -f run_l4=true -f class_id=5555 \
     -f expect_common=<@verdikta/common version> -f expect_release=<release commit>
   gh run watch   # or: gh run list --workflow e2e.yml --limit 1
   ```

   Locally, with the key in your own shell only:

   ```bash
   cd e2e && node src/index.js l4 --class-id 5555 --expect-common <version> --expect-release <commit>
   ```

   Once the canaries serve code review, add the claim scenarios by name:

   ```bash
   gh workflow run e2e.yml --ref <branch> -f run_l4=true -f class_id=5555 \
     -f scenario=claim-l4-valid,claim-l4-front-gate,claim-l4-runner-gate \
     -f expect_common=<@verdikta/common version> -f expect_release=<release commit>
   ```

   They run on class 5555 and nothing else. L4 refuses them on any other class, with
   no `class_id`, or without both versions, before anything is sent, because nothing on
   an arbiter stops a claim on another class. They need a pinned claim set on that
   branch: [`e2e/README.md`](../e2e/README.md), "Claim scenarios (class 5555 only)".

   The canary conditions of design §11 (G2) take more than the flags: see
   [The canary conditions](#the-canary-conditions-11) below.

4. **Gate.** Green means: the request was fulfilled, every revealing arbiter's
   justification reports the expected `verdiktaCommon` and `release`, and the
   justification is fetchable. `cd e2e && npm run audit-oracles -- <aggId>`
   lists which identities were selected, committed and revealed, with each
   one's version. A red canary stops the release: fix on `main`, re-upgrade the
   canaries, re-run.

5. **Then upgrade mainnet** arbiters with the same upgrade command and confirm
   `GET /version` on each (on the host, as above). There is no mainnet e2e wallet, so the mainnet check
   is the per-node version endpoint plus the next real request's justification
   (`audit-oracles` works against mainnet with `--rpc` / `--aggregator`).

### The canary conditions (§11)

Before the network timeout changes, a cold-image canary on class 5555 must pass with a
near-limit juror, a provider timeout with retry, a slow justifier, a registry failure and a
cancellation. Four of those need the fault switch
([`external-adapter/README.md`](../external-adapter/README.md#the-canary-fault-switch)), which
acts only on a named claim, in a request for class 5555, measured on Base Sepolia. Each step here
changes a real host, so each is an operator's, by hand. No install or upgrade path does any of it.

1. **Prepare the claim set**, with a fresh digest for the cold-cache scenario:
   [`e2e/README.md`](../e2e/README.md), "Preparing them". It prints the plan.

2. **Arm every identity in class 5555.** Selection picks K of them, and one that is not armed
   answers first and fails `claim.faultSwitch`, so a partial arming is a failed run. On each
   install, with a key made for this run (`openssl rand -hex 32`, the same for its adapter and
   AI Node, kept out of git and of chat):

   ```bash
   # <install-dir>/external-adapter/.env
   VERDIKTA_CANARY_FAULTS=<the plan build-l4-claims.js printed>
   VERDIKTA_CANARY_FAULT_KEY=<the key>
   VERDIKTA_CANARY_RPC_URL=<a Base Sepolia RPC URL>
   NETWORK_CHAIN_ID=84532

   # <install-dir>/ai-node/.env.local
   VERDIKTA_CANARY_FAULT_KEY=<the same key>
   ```

   Restart (`<install-dir>/stop-arbiter.sh && <install-dir>/start-arbiter.sh`), then confirm, on
   the host:

   ```bash
   curl -s http://localhost:<adapter-port>/health | jq .canaryFault   # state "armed", namedClaims 4, problems []
   curl -s http://localhost:<ai-node-port>/api/health | jq .canary_fault   # state "armed"
   ```

   `refused` lists why in `problems`, and the switch then acts on nothing.

3. **Run the scenarios**, with `expect_fault_switch=armed`. The first set takes minutes; the
   cancellation watches for 15. Provider keys are spent, twice on a retry:

   ```bash
   gh workflow run e2e.yml --ref <branch> -f run_l4=true -f class_id=5555 -f expect_fault_switch=armed \
     -f scenario=claim-l4-cold-cache,claim-l4-time-dependent,claim-l4-randomness-dependent,claim-l4-flaky,claim-l4-near-limit-juror,claim-l4-provider-timeout,claim-l4-slow-justifier,claim-l4-dispute,claim-l4-registry-failure,claim-l4-cancellation \
     -f expect_common=<@verdikta/common version> -f expect_release=<release commit>
   ```

   The two abstention scenarios leave their rounds unfinalized and print the `cast send` that
   would finalize them. A finalize returns the prepay and applies −20 timeliness to each polled
   oracle (§12), on identities that also serve class 128 on this testnet: finalize deliberately.

4. **Disarm, and prove it.** Remove those lines from every `.env` and `.env.local` (keep
   `NETWORK_CHAIN_ID` if dev trust needs it) and restart. `upgrade-arbiter.sh` keeps a live `.env`,
   so an upgrade does not do this for you. Then run a claim with the default:

   ```bash
   gh workflow run e2e.yml --ref <branch> -f run_l4=true -f class_id=5555 \
     -f scenario=claim-l4-valid -f expect_common=<@verdikta/common version> -f expect_release=<release commit>
   ```

   `claim.faultSwitch` and `claim.aiNodeFaultSwitch` fail unless every recorded reveal says `off`.

5. **Read the metrics** over all the runs' `l4-report` artifacts, once there are enough:
   `cd e2e && node scripts/l4-metrics.js results/*.json`. It exits non-zero on too few samples
   (20 jury rounds for p95, 5 with three reveals for σ), and p95 from fewer runs does not exist.
   Repeat the plain scenarios until it can answer.

**A cold cache from an evicted digest (opt-in, off by default).** A fresh digest needs no change on
a host, and each one is cold once. To reuse a digest instead, an operator removes it from the
runner's own daemon on each canary, between runs and with nothing running. L4 never does this:

```bash
DOCKER_HOST=unix:///run/verdikta-code-runner/docker.sock docker image rm <repo@sha256:…>
```

## 4. Update deployment addresses

If any contracts were deployed since the last release:

1. Update `arbiter-operator/deployment-addresses.json`.
2. Update `docs/deployments.md`.
3. Commit both in one change.

## 5. Update version references

Update `version` fields in:

- `package.json` (root, if present)
- `ai-node/package.json`
- `external-adapter/package.json`
- `arbiter-operator/package.json`

Commit with message: `chore: bump version to $VERSION`

## 6. Tag the release

```bash
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin main --tags
```

## 7. Create GitHub release

```bash
gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "See [public-release-checklist](docs/public-release-checklist.md) for audit status." \
  --latest
```

## 8. Post-release verification

- Confirm the tag appears on GitHub.
- Confirm CI workflows pass on the tagged commit.
- Confirm [docs.verdikta.com](https://docs.verdikta.com/) reflects any doc changes (verdikta-docs submodule may need a bump).

## 9. Notify downstream

- Update the `verdikta-docs` submodule pointer to the new tag:

```bash
cd /path/to/verdikta-docs
git -C sources/arbiter fetch && git -C sources/arbiter checkout v$VERSION
git add sources/arbiter
git commit -m "chore: bump arbiter submodule to v$VERSION"
git push
```

- Post in the team channel that the release is live.

## 10. Sign-off

Fill in the sign-off table at the bottom of [`docs/public-release-checklist.md`](public-release-checklist.md) with approver names, dates, and status.

---

## Rollback

If a critical issue is found after tagging:

1. Do **not** delete the tag.
2. Fix on `main`, cut a patch release (`v$VERSION+1`).
3. Update the GitHub release notes to point to the patch.

---

## Checklist quick-reference

| Step | Gate |
|---|---|
| Public-release checklist all Done | Proceed to version bump |
| Automated verification passes | Proceed to the testnet canary |
| Class-5555 canary green with the expected versions | Proceed to mainnet upgrades and tag |
| Tag pushed + CI green | Proceed to GitHub release |
| Docs site updated | Proceed to sign-off |
| Sign-off table complete | Release is official |
