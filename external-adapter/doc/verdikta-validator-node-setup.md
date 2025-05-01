
# Verdikta Validator Node Setup Guide




## Table of Contents

1. Prerequisites and System Requirements

   - Hardware Requirements

   - Software Prerequisites

2. Node.js Installation and Configuration

   - Using Node Version Manager (nvm)

   - Alternative Installation

3. AI Node Setup

   - Repository Setup

   - Environment Configuration

     - OpenAI Configuration

     - Anthropic Configuration

     - Ollama Setup and Models

   - Starting the AI Node

   - Troubleshooting Common Issues

4. External Adapter Installation

5. Docker and Database Setup

6. Chainlink Node Configuration

7. Smart Contract Deployment

8. Bridge and Job Configuration

9. Client Contract Setup

10. Security and Verification




## 1. Prerequisites and System Requirements




### Hardware Requirements

- CPU: Modern multi-core processor

- RAM: Minimum 6 GB

- Storage: 100 GB NVMe or SSD

- Network: Support for 32 TB traffic

- Operating System: Ubuntu 20.04 or greater




### Software Prerequisites

- Git (latest stable version)

- Node.js 18.17 or later

- Docker Engine 24.0.0 or later

- Docker Compose 2.20.0 or later

- Access to Base Sepolia testnet

- API keys for:

  - OpenAI (GPT-4 access required)

  - Anthropic (Claude access required)

  - Infura (Web3 API access)

  - Pinata (IPFS access)




## 2. Node.js Installation and Configuration




### Prerequisites

- Operating system requirements met [Section 1]

- Internet connection for downloading packages

- Sudo/root access for system-wide installation




### Using Node Version Manager (nvm) - Recommended

```sh

# Install nvm

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash




# Reload shell configuration

source ~/.bashrc




# Install required Node.js version

nvm install 18.17




# Set as default

nvm use 18.17




# Verify installation

node --version  # Should show v18.17.x or later

npm --version

```



### Alternative: Direct Installation

