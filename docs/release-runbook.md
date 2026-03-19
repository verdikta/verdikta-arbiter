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
| Automated verification passes | Proceed to tag |
| Tag pushed + CI green | Proceed to GitHub release |
| Docs site updated | Proceed to sign-off |
| Sign-off table complete | Release is official |
