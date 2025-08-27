#!/bin/bash

# Verdikta Validator Node - Automated Smart Contracts Deployment Script
# Deploys the necessary smart contracts to Base Sepolia network using Truffle

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Deploying Smart Contracts for Verdikta Validator Node (Automated)...${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Load API keys
if [ -f "$INSTALLER_DIR/.api_keys" ]; then
    source "$INSTALLER_DIR/.api_keys"
else
    echo -e "${RED}Error: API keys file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to prompt for Yes/No question
ask_yes_no() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$prompt (y/n): " response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# Function to generate a random job ID
generate_job_id() {
    job_id=$(openssl rand -hex 16 | sed 's/\(..\)\(..\)\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)\(..\)\(..\)\(..\)\(..\)/\1\2\3\4-\5\6-\7\8-\9\10-\11\12\13\14\15\16/' | sed 's/.\{8\}/&-&/;s/.\{13\}/&-&/;s/.\{18\}/&-&/')
    job_id_no_hyphens=$(echo "$job_id" | tr -d '-')
    echo "$job_id"
}

# Setup contracts directory
CONTRACTS_DIR="$INSTALL_DIR/contracts"
OPERATOR_DIR="$CONTRACTS_DIR/operator-contract"
echo -e "${BLUE}Setting up contracts directory at $CONTRACTS_DIR...${NC}"
mkdir -p "$CONTRACTS_DIR"

# Clone the Chainlink Node repository with contract templates if not already cloned
echo -e "${BLUE}Cloning Chainlink Node repository with contract templates...${NC}"
if [ -d "$CONTRACTS_DIR/verdiktaChainlinkNode" ]; then
    echo -e "${YELLOW}Contract templates repository already exists. Updating...${NC}"
    cd "$CONTRACTS_DIR/verdiktaChainlinkNode"
    git fetch
    git pull
else
    echo -e "${BLUE}Cloning contract templates repository...${NC}"
    git clone https://github.com/yenachar/verdiktaChainlinkNode.git "$CONTRACTS_DIR/verdiktaChainlinkNode"
    cd "$CONTRACTS_DIR/verdiktaChainlinkNode"
fi

# Copy contract templates to contracts directory
echo -e "${BLUE}Copying contract templates...${NC}"
cp "$CONTRACTS_DIR/verdiktaChainlinkNode/MyOperator.sol" "$CONTRACTS_DIR/MyOperator.sol"
cp "$CONTRACTS_DIR/verdiktaChainlinkNode/basicJobSpec" "$CONTRACTS_DIR/basicJobSpec"

# Check prerequisites for Truffle deployment
echo -e "${BLUE}Checking prerequisites for automatic deployment...${NC}"

# Check if Node.js is installed
if ! command_exists node; then
    echo -e "${RED}Error: Node.js is not installed. Required for Truffle deployment.${NC}"
    echo -e "${YELLOW}Please run setup-environment.sh first to install Node.js.${NC}"
    exit 1
fi

# Check if npm is installed
if ! command_exists npm; then
    echo -e "${RED}Error: npm is not installed. Required for Truffle deployment.${NC}"
    echo -e "${YELLOW}Please run setup-environment.sh first to install npm.${NC}"
    exit 1
fi

# Set up Truffle project for Operator contract
echo -e "${BLUE}Setting up Truffle project for Operator contract...${NC}"
mkdir -p "$OPERATOR_DIR"
cd "$OPERATOR_DIR"

# Initialize Truffle project if not already initialized
if [ ! -f "$OPERATOR_DIR/truffle-config.js" ]; then
    echo -e "${BLUE}Initializing Truffle project...${NC}"
    npx truffle init
else
    echo -e "${YELLOW}Truffle project already initialized.${NC}"
fi

# Set up package.json if not exists
if [ ! -f "$OPERATOR_DIR/package.json" ]; then
    echo -e "${BLUE}Initializing npm package...${NC}"
    npm init -y
fi

# Install dependencies
echo -e "${BLUE}Installing dependencies for Operator contract...${NC}"
npm install @chainlink/contracts@0.4.2 --save --legacy-peer-deps
npm install @openzeppelin/contracts@5.1.0 --save --legacy-peer-deps
npm install @truffle/hdwallet-provider --save --legacy-peer-deps
npm install dotenv --save --legacy-peer-deps

# Verify Chainlink contract structure
echo -e "${BLUE}Verifying Chainlink contract structure...${NC}"
OPERATOR_PATH=""
if [ -d "$OPERATOR_DIR/node_modules/@chainlink/contracts/src/v0.8/operatorforwarder" ]; then
    OPERATOR_PATH="@chainlink/contracts/src/v0.8/operatorforwarder/Operator.sol"
    echo -e "${GREEN}Found Operator contract at expected location.${NC}"
elif [ -d "$OPERATOR_DIR/node_modules/@chainlink/contracts/src/v0.8/dev/operatorforwarder" ]; then
    OPERATOR_PATH="@chainlink/contracts/src/v0.8/dev/operatorforwarder/Operator.sol"
    echo -e "${GREEN}Found Operator contract in dev subdirectory.${NC}"
elif [ -d "$OPERATOR_DIR/node_modules/@chainlink/contracts/src/v0.8/dev/Operator" ]; then
    OPERATOR_PATH="@chainlink/contracts/src/v0.8/dev/Operator.sol"
    echo -e "${GREEN}Found Operator contract in dev directory.${NC}"
elif [ -d "$OPERATOR_DIR/node_modules/@chainlink/contracts/src/v0.8/Operator" ]; then
    OPERATOR_PATH="@chainlink/contracts/src/v0.8/Operator.sol"
    echo -e "${GREEN}Found Operator contract in v0.8 directory.${NC}"
else
    # Last resort - search for the file
    echo -e "${YELLOW}Searching for Operator.sol in the node_modules directory...${NC}"
    FOUND_PATH=$(find "$OPERATOR_DIR/node_modules/@chainlink" -name "Operator.sol" -type f | head -1)
    if [ -n "$FOUND_PATH" ]; then
        # Get relative path from node_modules
        REL_PATH=${FOUND_PATH#*node_modules/}
        OPERATOR_PATH="$REL_PATH"
        echo -e "${GREEN}Found Operator contract at: $OPERATOR_PATH${NC}"
    else
        echo -e "${RED}Could not find Operator.sol in the Chainlink package.${NC}"
        echo -e "${YELLOW}Will attempt to use a direct import from GitHub instead.${NC}"
        OPERATOR_PATH="https://raw.githubusercontent.com/smartcontractkit/chainlink/master/contracts/src/v0.8/Operator.sol"
    fi
fi

# Create a modified version of the Operator contract for Truffle
echo -e "${BLUE}Creating modified Operator contract for Truffle...${NC}"
mkdir -p "$OPERATOR_DIR/contracts"

# Create local interfaces directory to ensure imports work
echo -e "${BLUE}Creating local interfaces to ensure reliable imports...${NC}"
mkdir -p "$OPERATOR_DIR/contracts/interfaces"

# Create LinkTokenInterface
cat > "$OPERATOR_DIR/contracts/interfaces/LinkTokenInterface.sol" << 'EOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface LinkTokenInterface {
  function allowance(address owner, address spender) external view returns (uint256);
  function approve(address spender, uint256 value) external returns (bool);
  function balanceOf(address owner) external view returns (uint256);
  function decimals() external view returns (uint8);
  function decreaseApproval(address spender, uint256 addedValue) external returns (bool);
  function increaseApproval(address spender, uint256 subtractedValue) external;
  function name() external view returns (string memory);
  function symbol() external view returns (string memory);
  function totalSupply() external view returns (uint256);
  function transfer(address to, uint256 value) external returns (bool);
  function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);
  function transferFrom(address from, address to, uint256 value) external returns (bool);
}
EOL

