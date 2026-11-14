module.exports = {
  testEnvironment: 'node',
  transform: {},
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 60000,
  // code-runner has its own node_modules; runnerContract.test.js loads its sources
  // on this adapter's copy of the same pinned @verdikta/common.
  modulePaths: ['<rootDir>/node_modules'],
  setupFiles: ['<rootDir>/jest.setup.js'],
}; 