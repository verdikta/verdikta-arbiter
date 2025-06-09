# Verdikta Testing Tool

A standalone testing tool for systematically evaluating Verdikta AI arbiters across multiple scenarios and jury configurations.

## Overview

The Verdikta Testing Tool allows you to:
- Test scenarios from CSV files against multiple AI jury configurations
- Compare decision outcomes across different AI models and weightings
- Generate comprehensive analysis reports and statistics
- Track performance and agreement patterns between juries
- Validate the consistency and reliability of AI arbiter decisions

## Features

- **CSV-based scenario management** - Define test scenarios in simple CSV format
- **Configurable AI juries** - Test against multiple jury configurations with different AI models
- **Attachment support** - Include images, documents, and other files via ZIP archives
- **Parallel testing** - Run the same scenarios against different juries for comparison
- **Comprehensive reporting** - Generate detailed analysis reports and agreement matrices
- **Progress tracking** - Real-time progress monitoring during test execution
- **Results persistence** - Save and analyze historical test runs

## Quick Start

### 1. Installation

```bash
cd testing-tool
npm install
```

### 2. Initialize

```bash
npm start init
```

This creates:
- Example jury configurations in `config/juries/`
- Example scenarios CSV in `scenarios/scenarios.csv`
- Example attachment archives in `scenarios/attachments/`
- Tool configuration in `config/tool-config.json`

### 3. Configure

Edit `config/tool-config.json` to point to your AI node:

```json
{
  "aiNodeUrl": "http://localhost:3000",
  "timeoutMs": 60000,
  "maxRetries": 3,
  "logLevel": "info"
}
```

### 4. Run Tests

```bash
# Run all scenarios against all juries
npm start test

# Run specific scenarios
npm start test --scenario-ids "energy-invest,product-launch"

# Run against specific juries
npm start test --juries "1,2"

# Filter by tags
npm start test --tags "energy,investment"

# Dry run (validate without executing)
npm start test --dry-run
```

## Directory Structure

```
testing-tool/
├── config/
│   ├── juries/           # Jury configurations (1.json, 2.json, etc.)
│   └── tool-config.json  # Tool settings
├── scenarios/
│   ├── scenarios.csv     # Test scenarios
│   └── attachments/      # ZIP archives with scenario data
├── results/              # Test run outputs
│   └── run-YYYY-MM-DD_HH-MM-SS/
│       ├── summary.json        # Complete test run data
│       ├── results.csv         # Results in CSV format
│       ├── detailed/           # Individual JSON results
│       └── analysis/           # Analysis reports
├── src/                  # Source code
└── logs/                 # Tool logs
```

## Scenario CSV Format

The scenarios CSV file defines your test cases:

```csv
scenario_id,prompt,outcomes,attachment_archive,expected_winner,tags,notes
energy-invest,"Should we invest in renewable energy?","Invest,Wait,Reject",energy-invest.zip,Invest,"energy,investment","Q3 strategic decision"
product-launch,"Launch new product line?","Launch,Delay,Cancel",product-launch.zip,Launch,"product,strategy","Market entry decision"
```

**Required fields:**
- `scenario_id` - Unique identifier
- `prompt` - The decision prompt
- `outcomes` - Comma-separated possible outcomes
- `attachment_archive` - ZIP file with scenario data

**Optional fields:**
- `expected_winner` - Expected outcome for validation
- `tags` - Comma-separated tags for filtering
- `notes` - Additional notes

## Attachment Archives

Each scenario requires a ZIP archive containing:

### manifest.json
```json
{
  "version": "1.0",
  "name": "Energy Investment Decision",
  "primary": {
    "filename": "primary.json"
  },
  "additional": [
    {
      "name": "Market Analysis",
      "filename": "market-report.pdf",
      "type": "application/pdf"
    }
  ]
}
```

### primary.json
```json
{
  "query": "Detailed scenario description and context...",
  "outcomes": ["Invest", "Wait", "Reject"],
  "references": [
    "Market research indicates...",
    "Financial projections show..."
  ]
}
```

### Supporting Files
- Images (JPG, PNG, WebP)
- Documents (PDF, TXT)
- Data files (CSV, JSON)

## Jury Configurations

Define AI juries in `config/juries/N.json`:

```json
{
  "id": 1,
  "name": "Conservative Financial Panel",
  "models": [
    {
      "AI_PROVIDER": "OpenAI",
      "AI_MODEL": "gpt-4",
      "WEIGHT": 0.6,
      "NO_COUNTS": 1
    },
    {
      "AI_PROVIDER": "Anthropic",
      "AI_MODEL": "claude-3-sonnet-20240229",
      "WEIGHT": 0.4,
      "NO_COUNTS": 1
    }
  ],
  "iterations": 1
}
```

## CLI Commands

### Core Commands

```bash
# Initialize tool with examples
npm start init

# Run tests
npm start test [options]

# Check status
npm start status

# List jury configurations
npm start juries

# View results
npm start results [--run <id>]
```

### Test Options

```bash
# Scenario filtering
npm start test --scenario-ids "id1,id2"
npm start test --tags "energy,finance"
npm start test --scenarios custom-scenarios.csv

# Jury filtering
npm start test --juries "1,3"

# Validation
npm start test --dry-run
```

## Analysis Reports

After each test run, the tool generates:

### results.csv
Flattened results for easy comparison in spreadsheet tools.

### analysis/jury-comparison.json
Performance and agreement statistics by jury.

### analysis/scenario-analysis.json
Consensus patterns and disagreement levels by scenario.

### analysis/agreement-matrix.json
Pairwise agreement percentages between all juries.

### analysis/performance.json
Execution times, success rates, and error analysis.

## Example Workflow

1. **Setup scenarios**: Define test cases in CSV
2. **Create archives**: Package scenario data with attachments
3. **Configure juries**: Define different AI panel compositions
4. **Run tests**: Execute scenarios against all juries
5. **Analyze results**: Review agreement patterns and performance
6. **Iterate**: Refine juries based on findings

## Integration with Verdikta

The testing tool leverages the existing Verdikta architecture:
- Uses the same **manifest.json** format as the external adapter
- Calls the AI node **rank-and-justify** endpoint directly
- Supports the same **attachment formats** and processing
- Compatible with existing **jury parameter** structures

## Development

```bash
# Install dependencies
npm install

# Run in development mode with auto-restart
npm run dev

# Run tests
npm test
```

## Troubleshooting

### Common Issues

**"Cannot connect to AI node"**
- Ensure AI node is running on the configured URL
- Check `config/tool-config.json` settings
- Verify API keys are configured in the AI node

**"Archive not found"**
- Ensure ZIP files exist in `scenarios/attachments/`
- Check that archive filenames match those in scenarios CSV
- Verify ZIP files contain valid manifest.json

**"Jury configuration invalid"**
- Check that model weights sum to 1.0
- Verify AI provider and model names are correct
- Ensure jury JSON files are valid

### Logging

Logs are written to `logs/testing-tool.log`. Set log level in configuration:

```json
{
  "logLevel": "debug"
}
```

## Support

For issues or questions about the testing tool, check:
1. This README and documentation
2. Log files in `logs/` directory
3. AI node status with `npm start status`
4. Example configurations created by `npm start init` 