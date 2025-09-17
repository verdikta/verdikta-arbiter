# Contributing to Verdikta-Arbiter

Thank you for your interest in contributing to the Verdikta Arbiter Node! 🎉

This repository is open source, but write access is restricted to the **core-devs** team. All other contributors must submit changes through **pull requests (PRs)**.

## Quick Start

1. **Fork** → **Clone** → **Branch** → **Code** → **PR**
2. Follow our [development setup guide](#development-setup)
3. Read our [coding standards](#coding-standards)
4. Submit a well-documented PR

---

## How to Contribute

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/verdikta-arbiter.git
cd verdikta-arbiter
```

### 2. Development Setup

```bash
# Install prerequisites
./installer/util/check-prerequisites.sh

# Set up development environment
./installer/bin/setup-environment.sh

# Install AI Node dependencies
cd ai-node
npm install

# Install External Adapter dependencies  
cd ../external-adapter
npm install
```

### 3. Create a Feature Branch

```bash
git checkout -b feature/my-awesome-feature
# or
git checkout -b fix/bug-description
# or  
git checkout -b docs/update-readme
```

### 4. Make Your Changes

- Follow our [coding standards](#coding-standards)
- Add tests for new functionality
- Update documentation as needed
- Test your changes thoroughly

### 5. Commit and Push

```bash
# Stage your changes
git add .

# Commit with descriptive message
git commit -m "feat: add ClassID model validation

- Add validation for ClassID model pools
- Include error handling for invalid models
- Update tests for new validation logic"

# Push to your fork
git push origin feature/my-awesome-feature
```

### 6. Open a Pull Request

1. Go to your fork on GitHub
2. Click **"Compare & pull request"**
3. Fill out the PR template with:
   - Clear description of changes
   - Link to related issues
   - Testing notes
   - Breaking changes (if any)

---

## Development Guidelines

### Project Structure

```
verdikta-arbiter/
├── ai-node/              # Next.js AI arbitration service
├── external-adapter/     # Chainlink external adapter
├── arbiter-operator/     # Smart contracts
├── chainlink-node/       # Chainlink node configuration
├── installer/            # Installation and setup scripts
├── testing-tool/         # Integration testing utilities
└── docs/                 # Documentation (you are here!)
```

### Coding Standards

#### General Principles
- **Readability First**: Code should be self-documenting
- **Security Conscious**: Validate all inputs, handle errors gracefully
- **Test Coverage**: Maintain high test coverage for critical paths
- **Performance Aware**: Consider gas costs and response times

#### JavaScript/TypeScript (AI Node)
```javascript
// ✅ Good: Descriptive names, proper error handling
async function validateQueryManifest(manifest, classId) {
  try {
    const result = classMap.validateQueryAgainstClass(manifest, classId);
    if (!result.ok) {
      throw new ValidationError(`Invalid manifest: ${result.issues[0]?.detail}`);
    }
    return result.effectiveManifest;
  } catch (error) {
    logger.error('Manifest validation failed', { classId, error: error.message });
    throw error;
  }
}

// ❌ Bad: Unclear names, no error handling
function validate(m, c) {
  return classMap.validateQueryAgainstClass(m, c).effectiveManifest;
}
```

#### Shell Scripts (Installer)
```bash
# ✅ Good: Error handling, descriptive output
install_dependencies() {
    echo -e "${BLUE}Installing dependencies...${NC}"
    
    if ! npm install; then
        echo -e "${RED}Failed to install dependencies${NC}"
        return 1
    fi
    
    echo -e "${GREEN}Dependencies installed successfully${NC}"
}

# ❌ Bad: No error handling, unclear output
npm install
```

#### Solidity (Smart Contracts)
```solidity
// ✅ Good: Clear documentation, input validation
/**
 * @notice Registers an oracle with the dispatcher
 * @param oracle Address of the oracle to register
 * @param classIds Array of ClassIDs the oracle supports
 */
function registerOracle(address oracle, uint256[] calldata classIds) external {
    require(oracle != address(0), "Invalid oracle address");
    require(classIds.length > 0, "Must support at least one class");
    
    // Implementation...
}
```

### Testing Requirements

#### Unit Tests
- **AI Node**: `cd ai-node && npm test`
- **External Adapter**: `cd external-adapter && npm test`
- **Smart Contracts**: `cd arbiter-operator && npm test`

#### Integration Tests
```bash
# Run full integration test suite
cd testing-tool
npm test

# Test specific scenarios
npm run test:basic-arbitration
npm run test:classid-validation
```

#### Manual Testing
```bash
# Test installer (in clean environment)
./installer/bin/install.sh --skip-tests

# Test ClassID integration
cd ai-node
npm run test-classid
```

---

## Pull Request Process

### PR Requirements

✅ **Must Have:**
- Descriptive title and description
- Tests for new functionality
- Documentation updates
- No merge conflicts
- All CI checks passing

⚠️ **Should Have:**
- Link to related issue
- Screenshots/examples for UI changes
- Performance impact notes
- Breaking change warnings

### Review Process

1. **Automated Checks**: CI runs tests, linting, security scans
2. **Core Team Review**: At least one core-dev approval required
3. **Feedback Loop**: Address review comments promptly
4. **Final Approval**: Core team merges when ready

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(ai-node): add ClassID model pool integration

fix(installer): resolve Docker permission issues on macOS

docs(contributing): add development setup guide

test(external-adapter): add integration tests for IPFS upload
```

---

## Areas for Contribution

### 🚀 High Priority
- **Performance Optimization**: AI model response times, gas efficiency
- **Security Enhancements**: Input validation, error handling
- **Documentation**: API docs, troubleshooting guides
- **Testing**: Integration tests, edge case coverage

### 🛠️ Medium Priority  
- **Developer Experience**: Better error messages, debugging tools
- **Monitoring**: Metrics, logging, alerting
- **Compatibility**: Support for additional AI providers
- **Automation**: CI/CD improvements, deployment scripts

### 💡 Ideas Welcome
- **New Features**: Novel arbitration mechanisms
- **Integrations**: Support for new blockchain networks
- **Tools**: Development utilities, testing frameworks
- **Examples**: Sample applications, tutorials

---

## Getting Help

### Before Asking
1. Check existing [Issues](https://github.com/verdikta/verdikta-arbiter/issues)
2. Search [Discussions](https://github.com/verdikta/verdikta-arbiter/discussions)
3. Review [documentation](https://docs.verdikta.com/)

### How to Ask
- **Issues**: Bug reports, feature requests
- **Discussions**: Questions, ideas, general help
- **Discord**: Real-time community support
- **Email**: security@verdikta.org (security issues only)

### Issue Templates
When creating issues, use our templates:
- 🐛 **Bug Report**: Describe the problem
- ✨ **Feature Request**: Propose new functionality  
- 📚 **Documentation**: Improve or add docs
- 🔒 **Security**: Report security vulnerabilities (privately)

---

## Code of Conduct

We are committed to fostering a welcoming, inclusive community. By participating, you agree to:

- **Be Respectful**: Treat all community members with respect
- **Be Constructive**: Provide helpful feedback and suggestions
- **Be Patient**: Remember that everyone is learning
- **Be Professional**: Keep discussions focused and productive

**Unacceptable behavior includes:**
- Harassment, discrimination, or offensive comments
- Spam, trolling, or disruptive behavior  
- Sharing private information without permission
- Any illegal or unethical activities

**Enforcement**: Violations may result in warnings, temporary bans, or permanent removal from the project.

---

## License

By contributing to Verdikta-Arbiter, you agree that your contributions will be licensed under the same license as the project. See [LICENSE](../LICENSE) for details.

---

## Recognition

Contributors are recognized in several ways:
- Listed in [CONTRIBUTORS.md](../CONTRIBUTORS.md)
- Mentioned in release notes for significant contributions
- Invited to join contributor discussions
- Eligible for contributor rewards and recognition

Thank you for helping make Verdikta better! 🙏