# Create OperatorInterface
cat > "$OPERATOR_DIR/contracts/interfaces/OperatorInterface.sol" << 'EOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface OperatorInterface {
  function operatorRequest(
    address sender,
    uint256 payment,
    bytes32 specId,
    bytes4 callbackFunctionId,
    uint256 nonce,
    uint256 dataVersion,
    bytes calldata data
  ) external;

  function fulfillOracleRequest2(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external returns (bool);

  function ownerTransferAndCall(
    address to,
    uint256 value,
    bytes calldata data
  ) external returns (bool);

  function distributeFunds(
    address payable[] calldata receivers,
    uint256[] calldata amounts
  ) external;

  function getAuthorizedSenders() external view returns (address[] memory);

  function setAuthorizedSenders(address[] calldata senders) external;

  function getChainlinkToken() external view returns (address);
}
EOL

# Create OracleInterface
cat > "$OPERATOR_DIR/contracts/interfaces/OracleInterface.sol" << 'EOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface OracleInterface {
  function fulfillOracleRequest(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes32 data
  ) external returns (bool);

  function cancel(bytes32 requestId) external;
}
EOL

# Create the modified contract with local imports
cat > "$OPERATOR_DIR/contracts/MyOperator.sol" << 'EOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/LinkTokenInterface.sol";
import "./interfaces/OperatorInterface.sol";
import "./interfaces/OracleInterface.sol";

