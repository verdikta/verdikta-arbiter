# Public Release Checklist

Use this checklist before making the repository public or announcing a major release.

## How to use

- Set each item `Status` to `Done` only when all acceptance criteria are met.
- Assign one clear owner per item.
- Link PRs/issues in the `Notes` column while work is in progress.
- Keep this document current and version it with release changes.

### Status values

- `Todo`
- `In Progress`
- `Blocked`
- `Done`

---

## P0 - Release Blockers

| ID | Task | Owner | Status | Acceptance Criteria | Notes |
|---|---|---|---|---|---|
| P0-1 | Add root `LICENSE` file | Maintainer | Done | `LICENSE` exists at repo root; license type matches root `README.md`; legal text is complete and unmodified from canonical template. | MIT LICENSE created at repo root. |
| P0-2 | Publish canonical deployment addresses doc | Smart Contract + DevOps | Done | New `docs/deployments.md` exists and lists Base Sepolia + Base Mainnet addresses for operator/client/aggregator; each address references source transaction or deployment run. | Created `docs/deployments.md`; README mainnet status updated from "Planned" to "Live". |
| P0-3 | Verify no secrets in repo history; confirm local-only key model | Security + DevOps | Done | Full git history scanned for private keys, API keys, and provider credentials; no real secrets found in tracked files or diffs; all credentials are user-supplied locally at install time via `install.sh`; no shared/org-managed secrets in repo or CI. | History scan confirmed: only truncated placeholders in `.env.example` and docs; one 64-char hex is a job UUID, not a key; `demo-client/readme` (removed) used `fb...8d` / `66..18` format examples. No rotation required. |
| P0-4 | Enable CI secret scanning gate | Platform/CI | Done | CI fails on new secret findings; scanner runs on PR and default branch; baseline configured and reviewed. | Added `.github/workflows/secret-scan.yml` (Gitleaks + tracked .env check). |

---

## P1 - High Priority

| ID | Task | Owner | Status | Acceptance Criteria | Notes |
|---|---|---|---|---|---|
| P1-1 | Harden private key handling in scripts/logs | Installer + DevOps | Todo | No script prints raw private keys; sensitive values are masked in console and logs; manual test confirms no secret leakage in standard install/deploy paths. | |
| P1-2 | Fix `arbiter-operator` test command | Smart Contract Team | Done | `arbiter-operator/package.json` test script runs real tests (not placeholder); CI or local run confirms tests execute successfully. | Changed script from placeholder `echo` to `npx hardhat test`. |
| P1-3 | Add repository policy checks in CI | Platform/CI | Done | CI enforces presence of required governance files (license, readme), blocks tracked `.env` files, and reports actionable failures. | Added `.github/workflows/repo-policy.yml` (required files + license consistency). |

---

## P2 - Documentation and Public Readiness

| ID | Task | Owner | Status | Acceptance Criteria | Notes |
|---|---|---|---|---|---|
| P2-1 | Resolve public placeholder content | Docs | Done | Public docs no longer include unresolved placeholders such as `Issue #XXX`, `TBD_UPLOAD_REQUIRED`, or unqualified temporary values. | Removed `Issue #XXX` refs from hyperbolic doc; removed `TBD` refs from work-product test plan; updated mainnet "Coming Soon" references. |
| P2-2 | Add missing component-level READMEs | Component Owners | Done | `chainlink-node`, `docs`, and `installer` have clear entrypoint documentation or explicit links to canonical docs. | Created `chainlink-node/README.md`, `installer/README.md`, `docs/README.md`. |
| P2-3 | Define and apply NatSpec minimum standard | Smart Contract Team | Done | NatSpec policy documented; production contracts/interfaces meet standard; exclusions are documented for test fixtures. | Created `docs/development/natspec-policy.md` with scope, requirements, and current compliance table. |

---

## P3 - Maintenance Quality

| ID | Task | Owner | Status | Acceptance Criteria | Notes |
|---|---|---|---|---|---|
| P3-1 | Separate generated assets from review-critical source | Docs + Build Tooling | Todo | Generated/minified assets are clearly scoped and excluded from manual review expectations where appropriate. | |
| P3-2 | Create repeatable pre-release process | Maintainers | Todo | A release runbook links this checklist and defines owner sign-off before release tag/public announcement. | |

---

## Sign-off

| Area | Approver | Status | Date | Notes |
|---|---|---|---|---|
| Security |  | Pending |  |  |
| Smart Contracts |  | Pending |  |  |
| DevOps/Infra |  | Pending |  |  |
| Documentation |  | Pending |  |  |
| Project Maintainer |  | Pending |  |  |

---

## Optional verification commands

Run these before final sign-off:

```bash
# Verify tracked env-like files
git ls-files | rg '(^|/)\.env(\.|$|example)'

# Quick pattern scan for obvious secrets
git ls-files | xargs rg -n 'AKIA|ASIA|ghp_|github_pat_|sk-|PRIVATE_KEY=|mnemonic|seed phrase'

# Ensure required top-level files are present
ls -1 README.md LICENSE .gitignore
```
