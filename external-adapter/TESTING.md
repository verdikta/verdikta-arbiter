# Testing Guide for Chainlink AI External Adapter

## Prerequisites

Before running the tests, ensure you have:
1. Node.js (v14 or higher) installed
2. All dependencies installed by running:

```bash
npm install
npm install --save-dev supertest
```

## Running Tests

### 1. Running All Tests

To run all tests with default configuration:

```bash
npm test
```

### 2. Running Tests with Coverage

To run tests and generate a coverage report:

```bash
npm run test:coverage
```

The coverage report will be generated in the `coverage` directory. Open `coverage/lcov-report/index.html` in your browser to view the detailed report.

### 3. Running Tests in Watch Mode

For development, you can run tests in watch mode, which will automatically rerun tests when files change:

```bash
npm run test:watch
```

### 4. Running Specific Test Files

To run tests from a specific file:

```bash
npm test -- src/__tests__/handlers/evaluateHandler.test.js
```

To run tests matching a specific pattern:

```bash
npm test -- -t "should process a valid request"
```

## Test Structure

The tests are organized in the following directories:

```
src/__tests__/
├── helpers/
│   └── mockData.js         # Test data and mocks
├── utils/
│   └── archiveUtils.test.js
├── handlers/
│   └── evaluateHandler.test.js
└── integration/
    └── adapter.test.js
```

## Test Categories

1. **Unit Tests**
   - Location: `src/__tests__/utils/` and `src/__tests__/handlers/`
   - Test individual components in isolation
   - Run faster and help locate issues quickly

2. **Integration Tests**
   - Location: `src/__tests__/integration/`
   - Test multiple components working together
   - Verify external service interactions

## Mocking

The tests use Jest's mocking capabilities to mock:
- IPFS client
- AI Node interactions
- File system operations

Example of running tests with specific mocks:

```bash
MOCK_IPFS=true npm test
```

## Debugging Tests

### 1. Using Jest Debug Mode

Run tests with Node.js debugger:

```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

### 2. Verbose Output

Run tests with detailed output:

```bash
npm test -- --verbose
```

### 3. Test Environment Variables

Create a `.env.test` file for test-specific configuration:

```env
PORT=8081
IPFS_HOST=mock.ipfs.local
AI_NODE_URL=http://mock.ai.local
```

## Common Issues and Solutions

1. **Tests Timing Out**
   - Increase Jest timeout:
   ```bash
   npm test -- --testTimeout=10000
   ```

2. **Memory Issues**
   - Run tests with increased memory:
   ```bash
   node --max-old-space-size=4096 node_modules/.bin/jest
   ```

3. **Snapshot Issues**
   - Update snapshots if needed:
   ```bash
   npm test -- -u
   ```

## Continuous Integration

The test suite is configured to run in CI environments. Example GitHub Actions workflow:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '14'
      - run: npm ci
      - run: npm test
```

## Code Coverage Requirements

- Minimum coverage thresholds are set in `jest.config.js`:
  - Statements: 80%
  - Branches: 80%
  - Functions: 80%
  - Lines: 80%

## Writing New Tests

When adding new features, ensure to:
1. Create corresponding test files
2. Follow the existing test structure
3. Include both success and failure scenarios
4. Mock external dependencies
5. Update documentation if needed

Example test structure:

```javascript
describe('Component', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  describe('functionality', () => {
    it('should handle success case', () => {
      // Test
    });

    it('should handle error case', () => {
      // Test
    });
  });
});
```

## Test Reports

Generate a test report in JUnit format:

```bash
npm test -- --reporters=default --reporters=jest-junit
```

## Performance Testing

For performance-sensitive operations:

```bash
npm test -- --testNamePattern="performance" --runInBand
```

## Maintenance

### Regular Testing Tasks

1. Run the full test suite before pushing changes
2. Update test data when API contracts change
3. Review and update mocks when external services are modified
4. Monitor test coverage and add tests for new features

### Best Practices

1. Keep tests focused and atomic
2. Use descriptive test names
3. Maintain test data separately from test logic
4. Clean up resources after tests
5. Avoid test interdependencies

## Troubleshooting

### Common Error Messages

1. **"Cannot find module"**
   - Check node_modules is installed
   - Verify import paths are correct

2. **"Timeout exceeded"**
   - Increase timeout duration
   - Check for hanging async operations

3. **"Invalid mock"**
   - Verify mock implementation matches interface
   - Check mock timing and async behavior

### Debug Logging

Enable Jest debug logs:

```bash
DEBUG=jest npm test
```

## Additional Resources

1. [Jest Documentation](https://jestjs.io/docs/getting-started)
2. [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
3. [Chainlink Testing Guidelines](https://docs.chain.link/docs/architecture-testing-guidelines/)
```

This completed version of TESTING.md now includes:
- Proper code block formatting
- Additional sections for maintenance and troubleshooting
- Resources section
- Consistent formatting throughout
- Complete closing sections

Would you like me to add or modify any specific sections?