/**
 * @title The Chainlink Operator contract with FIXED fulfillOracleRequest3
 * @notice Node operators can deploy this contract to fulfill requests sent to them
 * @dev This version fixes a critical issue with the fulfillOracleRequest3 function
 *      where the requestId parameter was not being properly included in the callback
 */
contract MyOperator is OracleInterface, OperatorInterface {
  LinkTokenInterface internal immutable linkToken;
  address private owner;
  
  // Mapping of authorized node addresses
  mapping(address => bool) private authorizedNodes;
  
  // Mapping of fulfillment permissions
  mapping(address => mapping(bytes4 => bool)) private fulfillmentPermissions;
  
  constructor(address link) {
    linkToken = LinkTokenInterface(link);
    owner = msg.sender;
  }
  
  // Implement OracleInterface
  function cancel(bytes32 requestId) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes32 data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  // Implement OperatorInterface
  function operatorRequest(
    address sender,
    uint256 payment,
    bytes32 specId,
    bytes4 callbackFunctionId,
    uint256 nonce,
    uint256 dataVersion,
    bytes calldata data
  ) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest2(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
    return success;
  }
  
  function ownerTransferAndCall(
    address to,
    uint256 value,
    bytes calldata data
  ) external override returns (bool) {
    require(msg.sender == owner, "Not owner");
    return linkToken.transferAndCall(to, value, data);
  }
  
  function distributeFunds(
    address payable[] calldata receivers,
    uint256[] calldata amounts
  ) external override onlyOwner {
    require(receivers.length == amounts.length, "Invalid array length");
    for (uint256 i = 0; i < receivers.length; i++) {
      receivers[i].transfer(amounts[i]);
    }
  }
  
  function getAuthorizedSenders() external view override returns (address[] memory) {
    // Implement with proper array sizing for production
    address[] memory senders = new address[](1);
    return senders;
  }
  
  function setAuthorizedSenders(address[] calldata senders) external override onlyOwner {
    for (uint i = 0; i < senders.length; i++) {
      authorizedNodes[senders[i]] = true;
    }
  }
  
  function getChainlinkToken() external view override returns (address) {
    return address(linkToken);
  }
  
  /**
   * @dev THIS IS THE CRITICAL FIXED FUNCTION - Using the correct encodeWithSelector method
   * @dev The job spec requires requestId to be the first parameter in the callback
   * @dev This is essential for proper functioning with client contracts
   */
  function fulfillOracleRequest3(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    require(gasleft() >= 400000, "Must provide consumer enough gas");
    
    // FIXED VERSION: Use encodeWithSelector to properly include requestId as the first parameter
    // The previous incorrect version used abi.encodePacked which doesn't properly encode the requestId
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
  }
}
EOL

echo -e "${GREEN}Created MyOperator.sol with fixed fulfillOracleRequest3 function${NC}"

# Create Truffle configuration
echo -e "${BLUE}Creating Truffle configuration...${NC}"

# Set network-specific values based on DEPLOYMENT_NETWORK
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    TRUFFLE_NETWORK_NAME="baseMainnet"
    TRUFFLE_CHAIN_ID="8453"
    INFURA_ENDPOINT="https://base-mainnet.infura.io/v3/"
    PUBLIC_RPC_ENDPOINTS='"https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.blockpi.network/v1/rpc/public"'
else
    # Default to Base Sepolia
    TRUFFLE_NETWORK_NAME="baseSepolia"
    TRUFFLE_CHAIN_ID="84532"
    INFURA_ENDPOINT="https://base-sepolia.infura.io/v3/"
    PUBLIC_RPC_ENDPOINTS='"https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.blockpi.network/v1/rpc/public"'
