# Testing the Automated Contract Deployment

This guide provides instructions for testing just the automated contract deployment script without running the full installation process.

## Prerequisites

Before testing, ensure you have:

1. Set up your environment with required tools:
   - Node.js and npm 
   - Git
   - Bash

2. Have access to:
   - A wallet with Base Sepolia ETH (get from [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-sepolia-faucet))
   - An Infura API key (for Base Sepolia access)

## Quick Test Setup

To quickly set up a minimal environment for testing the automated deployment script:

1. Clone the repository (if you haven't already):
   ```bash
   git clone https://github.com/your-org/verdikta-validator.git
   cd verdikta-validator
   ```

2. Create a minimal environment setup:
   ```bash
   mkdir -p /root/verdikta-validator/contracts
   
   # Create minimal API keys file
   echo 'INFURA_API_KEY="your-infura-api-key"' > installer/.api_keys
   
   # Create minimal .env file
   echo 'INSTALL_DIR="/root/verdikta-validator"' > installer/.env
   ```

3. Make the script executable:
   ```bash
   chmod +x installer/bin/deploy-contracts-automated.sh
   ```

## Test Execution

1. **Run the automated deployment script**:
   ```bash
   ./installer/bin/deploy-contracts-automated.sh
   ```

2. **Follow the prompts**:
   - Enter your private key when requested
   - Confirm deployment when asked

3. Since you're testing without the Chainlink node running, you can:
   - Either set up a Chainlink node first using `setup-chainlink.sh`
   - Or manually enter a valid ETH address at the node address prompt, and note that authorization will fail (which is expected)

## Verification

After running the script, check these files:

- `installer/.contracts` - Should contain the OPERATOR_ADDRESS
- `/root/verdikta-validator/contracts/operator-contract/build/contracts/MyOperator.json` - Should contain the deployment artifacts
- `/root/verdikta-validator/contracts/info/deployment.txt` - Should contain deployment information

## Expected Results

1. The script should:
   - Set up a Truffle project
   - Compile the contract successfully (no URL import errors)
   - Deploy the contract to Base Sepolia
   - Extract the contract address

2. If run without a Chainlink node, the authorization step should fail (which is expected in this isolated test)

## Troubleshooting

- If the script fails to compile, check the import statements in the contract
- If deployment fails, ensure you have enough Base Sepolia ETH
- If the script can't find required files, check your directory structure

## Cleanup

To clean up your test:
```bash
rm -rf /root/verdikta-validator/contracts/operator-contract
```

## Next Steps

After successful testing, you can:
1. Integrate this script into the full installation flow
2. Update documentation to reflect the new automated deployment option
3. Add this as an option in the main installer script 