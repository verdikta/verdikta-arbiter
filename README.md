# Verdikta-Arbiter

> Decentralized AI-powered dispute resolution oracle for blockchain networks

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://github.com/verdikta/verdikta-arbiter/workflows/CI/badge.svg)](https://github.com/verdikta/verdikta-arbiter/actions)
[![Discord](https://img.shields.io/discord/DISCORD_ID?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/verdikta)

Verdikta-Arbiter is an open-source oracle system that provides AI-powered dispute resolution services on blockchain networks. It combines advanced language models with blockchain infrastructure to deliver fair, transparent, and efficient arbitration.

## 🚀 Quick Start

### For Node Operators

```bash
# Clone the repository
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter

# Run the installer
./installer/bin/install.sh
```

### For Developers

```bash
# Fork and clone your fork
git clone https://github.com/YOUR_USERNAME/verdikta-arbiter.git
cd verdikta-arbiter

# Set up development environment
./installer/bin/setup-environment.sh
cd ai-node && npm install && npm run dev
```

### For Users

Visit our [documentation](https://docs.verdikta.com/) to learn how to integrate Verdikta into your applications.

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   AI Node       │    │ External        │    │ Chainlink       │
│   (Next.js)     │◄──►│ Adapter         │◄──►│ Node            │
│                 │    │ (Node.js)       │    │ (Oracle)        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   AI Models     │    │      IPFS       │    │ Smart Contracts │
│ GPT/Claude/     │    │   (Evidence     │    │ (Base Network)  │
│ Ollama          │    │    Storage)     │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## ✨ Key Features

- **🤖 Multi-Model AI**: Leverage GPT-5, Claude-4, Grok-4, and local models simultaneously
- **⚡ Fast Resolution**: Automated decisions in minutes, not days
- **🔗 Blockchain Native**: Built for Base/Ethereum with smart contract integration
- **🌐 Decentralized**: Multiple independent arbiters ensure fairness
- **💰 Cost-Effective**: Significantly cheaper than traditional arbitration
- **🔍 Transparent**: All decisions recorded on-chain with full justifications
- **📊 ClassID Integration**: Curated AI model pools for optimal performance

## 🛠️ Components

### AI Node
- **Technology**: Next.js, TypeScript, React
- **Purpose**: Web interface and AI model orchestration
- **Features**: Multi-model deliberation, evidence processing, result visualization

### External Adapter  
- **Technology**: Node.js, Express, IPFS
- **Purpose**: Chainlink bridge for blockchain integration
- **Features**: Evidence storage, job execution, result formatting

### Chainlink Node
- **Technology**: Chainlink Core, PostgreSQL
- **Purpose**: Oracle infrastructure
- **Features**: Job scheduling, blockchain connectivity, secure key management

### Smart Contracts
- **Technology**: Solidity, Hardhat
- **Purpose**: On-chain arbitration logic
- **Features**: Request handling, oracle management, result settlement

### Installation System
- **Technology**: Bash, Docker
- **Purpose**: Automated deployment
- **Features**: One-command setup, environment validation, service orchestration

## 🤝 Contributing

We welcome contributions from the community! This repository is open source, but write access is restricted to the core team. All contributions must go through pull requests.

### Quick Contribution Guide

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/verdikta-arbiter.git`
3. **Create** a branch: `git checkout -b feature/amazing-feature`
4. **Make** your changes and add tests
5. **Commit** with clear messages: `git commit -m "feat: add amazing feature"`
6. **Push** to your fork: `git push origin feature/amazing-feature`
7. **Open** a Pull Request with a detailed description

### Development Setup

```bash
# Install prerequisites
./installer/util/check-prerequisites.sh

# Set up environment
./installer/bin/setup-environment.sh

# Install dependencies
cd ai-node && npm install
cd ../external-adapter && npm install
cd ../arbiter-operator && npm install

# Run tests
npm test
```

### Areas for Contribution

- 🚀 **High Priority**: Performance optimization, security enhancements, documentation
- 🛠️ **Medium Priority**: Developer experience, monitoring, compatibility  
- 💡 **Ideas Welcome**: New features, integrations, tools, examples

See our [Contributing Guide](docs/CONTRIBUTING.md) for detailed information.

## 📚 Documentation

- **[Full Documentation](https://docs.verdikta.com/)** - Comprehensive guides and API references
- **[Contributing Guide](docs/CONTRIBUTING.md)** - How to contribute to the project
- **[Development Setup](docs/development/setup.md)** - Local development environment
- **[Architecture Overview](docs/development/architecture.md)** - Technical architecture details
- **[Installation Guide](https://docs.verdikta.com/node-operators/getting-started/installation-guide/)** - Node operator setup
- **[API Reference](https://docs.verdikta.com/developers/api-reference/)** - Integration documentation

## 🌐 Network Status

| Component | Status | Network |
|-----------|--------|---------|
| Arbiter Nodes | ✅ Beta | Base Sepolia |
| Dispatcher | ✅ Beta | Base Sepolia |
| Client SDKs | 🚧 Alpha | - |
| Mainnet | 📅 Planned | Base Mainnet |

## 🔧 Requirements

### System Requirements
- **OS**: Linux, macOS, or Windows (WSL2)
- **Node.js**: v20.18.1 (automatically installed)
- **Docker**: Latest stable version
- **Memory**: 4GB+ RAM recommended
- **Storage**: 10GB+ free space

### Optional Requirements
- **OpenAI API Key**: For GPT models
- **Anthropic API Key**: For Claude models
- **xAI/Grok API Key**: For Grok models
- **Ollama**: For local AI models

## 📊 Usage Examples

### Basic Arbitration Query

```javascript
const arbitrationResult = await fetch('/api/arbitrate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    manifest: {
      outcomes: ['Approve', 'Reject', 'Request More Info'],
      panel: [
        { provider: 'openai', model: 'gpt-5' },
        { provider: 'anthropic', model: 'claude-sonnet-4' }
      ],
      evidence: [{ type: 'text', content: 'Dispute details...' }]
    },
    classId: 128
  })
});
```

### Smart Contract Integration

```solidity
// Request arbitration
bytes32 requestId = arbiterOperator.requestArbitration{value: fee}(
  classId,
  manifestCID
);

