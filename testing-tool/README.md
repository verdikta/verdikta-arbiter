# Verdikta Testing Tool

A standalone testing tool for systematically evaluating Verdikta AI arbiters across multiple scenarios and jury configurations.

## Model Limitations

- **o3** does not support native PDF processing.
- **Claude models** do not support native internet searches if fed URLs.
- **Open source models** do not support PDF processing or internet searches.

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

### 4. Start AI Node

The testing tool requires only the AI node component to be running. Start it using:

```bash
cd ~/verdikta-arbiter-node/ai-node
./start.sh
```

This will:
- Start the AI node on port 3000
- Run in background mode with logging
- Create a PID file for process management

Verify the AI node is running:
```bash
# Check AI node health
curl http://localhost:3000/api/health

# Or use the testing tool status check
cd testing-tool
npm start status
```

### 5. Run Tests

**Note**: When using npm scripts, use `--` to pass arguments correctly:

```bash
# Run all scenarios against all juries
npm start -- test

# Run specific scenarios
npm start -- test --scenario-ids "energy-invest,product-launch"

# Run against specific juries  
npm start -- test --juries "1,2"

# Filter by tags
npm start -- test --tags "energy,investment"

# Dry run (validate without executing)
npm start -- test --dry-run
```

**Alternative: Use new convenience scripts:**
```bash
# Run all tests
npm run run-tests

# Check status
npm run status

# List juries
npm run juries

# View results
npm run results
```

**Or run directly:**
```bash
# Run node directly (no -- needed)
node src/index.js test --scenario-ids "energy-invest"
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
simple-decision,"Should we approve the budget increase?","Approve,Reject,Modify",,Approve,"budget,simple","Simple text-only decision"
```

**Required fields:**
- `scenario_id` - Unique identifier
- `prompt` - The decision prompt
- `outcomes` - Comma-separated possible outcomes

**Optional fields:**
- `attachment_archive` - ZIP file with scenario data (⭐ **NEW: Can be empty for text-only scenarios**)
- `expected_winner` - Expected outcome for validation
- `tags` - Comma-separated tags for filtering
- `notes` - Additional notes

### 🆕 Text-Only Scenarios (No Attachments)

You can now create scenarios that don't need supporting files! Just leave the `attachment_archive` field empty:

```csv
scenario_id,prompt,outcomes,attachment_archive,expected_winner,tags,notes
policy-decision,"Should we implement remote work policy?","Implement,Delay,Reject",,Implement,"policy,hr","Pure text decision"
budget-approval,"Approve Q4 marketing budget increase?","Approve,Reject,Modify",,,"budget,finance","Simple yes/no decision"
```

**Benefits:**
- ✅ Perfect for policy decisions, strategic choices, and text-based scenarios
- ✅ Faster testing (no archive processing needed)
- ✅ Simpler setup for basic decision scenarios
- ✅ Mixed scenarios - some with attachments, some without

## Attachment Archives

The testing tool supports two archive formats:

### 🆕 SIMPLIFIED FORMAT (Recommended)

Just include your attachment files with an optional simple manifest:

**Files in ZIP:**
- `supporting-document.txt`
- `chart.png`  
- `manifest.json` (optional)

**Optional manifest.json:**
```json
{
  "format": "simplified",
  "name": "Energy Investment Attachments",
  "attachments": [
    {
      "filename": "supporting-document.txt",
      "name": "Supporting Document", 
      "type": "text/plain"
    },
    {
      "filename": "chart.png",
      "name": "Analysis Chart",
      "type": "image/png"
    }
  ]
}
```

**Benefits:**
- ✅ No dummy data required
- ✅ All query/jury configuration comes from CSV + jury config files
- ✅ Focus only on the actual attachments
- ✅ Auto-detection if no manifest provided

### LEGACY FORMAT (Backward Compatibility)

**⚠️ Contains dummy data that gets replaced**

Full manifest with jury parameters and primary query:

**manifest.json:**
```json
{
  "version": "1.0",
  "name": "Energy Investment Decision",
  "primary": {
    "filename": "primary.json"
  },
  "juryParameters": {
    "AI_NODES": [...],  // ❌ Gets replaced by jury config files
    "ITERATIONS": 1
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

**primary.json:**
```json
{
  "query": "...",        // ❌ Gets replaced by scenarios.csv prompt
  "outcomes": [...],     // ❌ Gets replaced by scenarios.csv outcomes
  "references": [...]
}
```

### Supporting Files (Both Formats)
- Images (JPG, PNG, WebP, GIF)
- Documents (PDF, TXT, RTF, DOC, DOCX)
- Data files (CSV, JSON)

## How Configuration Works

The testing tool uses a **three-layer configuration approach** that eliminates confusion:

### 📋 Layer 1: Scenarios CSV
**Defines the test cases and core query data**
- `prompt` - The main decision query sent to AI
- `outcomes` - Available decision options  
- `scenario_id`, `tags` - For organization and filtering

### 👥 Layer 2: Jury Configuration Files  
**Defines AI model panels and weightings**
- `models` - Which AI providers/models to use
- `iterations` - How many decision rounds
- Stored in `config/juries/N.json`

### 📎 Layer 3: Attachment Archives
**Contains only the supporting files**
- Images, documents, data files
- NO dummy query or jury data needed
- Focused purely on supplemental content

**✅ This approach means:**
- No conflicting configurations  
- No dummy data that gets ignored
- Clear separation of concerns
- Easy to maintain and understand

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
npm start -- init

# Run tests (note the -- for arguments)
npm start -- test [options]

# Check status
npm run status

# List jury configurations  
npm run juries

# View results
npm run results
```

### Test Options

```bash
# Scenario filtering
npm start -- test --scenario-ids "id1,id2"
npm start -- test --tags "energy,finance"
npm start -- test --scenarios custom-scenarios.csv

# Jury filtering
npm start -- test --juries "1,3"

# Validation
npm start -- test --dry-run
```

### Direct Node Commands (No `--` needed)

```bash
# Run directly with node
node src/index.js test --scenario-ids "energy-invest"
node src/index.js test --juries "1,2" --dry-run
node src/index.js juries
node src/index.js status
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
- Ensure AI node is started: `cd ~/verdikta-arbiter-node/ai-node && ./start.sh`
- Verify AI node is responding: `curl http://localhost:3000/api/health`
- Check `config/tool-config.json` settings match the AI node URL
- Verify API keys are configured in the AI node's `.env.local` file in the installation directory (`~/verdikta-arbiter-node/ai-node/.env.local`)

**"Archive not found"**
- Ensure ZIP files exist in `scenarios/attachments/`
- Check that archive filenames match those in scenarios CSV
- For simplified format: just include attachment files (manifest.json optional)
- For legacy format: ensure manifest.json and primary.json exist

**"Jury configuration invalid"**
- Check that model weights sum to 1.0
- Verify AI provider and model names are correct
- Ensure jury JSON files are valid

**"Archive format confusion"**
- For simple decisions: Use TEXT-ONLY (leave attachment_archive empty)
- For scenarios with files: Use SIMPLIFIED format (just attachments + optional manifest)
- Legacy format is for backward compatibility only
- The tool auto-detects format - no manual specification needed
- All query/jury data comes from CSV and jury config files, not archives

**"Do I need attachments for every scenario?"**
- No! Many scenarios work great as text-only (policy decisions, budget approvals, etc.)
- Only use attachments when you need supporting documents, images, or data files
- You can mix text-only and attachment scenarios in the same test run

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