// Load environment variables from .env file (if it exists)
try {
  require('dotenv').config();
} catch (e) {
  // .env file might not exist in repository folder, that's ok
}

// Set required environment variables for testing
process.env.OPERATOR_ADDR = process.env.OPERATOR_ADDR || '0xD47932CaC22d4F5557733619b83114CF82e3bF52';
process.env.TEST_MODE = 'false';
