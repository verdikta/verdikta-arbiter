module.exports = {
  testEnvironment: 'node',
  coverageProvider: 'v8',
  transform: {},
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 60000,
  setupFiles: ['<rootDir>/jest.setup.js'],
};
