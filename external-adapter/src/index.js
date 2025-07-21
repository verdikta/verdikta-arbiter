// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const evaluateHandler = require('./handlers/evaluateHandler');

const app = express();
app.use(bodyParser.json());

// Create HTTP server to set connection limits
const server = require('http').createServer(app);
server.maxConnections = 1000;        // Handle more concurrent connections
server.timeout = 30000;              // 30 second timeout

// Update the route handler
app.post('/evaluate', async (req, res) => {
  try {
    const result = await evaluateHandler(req.body);
    res.status(result.statusCode || 200).json(result);
  } catch (error) {
    res.status(500).json({
      jobRunID: req.body?.id || 'unknown',
      status: 'errored',
      statusCode: 500,
      error: error.message || 'Unknown error'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    jobRunID: req.body?.id || 'unknown',
    status: 'errored',
    statusCode: 500,
    error: err.message || 'Internal server error'
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 