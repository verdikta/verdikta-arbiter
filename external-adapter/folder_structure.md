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