// Handle result
function fulfillArbitration(bytes32 requestId, string memory resultCID) external {
  // Process arbitration result
}
```

## 🔐 Security

### Reporting Security Issues
- **Email**: security@verdikta.org
- **Scope**: Smart contracts, oracle infrastructure, API endpoints
- **Response**: 24-48 hours for critical issues

### Security Features
- Input validation and sanitization
- Rate limiting and DDoS protection  
- Secure key management
- Smart contract audit trail
- Encrypted evidence storage

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **OpenAI**, **Anthropic**, and **xAI** for AI model APIs
- **Chainlink** for oracle infrastructure
- **IPFS** for decentralized storage
- **Base** for blockchain infrastructure
- **Open source community** for tools and libraries

## 📞 Support & Community

- **📖 Documentation**: [docs.verdikta.com](https://docs.verdikta.com/)
- **💬 Discord**: [Join our community](https://discord.gg/verdikta)
- **🐛 Issues**: [GitHub Issues](https://github.com/verdikta/verdikta-arbiter/issues)
- **💡 Discussions**: [GitHub Discussions](https://github.com/verdikta/verdikta-arbiter/discussions)
- **📧 Email**: support@verdikta.org

## 🗺️ Roadmap

### Current (Beta)
- ✅ Core arbitration functionality
- ✅ ClassID model pool integration
- ✅ Base Sepolia deployment
- ✅ Basic web interface

### Next (v1.0)
- 🔄 Mainnet deployment
- 🔄 Advanced UI/UX
- 🔄 Mobile app support
- 🔄 Enterprise features

### Future (v2.0+)
- 📅 Multi-chain support
- 📅 Advanced AI models
- 📅 Governance token
- 📅 Reputation system

---

**Made with ❤️ by the Verdikta team and contributors**

*Building the future of decentralized dispute resolution*
