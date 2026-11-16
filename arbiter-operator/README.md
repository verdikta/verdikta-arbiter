# Arbiter Operator

Solidity smart contract for the Chainlink Oracle Operator functionality.

## Solidity Version Compatibility

This project currently uses Solidity 0.8.19 for compatibility with the Chainlink contracts that are imported. The following compatibility issues prevent upgrading to Solidity 0.8.30 at this time:

1. The Chainlink contracts have pinned their pragma to exactly `0.8.19` (without a caret `^`), making them incompatible with newer Solidity versions.
2. Our ArbiterOperator contract inherits from the Chainlink Operator contract, which forces us to match the version.

### Future Upgrade Plan

When Chainlink updates their contracts to support Solidity 0.8.30, we can upgrade by:

1. Updating the pragma in ArbiterOperator.sol to `^0.8.30`
2. Updating the hardhat.config.js to use the 0.8.30 compiler

## Building and Deploying

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Deploy to network
./deploy.sh
```

## Scripts

- `deploy.sh`: Deploys the ArbiterOperator contract
- `test.sh`: Runs the test suite
- `setAuthorizedSenders.sh`: Sets the authorized senders for the operator contract 

## Foundry

ArbiterOperator also builds with Foundry, for stake listings: the listing site runs plain `forge build`
and `forge test` at the repository's root, with no network. Hardhat stays the build that deploys, and
nothing here changes it.

```bash
forge build && forge test     # at the repository root
```

- **`foundry.toml`** (the root): Hardhat's settings, solc 0.8.19, optimizer on with 200 runs, no viaIR,
  and EVM `paris` (Hardhat names no EVM version below solc 0.8.20, so solc's default for 0.8.19 applies).
  Remappings name the vendored files only. No FFI, no RPC endpoint, and one file permission: reading
  `foundry/lib`, for the hash test. The sources are `contracts/`; tests, libraries, output and cache are
  under `foundry/`, and `foundry/out` and `foundry/cache` are git-ignored.
- **`foundry/lib/`**: the dependencies, byte for byte from their releases. `vendored.json` records each
  file's SHA-256 and where it came from (the npm tarball's URL and integrity, or a git commit).

  | Directory | From | Files |
  |---|---|---|
  | `chainlink-contracts/` | `@chainlink/contracts` 1.4.0, npm tarball | the 13 files ArbiterOperator's imports reach; `LICENSE`, the repository's at its `contracts-v1.4.0` tag |
  | `openzeppelin-contracts/` | `@openzeppelin/contracts` 4.9.6, npm tarball | `utils/introspection/ERC165.sol`, `IERC165.sol`; `LICENSE`, the repository's at `v4.9.6` |
  | `forge-std/` | forge-std `v1.17.0` (git) | `src/`, `LICENSE-MIT`, `LICENSE-APACHE` |

  Neither tarball ships a license file. Chainlink's `package.json` says BUSL-1.1 for the package; each of
  the 13 files says `SPDX-License-Identifier: MIT`, the license its repository's `LICENSE` gives those
  portions. `package.json` allows `^1.4.0`, which is 1.4.0 or 1.5.0. 1.5.0 changes 11 of the 13 files, and
  its `Operator.sol` imports SafeCast as `@openzeppelin/contracts@4.8.3/…`, which Hardhat cannot resolve
  (HH411). It also asks for Node 22, so npm on Node 20, the installer's, resolves `^1.4.0` to 1.4.0.
- **`foundry/test/`**: the suite. `base/ArbiterOperatorBase.sol` is the base for tests and proofs of
  concept: it deploys a LINK token stand-in, the operator (owned by `owner`, with `node` its authorized
  sender) and a reputation keeper stand-in on its allow-list, plus a consumer the keeper approves.
  `_request()` sends a request through LINK's `transferAndCall` and `_fulfill()` answers it through
  `fulfillOracleRequestV`, with the job's response shape (`_response`). `VendoredFiles.t.sol` fails on any
  vendored file that is not the recorded bytes, and on any file `vendored.json` does not list.

A proof of concept is a test file in `arbiter-operator/foundry/test/` that inherits the base. It asserts
the property the bug breaks, so it fails with the bug in place (forge-std's `assertEq` reverts with a reason):

```solidity
import {ArbiterOperatorBase} from "./base/ArbiterOperatorBase.sol";

contract FindingTest is ArbiterOperatorBase {
    function test_finding() public {
        Request memory r = _request();
        // ... the steps that show the bug ...
        assertEq(operator.withdrawable(), 0, "the property the bug breaks");
    }
}
```

**The listing's fields** (`code_review.json`; every command is a plain forge command with allowed flags only):

```json
{
  "env": { "from": "foundry" },
  "commands": {
    "framework": "forge",
    "setup": "forge build",
    "build": "forge build",
    "test": "forge test",
    "testFiles": "forge test --match-path $FILES",
    "testIds": "forge test --match-test $TEST_IDS"
  },
  "paths": {
    "tests": ["arbiter-operator/foundry/test/**"],
    "protected": ["foundry.toml", "arbiter-operator/foundry/lib/**", "arbiter-operator/foundry/test/base/**", ".github/**", ".verdikta/**"]
  },
  "stake": { "scope": { "include": ["arbiter-operator/contracts/**"] } }
}
```

`commands.setup` runs only while the image is built, with network: its `forge build` installs solc 0.8.19
there. A proof adds files under `paths.tests` only, and the base and its stand-ins are protected, so every
proof runs on the same ones. The scope needs no exclude: it names `contracts/` only, not the vendored files.
The repository's proof for a listing is `.verdikta/stake-control.json`, naming the listing's maker.

**CI** (`.github/workflows/arbiter-operator-foundry.yml`) runs forge v1.8.5, the release the listings'
foundry base pins: `forge build` and `forge test` in a network namespace of their own, the vendored files
against `vendored.json` and against their tarballs and git commits
(`node foundry/ci/check-vendored-sources.js --upstream`), `npx hardhat compile` with the dependencies at
the vendored versions, and `node foundry/ci/compare-bytecode.js`, which fails unless the two runtime
bytecodes are identical but for solc's metadata trailer and both builds come from these sources and
settings. The job also shows the comparison failing: with 1000 optimizer runs the bytecode differs (exit 1);
with 201 it is the same, and the settings check fails (exit 2).

To update a dependency, replace its files, record their hashes and the new source in `vendored.json`, and
run `node foundry/ci/check-vendored-sources.js --upstream`, `forge test`, and the comparison.