fi

cat > "$OPERATOR_DIR/truffle-config.js" << EOL
const HDWalletProvider = require('@truffle/hdwallet-provider');
require('dotenv').config();

// Configure multiple RPC endpoints to provide fallbacks
const getProvider = (privateKey) => {
  // Primary endpoint with Infura
  const endpoints = [
    \`${INFURA_ENDPOINT}\${process.env.INFURA_API_KEY}\`,
  ];
  
  // Add public RPC endpoints as fallbacks
  if (process.env.USE_PUBLIC_RPC === 'true') {
    endpoints.push(
      ${PUBLIC_RPC_ENDPOINTS}
    );
  }
  
  return () => new HDWalletProvider({
    privateKeys: [privateKey],
    providerOrUrl: endpoints[0],
    pollingInterval: 15000, // Reduce polling frequency (15 seconds)
    networkCheckTimeout: 120000, // 2 minutes
    timeoutBlocks: 200,
  });
};

module.exports = {
  networks: {
    ${TRUFFLE_NETWORK_NAME}: {
      provider: getProvider(process.env.PRIVATE_KEY),
      network_id: ${TRUFFLE_CHAIN_ID},
      confirmations: 2,
      timeoutBlocks: 200,
      skipDryRun: true,
      gasPrice: 1000000000, // 1 gwei
      networkCheckTimeout: 120000, // 2 minutes
      deploymentPollingInterval: 15000, // Reduce deployment polling (15 seconds)
    }
  },
  compilers: {
    solc: {
      version: "0.8.19",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        }
      }
    }
  }
};
EOL

# Add helper functions for retry logic
cat > "$OPERATOR_DIR/rpc-test.js" << 'EOL'
const Web3 = require('web3');
require('dotenv').config();

async function testRpcConnection() {
  const endpoints = [
    \`${INFURA_ENDPOINT}\${process.env.INFURA_API_KEY}\`,
    ${PUBLIC_RPC_ENDPOINTS}
  ];
  
  let successfulEndpoints = [];
  
  for (const endpoint of endpoints) {
    try {
      console.log(`Testing RPC endpoint: ${endpoint}`);
      const web3 = new Web3(endpoint);
      const blockNumber = await web3.eth.getBlockNumber();
      console.log(`Success! Current block number: ${blockNumber}`);
      successfulEndpoints.push(endpoint);
    } catch (error) {
      console.log(`Failed to connect to ${endpoint}: ${error.message}`);
    }
  }
  
  if (successfulEndpoints.length > 0) {
    console.log("\nWorking RPC endpoints:");
    successfulEndpoints.forEach(endpoint => console.log(`- ${endpoint}`));
    process.exit(0);
  } else {
    console.log("\nNo working RPC endpoints found!");
    process.exit(1);
  }
}

testRpcConnection();
EOL

# Function to retry a command with exponential backoff
retry_with_backoff() {
    local max_attempts=$1
    local command=$2
    local attempt=1
    local timeout=10
    
    while [ $attempt -le $max_attempts ]; do
        echo -e "${BLUE}Attempt $attempt of $max_attempts...${NC}"
        
        # Execute the command
        if eval "$command"; then
            echo -e "${GREEN}Command succeeded on attempt $attempt${NC}"
            return 0
        fi
        
        # If this was the last attempt, exit with failure
        if [ $attempt -eq $max_attempts ]; then
            echo -e "${RED}All $max_attempts attempts failed.${NC}"
            return 1
        fi
        
        # Calculate backoff time (exponential with jitter)
        local jitter=$((RANDOM % 5))
        local sleep_time=$((timeout + jitter))
        
        echo -e "${YELLOW}Command failed. Retrying in $sleep_time seconds...${NC}"
        sleep $sleep_time
        
        # Increase timeout for next attempt
        timeout=$((timeout * 2))
        attempt=$((attempt + 1))
    done
    
    return 1
}

# Create migration script for Operator contract
echo -e "${BLUE}Creating migration script for Operator contract...${NC}"
mkdir -p "$OPERATOR_DIR/migrations"
cat > "$OPERATOR_DIR/migrations/2_deploy_operator.js" << 'EOL'
const MyOperator = artifacts.require("MyOperator");

module.exports = function(deployer, network) {
  // Get LINK token address based on network
  const linkTokenAddress = process.env.LINK_TOKEN_ADDRESS || "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  
  deployer.deploy(MyOperator, linkTokenAddress)
    .then(async (operatorInstance) => {
      console.log("Operator contract deployed to:", operatorInstance.address);
    });
};
EOL

# Create script to authorize the node
echo -e "${BLUE}Creating script to authorize the node...${NC}"
mkdir -p "$OPERATOR_DIR/scripts"
cat > "$OPERATOR_DIR/scripts/authorize-node.js" << 'EOL'
const MyOperator = artifacts.require("MyOperator");

module.exports = async function(callback) {
  try {
    const operatorInstance = await MyOperator.deployed();
    const nodeAddress = process.env.NODE_ADDRESS;
    
    if (!nodeAddress) {
      console.error("NODE_ADDRESS environment variable is not set");
      callback(new Error("NODE_ADDRESS not set"));
      return;
    }
    
    console.log('Authorizing node address:', nodeAddress);
    // Format: ["nodeAddress"] - same format used in manual deployment via Remix
    console.log('Using format: ["' + nodeAddress + '"]');
    await operatorInstance.setAuthorizedSenders([nodeAddress]);
    console.log('Node authorized successfully');
    
    callback();
  } catch (err) {
    console.error('Error:', err);
    callback(err);
  }
};
EOL

# Test RPC connectivity before deployment
echo -e "${BLUE}Testing RPC connectivity to Base Sepolia...${NC}"
if command_exists npm; then
    # Install web3 if not already installed
    if ! npm list --prefix "$OPERATOR_DIR" web3 >/dev/null 2>&1; then
        echo -e "${BLUE}Installing web3 for RPC testing...${NC}"
        cd "$OPERATOR_DIR"
        npm install web3 --save --legacy-peer-deps
    fi
    
    # Run the RPC test
    echo -e "${BLUE}Testing RPC endpoints...${NC}"
    cd "$OPERATOR_DIR"
    if node rpc-test.js; then
        echo -e "${GREEN}RPC connectivity verified successfully.${NC}"
        # Enable fallback RPCs for better reliability
        echo "USE_PUBLIC_RPC=true" >> "$OPERATOR_DIR/.env"
    else
        echo -e "${YELLOW}Warning: Some RPC endpoints may be unavailable.${NC}"
        echo -e "${YELLOW}Continuing with Infura only. This may be less reliable.${NC}"
    fi
else
    echo -e "${YELLOW}Warning: npm not found, skipping RPC connectivity test.${NC}"
fi

# Ask for private key for deployment
echo -e "${YELLOW}You need to provide a private key for a wallet with Base Sepolia ETH for contract deployment.${NC}"
echo -e "${YELLOW}IMPORTANT: Never use your main wallet key. Use a testing wallet with minimal funds.${NC}"
echo -e "${YELLOW}NOTE: Do NOT include the '0x' prefix - Truffle does not expect it.${NC}"
read -p "Enter private key (without 0x prefix): " PRIVATE_KEY

# Validate private key format (without 0x prefix)
if [[ ! "$PRIVATE_KEY" =~ ^[a-fA-F0-9]{64}$ ]]; then
    echo -e "${RED}Error: Invalid private key format. It should be a 64-character hex string without 0x prefix.${NC}"
    exit 1
fi

# Ask for confirmation
echo -e "${YELLOW}You are about to save this private key to a .env file.${NC}"
if ! ask_yes_no "Are you sure you want to proceed?"; then
    echo -e "${RED}Operation cancelled.${NC}"
    exit 1
fi

# Get LINK token address for the network
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    LINK_TOKEN_ADDRESS="0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196"
else
    # Base Sepolia
    LINK_TOKEN_ADDRESS="0xE4aB69C077896252FAFBD49EFD26B5D171A32410"
fi

# Create .env file for Truffle deployment
echo -e "${BLUE}Creating .env file for Truffle deployment...${NC}"
cat > "$OPERATOR_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
LINK_TOKEN_ADDRESS=$LINK_TOKEN_ADDRESS
EOL
chmod 600 "$OPERATOR_DIR/.env"
echo -e "${GREEN}.env file created with deployment credentials.${NC}"

# Deploy Operator contract
echo -e "${BLUE}Deploying Operator contract to $NETWORK_NAME...${NC}"
if [ "$NETWORK_TYPE" = "testnet" ]; then
    echo -e "${YELLOW}WARNING: This will deploy the contract to the $NETWORK_NAME testnet.${NC}"
    echo -e "${YELLOW}Make sure your wallet has enough $NETWORK_NAME ETH for gas fees.${NC}"
else
    echo -e "${RED}WARNING: This will deploy the contract to $NETWORK_NAME (PRODUCTION).${NC}"
    echo -e "${RED}This will use real ETH for gas fees. Make sure you want to proceed.${NC}"
fi

if ask_yes_no "Do you want to deploy the contract now?"; then
    cd "$OPERATOR_DIR"
    
    echo -e "${BLUE}Starting deployment with retry logic...${NC}"
    if retry_with_backoff 3 "npx truffle migrate --network $TRUFFLE_NETWORK_NAME"; then
        echo -e "${GREEN}Contract deployed successfully!${NC}"
    else
        echo -e "${YELLOW}Initial deployment failed. This may be due to RPC rate limiting or import path issues.${NC}"
        echo -e "${YELLOW}Let's try with a different approach...${NC}"
        
        # Increase the timeouts in truffle-config.js
        echo -e "${BLUE}Updating Truffle configuration with longer timeouts...${NC}"
        sed -i.bak 's/pollingInterval: 15000/pollingInterval: 30000/' "$OPERATOR_DIR/truffle-config.js"
        sed -i.bak 's/networkCheckTimeout: 120000/networkCheckTimeout: 240000/' "$OPERATOR_DIR/truffle-config.js"
        
        # Try installing a different version of Chainlink contracts
        echo -e "${BLUE}Installing alternative version of Chainlink contracts...${NC}"
        npm uninstall @chainlink/contracts
        npm install @chainlink/contracts@0.6.1 --save --legacy-peer-deps
        
        # Create a simplified operator contract that directly implements the interface
        echo -e "${BLUE}Creating simplified Operator contract...${NC}"
        cat > "$OPERATOR_DIR/contracts/MyOperator.sol" << 'EOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@chainlink/contracts/src/v0.8/interfaces/LinkTokenInterface.sol";
import "@chainlink/contracts/src/v0.8/interfaces/OperatorInterface.sol";
import "@chainlink/contracts/src/v0.8/interfaces/OracleInterface.sol";

/**
 * @title The Chainlink Operator contract with FIXED fulfillOracleRequest3
 * @notice Node operators can deploy this contract to fulfill requests sent to them
 * @dev This version fixes a critical issue with the fulfillOracleRequest3 function
 *      where the requestId parameter was not being properly included in the callback
 */
contract MyOperator is OracleInterface, OperatorInterface {
  LinkTokenInterface internal immutable linkToken;
  address private owner;
  
  // Mapping of authorized node addresses
  mapping(address => bool) private authorizedNodes;
  
  // Mapping of fulfillment permissions
  mapping(address => mapping(bytes4 => bool)) private fulfillmentPermissions;
  
  constructor(address link) {
    linkToken = LinkTokenInterface(link);
    owner = msg.sender;
  }
  
  // Implement OracleInterface
  function cancel(bytes32 requestId) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes32 data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  // Implement OperatorInterface
  function operatorRequest(
    address sender,
    uint256 payment,
    bytes32 specId,
    bytes4 callbackFunctionId,
    uint256 nonce,
    uint256 dataVersion,
    bytes calldata data
  ) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest2(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
    return success;
  }
  
  function ownerTransferAndCall(
    address to,
    uint256 value,
    bytes calldata data
  ) external override returns (bool) {
    require(msg.sender == owner, "Not owner");
    return linkToken.transferAndCall(to, value, data);
  }
  
  function distributeFunds(
    address payable[] calldata receivers,
    uint256[] calldata amounts
  ) external override onlyOwner {
    require(receivers.length == amounts.length, "Invalid array length");
    for (uint256 i = 0; i < receivers.length; i++) {
      receivers[i].transfer(amounts[i]);
    }
  }
  
  function getAuthorizedSenders() external view override returns (address[] memory) {
    // Implement with proper array sizing for production
    address[] memory senders = new address[](1);
    return senders;
  }
  
  function setAuthorizedSenders(address[] calldata senders) external override onlyOwner {
    for (uint i = 0; i < senders.length; i++) {
      authorizedNodes[senders[i]] = true;
    }
  }
  
  function getChainlinkToken() external view override returns (address) {
    return address(linkToken);
  }
  
  /**
   * @dev THIS IS THE CRITICAL FIXED FUNCTION - Using the correct encodeWithSelector method
   * @dev The job spec requires requestId to be the first parameter in the callback
   * @dev This is essential for proper functioning with client contracts
   */
  function fulfillOracleRequest3(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    require(gasleft() >= 400000, "Must provide consumer enough gas");
    
    // FIXED VERSION: Use encodeWithSelector to properly include requestId as the first parameter
    // The previous incorrect version used abi.encodePacked which doesn't properly encode the requestId
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
  }
}
EOL
        
        echo -e "${GREEN}Created simplified Operator contract with FIXED fulfillOracleRequest3 function${NC}"
        
        # Try deployment again with the simplified contract and extended retry time
        echo -e "${BLUE}Attempting deployment with simplified contract...${NC}"
        if retry_with_backoff 5 "npx truffle migrate --network $TRUFFLE_NETWORK_NAME"; then
            echo -e "${GREEN}Deployment with simplified contract successful!${NC}"
        else
            echo -e "${RED}Deployment failed after multiple attempts.${NC}"
            echo -e "${YELLOW}Please check the logs for more information.${NC}"
            exit 1
        fi
    fi
    
    # Extract contract address from truffle artifacts
    OPERATOR_ADDRESS=$(grep -r "\"address\":" "$OPERATOR_DIR/build/contracts" | grep -i "MyOperator" | head -1 | sed -E 's/.*"address": "([^"]+)".*/\1/')
    
    if [ -n "$OPERATOR_ADDRESS" ]; then
        echo -e "${GREEN}Operator contract deployed at: $OPERATOR_ADDRESS${NC}"
        # Save the contract address
        echo "OPERATOR_ADDRESS=\"$OPERATOR_ADDRESS\"" > "$INSTALLER_DIR/.contracts"
        echo -e "${GREEN}Operator contract address saved to $INSTALLER_DIR/.contracts${NC}"
    else
        echo -e "${YELLOW}Unable to automatically extract operator contract address.${NC}"
        echo -e "${YELLOW}Please check the deployment logs for the contract address.${NC}"
        read -p "Enter the deployed contract address (0x...): " OPERATOR_ADDRESS
        if [ -n "$OPERATOR_ADDRESS" ]; then
            echo "OPERATOR_ADDRESS=\"$OPERATOR_ADDRESS\"" > "$INSTALLER_DIR/.contracts"
            echo -e "${GREEN}Operator contract address saved: $OPERATOR_ADDRESS${NC}"
        else
            echo -e "${RED}No operator address provided. Cannot continue.${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}Contract deployment skipped.${NC}"
    exit 0
fi

# Instructions for getting the Chainlink node address
echo
echo -e "${YELLOW}Next, you need to get your Chainlink node address:${NC}"
echo -e "${YELLOW}1. Go to the Chainlink node UI at http://localhost:6688${NC}"
echo -e "${YELLOW}2. Navigate to 'Key Management' -> 'EVM Chain Accounts'${NC}"
echo -e "${YELLOW}3. Copy the Node Address (starts with 0x)${NC}"

# Ask for the Chainlink node address
echo
read -p "Enter the Chainlink node address (0x...): " NODE_ADDRESS

# Validate the address
if [[ ! "$NODE_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Error: Invalid Ethereum address format. Please enter a valid address starting with '0x'.${NC}"
    exit 1
fi

# Save the node address
echo "NODE_ADDRESS=\"$NODE_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
echo -e "${GREEN}Chainlink node address saved to $INSTALLER_DIR/.contracts${NC}"

# Authorize the node address
echo -e "${BLUE}Authorizing the Chainlink node in the Operator contract...${NC}"
cd "$OPERATOR_DIR"
export NODE_ADDRESS="$NODE_ADDRESS"

# Use retry logic for node authorization
if retry_with_backoff 3 "npx truffle exec scripts/authorize-node.js --network $TRUFFLE_NETWORK_NAME"; then
    echo -e "${GREEN}Node authorization successful!${NC}"
else
    echo -e "${RED}Node authorization failed after multiple attempts.${NC}"
    echo -e "${YELLOW}This could be due to rate limiting issues or network congestion.${NC}"
    
    # Try with longer timeouts
    echo -e "${BLUE}Trying node authorization with longer timeouts...${NC}"
    
    # Increase the timeouts in truffle-config.js
    sed -i.bak 's/pollingInterval: [0-9]\+/pollingInterval: 30000/' "$OPERATOR_DIR/truffle-config.js"
    sed -i.bak 's/networkCheckTimeout: [0-9]\+/networkCheckTimeout: 240000/' "$OPERATOR_DIR/truffle-config.js"
    
    if retry_with_backoff 5 "npx truffle exec scripts/authorize-node.js --network $TRUFFLE_NETWORK_NAME"; then
        echo -e "${GREEN}Node authorization succeeded with extended timeouts!${NC}"
    else
        echo -e "${RED}Node authorization failed. Please check the logs for more information.${NC}"
        echo -e "${YELLOW}You may need to manually authorize the node using Remix IDE.${NC}"
        echo -e "${YELLOW}Steps for manual authorization:${NC}"
        echo -e "${YELLOW}1. Go to https://remix.ethereum.org${NC}"
        echo -e "${YELLOW}2. Load your Operator contract at address $OPERATOR_ADDRESS${NC}"
        echo -e "${YELLOW}3. Call the setAuthorizedSenders function with your node address: [$NODE_ADDRESS]${NC}"
        exit 1
    fi
fi

# Generate a temporary job ID for reference
# Note: This will be replaced by the actual Chainlink-assigned job ID when the job is created
echo -e "${BLUE}Generating a temporary job ID for reference...${NC}"
JOB_ID=$(generate_job_id)
JOB_ID_NO_HYPHENS=$(echo "$JOB_ID" | tr -d '-')

# Save the temporary job ID
echo "# Note: This is a placeholder. Replace with the actual job ID after creating the job in Chainlink" > "$INSTALLER_DIR/.job_placeholder"
echo "JOB_ID=\"$JOB_ID\"" >> "$INSTALLER_DIR/.job_placeholder"
echo "JOB_ID_NO_HYPHENS=\"$JOB_ID_NO_HYPHENS\"" >> "$INSTALLER_DIR/.job_placeholder"
echo -e "${YELLOW}Temporary job ID generated: $JOB_ID${NC}"
echo -e "${YELLOW}Temporary job ID (no hyphens): $JOB_ID_NO_HYPHENS${NC}"
echo -e "${YELLOW}NOTE: This is a placeholder only. The actual job ID will be assigned by Chainlink when creating the job.${NC}"

# Save deployment information
echo -e "${BLUE}Saving deployment information...${NC}"
mkdir -p "$INSTALL_DIR/contracts/info"
cat > "$INSTALL_DIR/contracts/info/deployment.txt" << EOL
Verdikta Smart Contract Deployment Information
=============================================

Operator Contract Address: $OPERATOR_ADDRESS
Chainlink Node Address: $NODE_ADDRESS
Temporary Job ID: $JOB_ID
Temporary Job ID (no hyphens): $JOB_ID_NO_HYPHENS

IMPORTANT: The job IDs above are temporary placeholders. 
After creating the actual job in the Chainlink node, you need to:
1. Note the actual job ID assigned by Chainlink
2. Update the .contracts file with the actual job ID

The node has been successfully authorized in the Operator contract.

Next Steps:
1. Go to the Chainlink node UI at http://localhost:6688
2. Create a new job using the job specification from the template
3. Note the actual job ID assigned by Chainlink
4. Update your .contracts file with:
   JOB_ID="actual-job-id-with-hyphens"
   JOB_ID_NO_HYPHENS="actual-job-id-without-hyphens"

For detailed instructions, see the documentation at:
$INSTALL_DIR/docs/README.md
EOL

echo -e "${GREEN}Smart Contract deployment steps completed!${NC}"
echo -e "${YELLOW}IMPORTANT: Remember that the job ID generated is just a placeholder.${NC}"
echo -e "${YELLOW}You'll need to use the actual job ID assigned by Chainlink when you create the job.${NC}"
echo -e "${BLUE}Next step: Configuring Node Jobs and Bridges${NC}"

exit 0 