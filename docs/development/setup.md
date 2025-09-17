# Development Setup

This guide helps you set up a local development environment for contributing to Verdikta-Arbiter.

## Prerequisites

### System Requirements
- **OS**: macOS, Linux, or WSL2 on Windows
- **Node.js**: v20.18.1 (managed via NVM)
- **Docker**: Latest stable version
- **Git**: Latest version
- **Ollama**: For local AI model testing (optional)

### Required Accounts
- **GitHub**: For forking and contributing
- **OpenAI**: API key for testing (optional)
- **Anthropic**: API key for testing (optional)

## Quick Setup

### 1. Clone and Setup

```bash
# Fork the repo on GitHub first, then:
git clone https://github.com/YOUR_USERNAME/verdikta-arbiter.git
cd verdikta-arbiter

# Run the automated setup
./installer/util/check-prerequisites.sh
./installer/bin/setup-environment.sh
```

### 2. Install Dependencies

```bash
# AI Node
cd ai-node
npm install
npm run build

# External Adapter  
cd ../external-adapter
npm install
npm test

# Smart Contracts
cd ../arbiter-operator
npm install
npm test
```

### 3. Configure Environment

```bash
# Copy example environment files
cp ai-node/.env.local.example ai-node/.env.local
cp external-adapter/.env.example external-adapter/.env

# Edit with your API keys (optional for development)
nano ai-node/.env.local
```

### 4. Test Setup

```bash
# Test ClassID integration
cd ai-node
npm run test-classid

# Test external adapter
cd ../external-adapter
npm run test

# Test installer components
cd ../installer
./util/verify-installation.sh
```

## Development Workflow

### Daily Development

```bash
# Start development servers
cd ai-node && npm run dev &
cd external-adapter && npm start &

# Watch for changes and auto-restart
npm run dev:watch

# Run tests continuously
npm run test:watch
```

### Working with ClassID Integration

```bash
# Test ClassID functionality
cd ai-node
npm run test-classid

# Reconfigure model pools
npm run integrate-classid

# Validate configuration
node -e "const {classMap} = require('@verdikta/common'); console.log('Classes:', classMap.listClasses().length);"
```

### Testing Changes

```bash
# Run unit tests
npm test

# Run integration tests
cd testing-tool
npm run test:integration

# Test installer changes (use clean VM/container)
./installer/bin/install.sh --skip-tests
```

## Development Tools

### Recommended VS Code Extensions
```json
{
  "recommendations": [
    "esbenp.prettier-vscode",
    "ms-vscode.vscode-typescript-next", 
    "bradlc.vscode-tailwindcss",
    "ms-vscode.vscode-json",
    "redhat.vscode-yaml",
    "ms-vscode.vscode-docker"
  ]
}
```

### Debugging Setup

#### AI Node (Next.js)
```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug AI Node",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/ai-node/node_modules/.bin/next",
      "args": ["dev"],
      "cwd": "${workspaceFolder}/ai-node",
      "console": "integratedTerminal",
      "env": {
        "NODE_OPTIONS": "--inspect"
      }
    }
  ]
}
```

#### External Adapter
```json
{
  "name": "Debug External Adapter", 
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/external-adapter/src/index.js",
  "cwd": "${workspaceFolder}/external-adapter",
  "console": "integratedTerminal"
}
```

### Useful Scripts

```bash
# Format all code
npm run format

# Lint all code
npm run lint

# Check types
npm run type-check

# Build all components
npm run build:all

# Clean all node_modules
npm run clean
```

## Common Development Tasks

### Adding New AI Models

1. **Update ClassID configuration** (if curated model):
   ```bash
   cd ai-node
   npm run integrate-classid
   ```

2. **Manual model addition**:
   ```typescript
   // ai-node/src/config/models.ts
   export const modelConfig = {
     openai: [
       { name: 'new-model', supportsImages: true, supportsAttachments: true }
     ]
   }
   ```

3. **Test the new model**:
   ```bash
   npm run test-classid
   npm test
   ```

### Modifying the Installer

1. **Test in clean environment**:
   ```bash
   # Use Docker or VM
   docker run -it --rm ubuntu:22.04 bash
   
   # Or use GitHub Codespaces
   gh codespace create
   ```

2. **Test specific installer components**:
   ```bash
   ./installer/bin/install-ai-node.sh --skip-tests
   ./installer/bin/setup-docker.sh
   ./installer/bin/deploy-contracts.sh
   ```

3. **Validate installer changes**:
   ```bash
   ./installer/util/verify-installation.sh
   ```

### Working with Smart Contracts

1. **Local blockchain setup**:
   ```bash
   # Start local Hardhat network
   cd arbiter-operator
   npx hardhat node
   ```

2. **Deploy contracts locally**:
   ```bash
   npx hardhat run scripts/deploy.js --network localhost
   ```

3. **Run contract tests**:
   ```bash
   npx hardhat test
   npx hardhat coverage
   ```

## Troubleshooting

### Common Issues

**Node.js version mismatch**:
```bash
nvm use 20.18.1
nvm alias default 20.18.1
```

**Docker permission issues**:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

**Port conflicts**:
```bash
# Find and kill processes using ports
lsof -i :3000 :8080 :6688
kill -9 <PID>
```

**ClassID integration fails**:
```bash
# Update @verdikta/common
cd ai-node
npm update @verdikta/common

# Verify installation
npm list @verdikta/common
```

### Getting Help

1. **Check logs**:
   ```bash
   # AI Node logs
   tail -f ai-node/logs/ai-node_*.log
   
   # External Adapter logs  
   tail -f external-adapter/combined.log
   
   # Installer logs
   tail -f installer/logs/install.log
   ```

2. **Debug mode**:
   ```bash
   DEBUG=* npm run dev
   LOG_LEVEL=debug npm start
   ```

3. **Community support**:
   - [GitHub Discussions](https://github.com/verdikta/verdikta-arbiter/discussions)
   - [Discord Community](https://discord.gg/verdikta)
   - [Documentation](https://docs.verdikta.com/)

## Performance Tips

### Development Speed
- Use `npm ci` instead of `npm install` for faster installs
- Enable file watching for auto-restart during development
- Use Docker BuildKit for faster container builds
- Cache node_modules in CI/CD pipelines

### Resource Usage
- Limit Ollama models during development (use smaller models)
- Use `.dockerignore` to exclude unnecessary files
- Set appropriate memory limits for Node.js processes
- Monitor disk usage (logs, node_modules, Docker images)

## Next Steps

Once your development environment is ready:

1. **Pick an issue**: Browse [good first issues](https://github.com/verdikta/verdikta-arbiter/labels/good%20first%20issue)
2. **Read the code**: Familiarize yourself with the codebase structure
3. **Make small changes**: Start with documentation or small bug fixes
4. **Join discussions**: Participate in GitHub Discussions and Discord
5. **Review PRs**: Learn by reviewing other contributors' work

Happy coding! 🚀
