# Chainlink External Adapter for AI Dispute Resolution

This external adapter serves as a bridge between Chainlink nodes and an AI-based dispute resolution system. It processes evidence stored on IPFS and facilitates AI evaluation of disputes.

## Features

- IPFS integration for evidence handling
- AI Node interaction for dispute evaluation
- Robust error handling and retry mechanisms
- Comprehensive logging
- Full test coverage

## Project Structure

```
chainlink-ai-adapter/
├── .env.example                 # Example environment variables
├── .gitignore                  # Git ignore file
├── package.json                # Project dependencies and scripts
├── README.md                   # Project documentation
├── TESTING.md                  # Testing documentation
├── jest.config.js              # Jest configuration
│
├── src/                        # Source code
│   ├── index.js               # Application entry point
│   ├── config.js              # Configuration management
│   │
│   ├── handlers/              # Request handlers
│   │   └── evaluateHandler.js # Main evaluation handler
│   │
│   ├── services/              # External service clients
│   │   ├── ipfsClient.js      # IPFS interaction
│   │   └── aiClient.js        # AI Node interaction
│   │
│   ├── utils/                 # Utility functions
│   │   ├── archiveUtils.js    # Archive handling
│   │   ├── logger.js          # Logging configuration
│   │   └── validator.js       # Request validation
│   │
│   └── __tests__/            # Test files
│       ├── helpers/           # Test helpers
│       │   └── mockData.js    # Mock data for tests
│       │
│       ├── integration/       # Integration tests
│       │   └── adapter.test.js
│       │
│       ├── handlers/          # Handler tests
│       │   └── evaluateHandler.test.js
│       │
│       └── utils/             # Utility tests
│           └── archiveUtils.test.js
│
├── logs/                      # Log files
│   ├── error.log             # Error logs
│   └── combined.log          # All logs
│
└── tmp/                      # Temporary files directory
    └── .gitkeep              # Keep empty directory in git
```

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the root directory with the following variables:

```env
PORT=8080
HOST=0.0.0.0
IPFS_HOST=ipfs.infura.io
IPFS_PORT=5001
IPFS_PROTOCOL=https
IPFS_PROJECT_ID=your_project_id
IPFS_PROJECT_SECRET=your_project_secret
AI_NODE_URL=http://localhost:5000
```

## API Documentation

### POST /evaluate

Evaluates dispute evidence using AI.

#### Request Body

```json
{
  "id": "jobRunId-123456789",
  "data": {
    "cid": "Qm... (IPFS CID of the evidence archive)"
  }
}
```

#### Response

```json
{
  "jobRunId": "jobRunId-123456789",
  "status": "in_progress",
  "message": "Job received and processing"
}
```

For testing information, please refer to [TESTING.md](TESTING.md).