1. Visit [Node.js website](https://nodejs.org/)

2. Download Node.js 18.17 LTS or later

3. Run the installer

4. Verify installation:

```sh
node --version  # Should show v18.17.x or later

npm --version

```



### Next Steps

- Proceed to [Section 3: AI Node Setup] to configure the AI service

- Review [Section 10: Security and Verification] for security best practices




## 3. AI Node Setup




### Prerequisites

- Node.js 18.17+ installed [Section 2]

- Git installed

- OpenAI API key

- Anthropic API key

- Minimum 20GB free disk space for Ollama models




### Repository Setup

```sh

# Clone the AI Node repository

git clone https://github.com/nigelon11/ai-node-development.git

cd ai-node-development




# Install dependencies

npm install

```



### Environment Configuration




#### API Keys Setup

1. Create local environment file:

```sh
cp .env.local.example .env.local

```


2. Configure API Keys:

```sh

# Open .env.local and update the following values

OPENAI_API_KEY={YOUR-OPENAI-KEY}        # Obtain from https://platform.openai.com

ANTHROPIC_API_KEY={YOUR-ANTHROPIC-KEY}  # Obtain from https://console.anthropic.com

JUSTIFIER_MODEL={Provider:Model}        # Example: JUSTIFIER_MODEL=OpenAI:gpt-4

```



#### Ollama Setup

1. Install Ollama:

```sh
curl -fsSL https://ollama.com/install.sh | sh

```


2. Pull recommended models:

```sh

# Pull each model individually

ollama pull phi3

ollama pull llama3.1

ollama pull llama3.2

ollama pull llava

ollama pull deepseek

```


Note: These are the recommended default models for testing. Additional models can be added based on your system specifications. Each model requires additional storage space and memory. Visit https://ollama.com/library for the full list of available models.




### Verify Installation

1. Ensure AI Node is running:

   - The AI Node must be running on http://localhost:3000 as the external adapter's integration tests will make calls to it

   - If not running, start it with `npm run dev` in the AI Node directory



2. Run the test suite:

```sh

# Run all tests

npm test

```


The tests should complete successfully with no failures. If you see any failures in the integration tests, verify that:

- The AI Node is running and accessible

- Your environment variables are correctly set

- You have valid API keys configured




### Starting the AI Node

```sh
npm run dev

```
The server will start on http://localhost:3000




### Troubleshooting Common AI Node Issues

1. Port 3000 Already in Use

   - Error: `EADDRINUSE: address already in use :::3000`

   - Solution: Either stop the process using port 3000 or change the port in .env.local

```sh
   lsof -i :3000  # Find process using port 3000

   kill -9 <PID>  # Stop the process

```


2. API Key Issues

   - Error: "Authentication failed" or "Invalid API key"

   - Solution: Verify API keys are correctly copied and have no trailing spaces



3. Ollama Model Issues

   - Error: "Failed to load model"

   - Solution: Check system resources and try pulling the model again

```sh
   ollama list    # Check installed models

   ollama remove <model_name>  # Remove problematic model

   ollama pull <model_name>    # Re-pull the model

```



### Next Steps

- Proceed to [Section 4: External Adapter Installation] for adapter setup

- Ensure all API keys are properly secured [Section 10: Security and Verification]




## 4. External Adapter Installation




### Prerequisites

- AI Node running [Section 3]

- Node.js 18.17+ installed [Section 2]

- Pinata account created

- Git installed




### Repository Setup

```sh

# Clone the repository

git clone https://github.com/nigelon11/verdikta-external-adapter.git

cd verdikta-external-adapter




# Install dependencies

npm install

```



### Environment Configuration

1. Create and configure environment file:

```sh

# Copy example environment file

cp .env.example .env




# Configure the following in .env

PORT=8080

HOST=0.0.0.0

AI_NODE_URL=http://localhost:3000

```


2. Set up IPFS Configuration:

   - Create a free account at [Pinata](https://pinata.cloud)

   - Navigate to API Keys section

   - Create a new API key with `Admin` permissions

   - Add to .env:

```sh
IPFS_PINNING_SERVICE=https://api.pinata.cloud

IPFS_PINNING_KEY={Your-Pinata-JWT}

```



### Starting the External Adapter

```sh
npm start

```
The adapter will start on http://localhost:8080




### Port Configuration

- Default port is 8080

- If port 8080 is in use, you can modify the PORT in .env

- Ensure the port you choose doesn't conflict with other services:

  - AI Node (default: 3000)

  - Chainlink Node (default: 6688)

  - Postgres (default: 5432)




### Troubleshooting Common External Adapter Issues

1. Connection Issues with AI Node

   - Error: "Unable to connect to AI Node"

   - Solution: Verify AI Node is running and AI_NODE_URL is correct

```sh
   curl http://localhost:3000/health  # Should return status OK

```


2. IPFS Upload Failures

   - Error: "Failed to upload to IPFS"

   - Solutions:

     - Verify Pinata API key is valid

     - Check network connectivity

     - Ensure file size is within Pinata limits



3. Port Conflicts

   - Error: "EADDRINUSE: address already in use :::8080"

   - Solution:

```sh
   # Find process using port 8080

   lsof -i :8080

   # Kill the process

   kill -9 <PID>

   # Or change port in .env

   PORT=8081

```



## 5. Docker and Database Setup




### Docker Installation

1. Install Docker Desktop:

   - Download from [Docker's official website](https://www.docker.com/products/docker-desktop/)

   - Follow the installation instructions for your operating system

   - Start Docker Desktop after installation



2. Verify Docker installation:

```sh
docker --version

docker-compose --version

```



### PostgreSQL Database Setup

1. Start PostgreSQL container:

```sh

# Create and run PostgreSQL container

docker run --name cl-postgres \

  -e POSTGRES_PASSWORD=<your-secure-password> \

  -p 5432:5432 \

  -d postgres

```


Note: Replace <your-secure-password> with a strong password. Make sure to record this password as it will be needed for Chainlink node configuration.



2. Verify database is running:

```sh

# Check container status

docker ps | grep cl-postgres




# Test database connection

docker exec cl-postgres pg_isready

```



### Database Management

1. Basic container operations:

```sh

# Stop the database

docker stop cl-postgres




# Start the database

docker start cl-postgres




# View logs

docker logs cl-postgres




# Remove container (caution: this will delete all data)

docker rm -f cl-postgres

```


2. Database backup (recommended):

```sh

# Create a backup

docker exec cl-postgres pg_dump -U postgres > backup.sql




# Restore from backup

cat backup.sql | docker exec -i cl-postgres psql -U postgres

```



### Troubleshooting Common Docker/Database Issues

1. Docker Service Issues

   - Error: "Cannot connect to the Docker daemon"

   - Solution:

```sh
   # Check Docker service status

   sudo systemctl status docker

   

   # Start Docker service if needed

   sudo systemctl start docker

```


2. PostgreSQL Connection Issues

   - Error: "Connection refused" or "Connection timed out"

   - Solutions:

     - Verify container is running

```sh
     docker ps | grep cl-postgres

```
     - Check port availability

```sh
     sudo lsof -i :5432

```
     - Restart container

```sh
     docker restart cl-postgres

```


3. Database Password Issues

   - If you forget the password, you'll need to recreate the container

   - Always store the password securely

   - Consider using a password manager




## 6. Chainlink Node Configuration




### Setting up Chainlink Node Directory

1. Create configuration directory:

```sh

# Create directory for Base Sepolia testnet

mkdir ~/.chainlink-sepolia
cd ~/.chainlink-sepolia
```



### Configuration Files Setup

1. Create config.toml for Base Sepolia:

```sh

# Create and populate config.toml

echo "[Log]

Level = `warn`



[WebServer]

AllowOrigins = '*'

SecureCookies = false



[WebServer.TLS]

HTTPSPort = 0



[[EVM]]

ChainID = `84532`  # Base Sepolia only



[[EVM.Nodes]]

Name = `Base-Sepolia`

WSURL = 'wss://base-sepolia.infura.io/ws/v3/{your-infura-project-id}'

HTTPURL = 'https://base-sepolia.infura.io/v3/{your-infura-project-id}'

" > ~/.chainlink-sepolia/config.toml

```


2. Create secrets.toml:

```sh

# Create and populate secrets.toml

echo "[Password]

Keystore = `Jz23A88isl89a89b`  # Change this to your secure password

[Database]

URL = 'postgresql://postgres:<database-password>@host.docker.internal:5432/postgres?sslmode=disable'

" > ~/.chainlink-sepolia/secrets.toml

```


Note: Replace <database-password> with the PostgreSQL password you set earlier.




### Infura Setup

1. Create an Infura account:

   - Visit [Infura](https://infura.io) and sign up

   - Create a new project

   - Select "Web3 API" as the product

   - Copy your project ID



2. Update config.toml with your Infura credentials:

   - Replace {your-infura-project-id} in both WSURL and HTTPURL




### Starting the Chainlink Node

1. Run the Chainlink node container:

```sh
cd ~/.chainlink-sepolia && docker run \

  --platform linux/x86_64/v8 \

  --name chainlink \

  -v ~/.chainlink-sepolia:/chainlink \

  -it \

  -p 6688:6688 \

  --add-host=host.docker.internal:host-gateway \

  smartcontract/chainlink:2.13.0 \

  node \

  -config /chainlink/config.toml \

  -secrets /chainlink/secrets.toml \

  start \

  -a /chainlink/.api

```


2. Verify node is running:

   - Access the Chainlink operator UI at http://localhost:6688

   - Log in with your credentials




### Troubleshooting Common Chainlink Node Issues

1. Database Connection Issues

   - Error: "Unable to connect to database"

   - Solutions:

     - Verify PostgreSQL container is running

     - Check database password in secrets.toml

     - Ensure host.docker.internal is properly resolved

```sh
     # Test database connection from Chainlink container

     docker exec chainlink pg_isready -h host.docker.internal

```


2. Infura Connection Issues

   - Error: "Failed to dial websocket" or "Invalid project ID"

   - Solutions:

     - Verify Infura project ID

     - Check network connectivity

     - Ensure project has access to Base Sepolia

```sh
     # Test Infura connection

     curl -X POST -H "Content-Type: application/json" \

       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \

       "https://base-sepolia.infura.io/v3/{your-infura-project-id}"

```


3. Container Access Issues

   - Error: "Permission denied" or "Cannot create directory"

   - Solution:

```sh
   # Fix permissions on chainlink directory

   sudo chown -R 14933:14933 ~/.chainlink-sepolia

```





## 7. Smart Contract Deployment




### Prerequisites

- MetaMask installed and configured for Base Sepolia

- Base Sepolia ETH for gas fees

- Base Sepolia LINK for oracle payments

- Git installed




### Repository Setup

1. Clone the Chainlink Node repository:

```sh

# Clone repository containing contract templates

git clone https://github.com/yenachar/verdiktaChainlinkNode.git

cd verdiktaChainlinkNode

```


Note: This repository contains essential files:

- `MyOperator.sol`: The Operator contract template

- `basicJobSpec`: The job specification template for the Chainlink node




### Setting up Test Networks

1. Add Base Sepolia to MetaMask:

   - Network Name: Base Sepolia

   - RPC URL: https://base-sepolia.infura.io/v3/{your-infura-project-id}

   - Chain ID: 84532

   - Currency Symbol: ETH

   - Block Explorer: https://sepolia.basescan.org



2. Obtain test tokens:

   - Get Base Sepolia ETH from [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-sepolia-faucet)

   - Get Base Sepolia LINK from [Chainlink Faucet](https://faucets.chain.link)

   - Recommended starting amount: 1 LINK (covers ~20 transactions at 0.05 LINK each)




### Deploying the Operator Contract

1. Access Remix IDE:

   - Visit [Remix](https://remix.ethereum.org)

   - Create new file: `MyOperator.sol`



2. Configure Remix:

   - Set compiler version to 0.8.19

   - Enable optimization

   - Select "Injected Web3" in the deploy section

   - Ensure MetaMask is connected to Base Sepolia



3. Deploy Operator Contract:

   - Copy contents from `MyOperator.sol`

   - Compile the contract

   - Deploy using MetaMask

   - Save the deployed contract address



4. Verify deployment:

```sh

# Test contract deployment

curl -X POST -H "Content-Type: application/json" \

  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["<contract-address>","latest"],"id":1}' \

  https://base-sepolia.infura.io/v3/{your-infura-project-id}

```



### Contract Security

1. Secure key management:

   - Never share or commit private keys

   - Use environment variables for sensitive data

   - Consider using a hardware wallet for production



2. Contract verification:

   - Verify contract on [Base Sepolia Explorer](https://sepolia.basescan.org)

   - Upload source code and constructor arguments

   - Ensure contract is verified successfully




### Troubleshooting Contract Deployment

1. Transaction Failures

   - Error: "Out of gas"

   - Solution: Increase gas limit or ensure sufficient Base Sepolia ETH

```sh
   # Check ETH balance

   curl -X POST -H "Content-Type: application/json" \

     --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["<your-address>","latest"],"id":1}' \

     https://base-sepolia.infura.io/v3/{your-infura-project-id}

```


2. Compilation Issues

   - Error: "Source file requires different compiler version"

   - Solution: Match compiler version in Remix with contract requirements

   

3. Network Issues

   - Error: "Network connection issues"

   - Solutions:

     - Verify MetaMask is on Base Sepolia

     - Check Infura connection

     - Ensure proper RPC configuration




## 8. Bridge and Job Configuration




### Bridge Setup

1. Access Chainlink Operator UI:

   - Navigate to http://localhost:6688

   - Log in with your credentials



2. Create New Bridge:

   - Click on `Bridges` tab

   - Select 'New Bridge'

   - Fill in the following details:

```sh
   Name: verdikta-ai

   URL: http://{host-ip-address}:8080/evaluate

   Minimum Contract Payment: 0

   Confirmation: 0

```
   Note: Replace {host-ip-address} with your machine's IP address or localhost if running locally



3. Verify Bridge:

   - Click 'Bridge List' to verify the bridge is listed

   - Status should show as "Bridge Added"




### Job Configuration

1. Create New Job:

   - Click on `Jobs` tab

   - Select 'New Job'

   - Locate `basicJobSpec` in your cloned verdiktaChainlinkNode repository

   - Copy the contents of this file to the job spec text area




### Testing the Configuration

1. Verify Bridge Connection:

   - Click `Bridge` tab

   - Select `verdikta-ai` bridge

   - Click 'Bridge URL' to test connection

   - Should receive a valid response



2. Monitor Job Runs:

   - Click `Jobs` tab

   - Select your job

   - View 'Job Runs' tab to monitor executions

   - Check `Error` tab for any issues




### Troubleshooting Common Bridge/Job Issues

1. Bridge Connection Failures

   - Error: "Bridge not available"

   - Solutions:

     - Verify External Adapter is running

     - Check URL is accessible

     - Confirm port forwarding if needed

```sh
   # Test bridge endpoint

   curl -X POST http://{host-ip-address}:8080/evaluate

```


2. Job Execution Errors

   - Error: "Task type not found"

   - Solution: Verify job specification syntax and task types

   

3. CBOR Parsing Issues

   - Error: "Failed to parse CBOR data"

   - Solution: Verify input data format matches specification

```sh
   # Example valid CBOR data format

   {"cid": "QmYourIPFSHash"}

```


4. Transaction Submission Failures

   - Error: "Transaction reverted"

   - Solutions:

     - Check contract address is correct

     - Verify node has sufficient ETH for gas

     - Confirm job has correct permissions




## 9. Client Contract Setup




### Repository Setup

1. Clone the client contract repository:

```sh
git clone https://github.com/yenachar/simpleVerdiktaClientContract.git

cd simpleVerdiktaClientContract

```


2. Install dependencies:

```sh

# Install Truffle globally

npm install -g truffle




# Install project dependencies

npm install @chainlink/contracts@0.4.2 --save

npm install @openzeppelin/contracts --save

npm install @truffle/hdwallet-provider --save

```



### Environment Configuration

1. Create .env file:

```sh

# Create and populate .env file

echo "PRIVATE_KEY=<your-private-key>

INFURA_API_KEY=<your-infura-key>" > .env

```


Note: Replace placeholders with your actual keys. For security:

- Generate a new private key specifically for development

- Never share or commit your private key

- Consider using environment variables instead of .env file in production




### Contract Configuration

1. Update migration file:

```sh
cd migrations

nano 2_deploy_contract.js

```


2. Configure deployment parameters:

   - Set `oracleAddress` to your deployed Operator contract address

   - Set `jobId` to your Chainlink job ID (remove hyphens)

   Example: `6bfed3e2-c2a4-4e1d-addb-bd590cd01af2` becomes `6bfed3e2c2a44e1daddbbd590cd01af2`




### Contract Deployment

1. Deploy the contract:

```sh

# Return to project root

cd ..




# Deploy using script

./deploy.sh

```


2. Record important information:

   - Save the deployed contract address

   - Note the transaction hash for verification

   - Document the network details




### Contract Funding

1. Fund with LINK tokens:

   - Send at least 1 LINK to the contract address

   - This covers approximately 20 oracle requests (0.05 LINK each)

   - Monitor LINK balance regularly



2. Verify funding:

```sh

# Check LINK balance (using ethers.js in Node.js)

node -e "

const { ethers } = require(`ethers`);

const provider = new ethers.providers.JsonRpcProvider('https://base-sepolia.infura.io/v3/{your-infura-project-id}');

const linkAbi = ['function balanceOf(address) view returns (uint256)'];

const linkToken = new ethers.Contract(`0x779877A7B0D9E8603169DdbD7836e478b4624789`, linkAbi, provider);

linkToken.balanceOf(`YOUR_CONTRACT_ADDRESS`).then(console.log);

"

```



### Contract Authorization

1. Set up contract permissions:

   - Load Operator contract in Remix

   - Connect with contract owner's wallet

   - Get Chainlink node address from GUI (localhost:6688 -> Key Management -> EVM Chain Accounts)



2. Authorize the contract:

   - Call `setAuthorizedSenders` with node address

   - Format: `["0xNodeAddress"]`

   - Verify authorization:

```sh
   # Call isAuthorizedSender with your node address

   # Should return true

```



### Testing the Setup

1. Basic contract interaction:

```sh

# Using ethers.js to test contract

node -e "

const { ethers } = require(`ethers`);

const provider = new ethers.providers.JsonRpcProvider('https://base-sepolia.infura.io/v3/{your-infura-project-id}');

const wallet = new ethers.Wallet(`YOUR_PRIVATE_KEY`, provider);

const contract = new ethers.Contract(`YOUR_CONTRACT_ADDRESS`, ['function getLastResult() view returns (uint256[])'], wallet);

contract.getLastResult().then(console.log);

"

```



### Troubleshooting Common Issues

1. Deployment Failures

   - Error: "Insufficient funds"

   - Solutions:

     - Ensure wallet has enough ETH for gas

     - Check gas price and limit settings

     - Verify network configuration



2. Authorization Issues

   - Error: "Sender not authorized"

   - Solutions:

     - Verify Chainlink node address is correct

     - Check authorization transaction status

     - Confirm proper function call format



3. LINK Funding Issues

   - Error: "Insufficient LINK balance"

   - Solutions:

     - Verify LINK transfer was successful

     - Check contract address is correct

     - Ensure sufficient LINK balance for operations




## 10. Security and Verification




### Security Best Practices

1. API and Key Management:

   - Store all sensitive data in environment variables

   - Never commit secrets to version control

   - Use separate keys for development and production

   - Implement regular key rotation schedule

   - Use hardware wallets for production private keys



2. Network Security:

   - Configure firewalls for required ports only:

     - AI Node: 3000

     - External Adapter: 8080

     - Chainlink Node: 6688

     - PostgreSQL: 5432

   - Use HTTPS in production

   - Implement rate limiting

   - Use secure websocket connections



3. Infrastructure Security:

   - Keep all software updated

   - Use official Docker images only

   - Regular security scans

   - Implement automated backup procedures




### Operational Verification

1. Service Health Checks:

```sh

# AI Node

curl http://localhost:3000/health




# External Adapter

curl http://localhost:8080/health




# Chainlink Node

curl http://localhost:6688/health




# PostgreSQL

docker exec cl-postgres pg_isready

```


2. Contract Verification:

   - Verify all deployed contracts on Base Sepolia Explorer

   - Test contract interactions with minimal LINK amounts

   - Monitor contract events and logs



3. System Monitoring:

```sh

# Check running services

docker ps




# Monitor logs

docker logs chainlink

docker logs cl-postgres




# Check disk space

df -h




# Monitor system resources

top

```



### Backup and Recovery

1. Database Backups:

```sh

# Regular database dumps

docker exec cl-postgres pg_dump -U postgres > backup_$(date +%Y%m%d).sql




# Compress backups

gzip backup_$(date +%Y%m%d).sql

```


2. Configuration Backups:

   - Backup all .env files

   - Store contract addresses and Job IDs

   - Document all custom configurations



3. Recovery Procedures:

   - Keep restore scripts ready

   - Test recovery procedures regularly

   - Document recovery steps




### Regular Maintenance

1. Update Schedule:

   - Node.js dependencies

   - Docker images

   - Smart contracts

   - System packages



2. Monitoring Checklist:

   - LINK balance in contracts

   - Disk space usage

   - System resource utilization

   - Log file sizes

   - Database performance



3. Security Audits:

   - Regular security scans

   - Access control reviews

   - API key rotation

   - Network security checks




### Troubleshooting Checklist

1. System Issues:

   - Check service status

   - Verify network connectivity

   - Monitor resource usage

   - Review recent changes



2. Contract Issues:

   - Verify LINK balance

   - Check authorization status

   - Review transaction history

   - Monitor gas prices



3. Integration Issues:

   - Validate API responses

   - Check service connections

   - Verify data formats

   - Monitor request/response times




### Emergency Procedures

1. Service Recovery:

```sh

# Quick restart of all services

docker restart chainlink cl-postgres

npm restart  # For Node.js services

```


2. Contact Information:

   - Keep updated contact list

   - Document escalation procedures

   - Maintain incident response plan



3. Incident Response:

   - Log all incidents

   - Document resolution steps

   - Update procedures based on lessons learned

   - Regular team training




