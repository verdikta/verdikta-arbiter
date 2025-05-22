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