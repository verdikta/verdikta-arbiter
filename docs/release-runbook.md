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

   `verdiktaCommon` is the installed `@verdikta/common`; `release` is the commit
   stamped by the upgrade.

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

4. **Gate.** Green means: the request was fulfilled, every revealing arbiter's
   justification reports the expected `verdiktaCommon` and `release`, and the
   justification is fetchable. `cd e2e && npm run audit-oracles -- <aggId>`
   lists which identities were selected, committed and revealed, with each
   one's version. A red canary stops the release: fix on `main`, re-upgrade the
   canaries, re-run.

5. **Then upgrade mainnet** arbiters with the same upgrade command and confirm
   `GET /version` on each. There is no mainnet e2e wallet, so the mainnet check
   is the per-node version endpoint plus the next real request's justification
   (`audit-oracles` works against mainnet with `--rpc` / `--aggregator`).

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
