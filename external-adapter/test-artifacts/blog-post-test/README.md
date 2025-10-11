# Blog Post Test - Setup Instructions

## Overview
This guide walks you through creating and uploading the test archives for the blog post evaluation test.

**Note on Directory Hierarchies:** The Verdikta archive system fully supports nested directory structures within ZIP archives. You can organize files in subdirectories (e.g., `submission/`, `docs/`, `assets/`) for better organization, especially for complex work products with multiple files.

---

## Part 1: Work Product Submission Archive (Hunter's Submission)

### Step 1: Create Directory Structure
```bash
mkdir -p blog-post-submission/submission
cd blog-post-submission
```

### Step 2: Create manifest.json
Create a file named `manifest.json` with this content:

```json
{
  "version": "1.0",
  "name": "hunterSubmission",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "submitted-blogpost",
      "type": "text/plain",
      "filename": "submission/BlogPostSubmission.rtf"
    }
  ]
}
```

### Step 3: Create primary_query.json
Create a file named `primary_query.json` with this content:

```json
{
  "query": "Thank you for giving me the opportunity to write this blogpost for you. You can find it below in the references section.",
  "references": ["submitted-blogpost"]
}
```

**Note:** The `filename` field in the manifest supports subdirectories. In this example, the blog post is organized in a `submission/` directory for better organization.

### Step 4: Add Your Blog Post Content
Create a file at `submission/BlogPostSubmission.rtf` and paste your blog post content into it:
```bash
# Make sure you're in the blog-post-submission directory
touch submission/BlogPostSubmission.rtf
# Now edit submission/BlogPostSubmission.rtf with your blog post content
```

### Step 5: Create ZIP Archive
```bash
# Make sure you're in the blog-post-submission directory
zip -r ../hunterSubmission.zip .
cd ..
```

**Important:** The ZIP should contain the files at the root level, not nested in a folder.

Verify the contents:
```bash
unzip -l hunterSubmission.zip
```

Should show:
```
Archive:  hunterSubmission.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      xxx  xx-xx-xxxx xx:xx   manifest.json
      xxx  xx-xx-xxxx xx:xx   primary_query.json
      xxx  xx-xx-xxxx xx:xx   submission/BlogPostSubmission.rtf
---------                     -------
```

### Step 6: Upload to IPFS
```bash
# Option 1: Using ipfs CLI (if installed)
ipfs add hunterSubmission.zip

# Option 2: Using curl with a public gateway
curl -F "file=@hunterSubmission.zip" https://ipfs.infura.io:5001/api/v0/add

# Option 3: Use web UI at https://app.pinata.cloud or https://web3.storage
```

**📝 Save the CID:** After upload, save the returned CID. This is your `WORK_PRODUCT_CID`.

Example: `QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

---

## Part 2: Primary Archive (Task & Rubric Reference)

### Step 1: Create Directory Structure
```bash
mkdir -p blog-post-primary
cd blog-post-primary
```

### Step 2: Create manifest.json
Create a file named `manifest.json` with this content:

**Note:** The placeholder `REPLACE_WITH_WORK_PRODUCT_CID` will be replaced with the actual CID when you run the `create-archives.sh` script, or you can manually replace it with the CID from Part 1, Step 6.

```json
{
  "version": "1.0",
  "name": "Blog Post Evaluation for Payment Release",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-5-2025-08-07",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      },
      {
        "AI_MODEL": "claude-sonnet-4-20250514",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "gradingRubric",
      "type": "ipfs/cid",
      "hash": "QmV2qYpWoWBmcMpMEVHzv8wH9Gc8oUZdpagkKkcVqt7u4j",
      "description": "Blog post grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {
    "submittedWork": "REPLACE_WITH_WORK_PRODUCT_CID"
  }
}
```

### Step 3: Create primary_query.json
Create a file named `primary_query.json` with this content:

**Note:** This query format is designed to be generic and reusable. The AI node will prepend additional instructions about response format. The query should focus on describing the evaluation task without specifying thresholds (those are handled by the escrow smart contract).

```json
{
  "query": "WORK PRODUCT EVALUATION REQUEST\n\nYou are evaluating a work product submission to determine whether it meets the required quality standards for payment release from escrow.\n\n=== TASK DESCRIPTION ===\nWork Product Type: Blog Post\nTask Title: Blog Post for Verdikta.org\nTask Description: Write a compelling, informative blog post for Verdikta.org about 'The use of AI in dispute resolution'. The post should be engaging, well-structured, accurate, and suitable for publication on a professional technology blog.\n\n=== EVALUATION INSTRUCTIONS ===\nA detailed grading rubric is provided as an attachment (gradingRubric). You must thoroughly evaluate the submitted work product against ALL criteria specified in the rubric.\n\nFor each evaluation criterion in the rubric:\n1. Assess how well the work product meets the requirement\n2. Note specific strengths and weaknesses\n3. Consider the overall quality and completeness\n\n=== YOUR TASK ===\nEvaluate the quality of the submitted work product and provide scores for two outcomes:\n- DONT_FUND: The work product does not meet quality standards\n- FUND: The work product meets quality standards\n\nBase your scoring on the overall quality assessment from the rubric criteria. Higher quality work should receive higher FUND scores, while lower quality work should receive higher DONT_FUND scores.\n\nIn your justification, explain your evaluation of each rubric criterion and how the work product performs against the stated requirements.\n\nThe submitted work product will be provided in the next section.",
  "references": ["gradingRubric"],
  "outcomes": ["DONT_FUND", "FUND"]
}
```

**Customization Guide:** To adapt this for different work products, update the TASK DESCRIPTION section:
- **Work Product Type**: e.g., "Source Code", "Design Document", "Video Tutorial"
- **Task Title**: Brief descriptive title
- **Task Description**: Specific requirements and expectations for the work

**How This Works with the AI Node:**
1. The AI node receives this query from the manifest
2. It prepends standardized instructions (from `prePromptConfig.ts`) about response format:
   - Requires JSON response with `score` and `justification` fields
   - Score must be an array of integers summing to 1,000,000
   - Each outcome (DONT_FUND, FUND) receives a score
3. The AI evaluates quality and assigns scores (e.g., [300000, 700000] for FUND)
4. The evaluation result is returned to the caller
5. **The escrow smart contract** determines if payment should be released based on its own threshold rules

**Important:** The query should NOT mention specific thresholds. Let the AI focus on quality evaluation, and let the smart contract handle funding decisions.

### Step 4: Create ZIP Archive
```bash
# Make sure you're in the blog-post-primary directory
zip -r ../blogPostEvaluation.zip .
cd ..
```

Verify the contents:
```bash
unzip -l blogPostEvaluation.zip
```

Should show:
```
Archive:  blogPostEvaluation.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      xxx  xx-xx-xxxx xx:xx   manifest.json
      xxx  xx-xx-xxxx xx:xx   primary_query.json
---------                     -------
```

### Step 5: Upload to IPFS
```bash
# Same options as before
ipfs add blogPostEvaluation.zip
```

**📝 Save the CID:** After upload, save the returned CID. This is your `PRIMARY_CID`.

Example: `QmYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY`

---

## Part 3: Test Execution

### Required CIDs
You should now have three CIDs:

1. **RUBRIC_CID:** `QmV2qYpWoWBmcMpMEVHzv8wH9Gc8oUZdpagkKkcVqt7u4j` (Blog Post for Verdikta.org)
2. **WORK_PRODUCT_CID:** From Part 1, Step 6 (hunter's blog post submission)
3. **PRIMARY_CID:** From Part 2, Step 5 (evaluation task with rubric reference)

### Testing the Evaluation

Once you have both CIDs, you can test the evaluation with:

```bash
# Format: PRIMARY_CID,WORK_PRODUCT_CID
curl -X POST http://localhost:8080/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "PRIMARY_CID,WORK_PRODUCT_CID"
  }'
```

Replace `PRIMARY_CID` and `WORK_PRODUCT_CID` with your actual CIDs.

### Expected Response Structure

```json
{
  "result": {
    "outcome": "FUND" | "DONT_FUND",
    "confidence": 95,
    "justificationCID": "QmZZZ...",
    "votingDetails": {
      "votes": [
        {
          "provider": "OpenAI",
          "model": "gpt-5-2025-08-07",
          "vote": "FUND",
          "weight": 0.5
        },
        {
          "provider": "Anthropic",
          "model": "claude-sonnet-4-20250514",
          "vote": "FUND",
          "weight": 0.5
        }
      ],
      "weightedScore": {
        "DONT_FUND": 0,
        "FUND": 100
      }
    }
  }
}
```

---

## Troubleshooting

### ZIP Archive Issues
- Ensure files are at root level of ZIP, not nested in a folder
- Use `zip -r` to recursively include all files
- Verify with `unzip -l` before uploading

### IPFS Upload Issues
- If using Infura, you may need an API key for larger files
- Consider using Pinata (https://pinata.cloud) or Web3.Storage (https://web3.storage) for easier uploads
- Make sure files are under IPFS size limits (typically 100MB)

### CID Format
- CIDs should start with `Qm` (v0) or `bafy` (v1)
- Example valid CID: `QmV2qYpWoWBmcMpMEVHzv8wH9Gc8oUZdpagkKkcVqt7u4j`

### Manifest Validation
- Ensure all JSON is valid (use `jq` or JSON validator)
- Verify `bCIDs` reference matches the work product CID
- Check that `additional` section references correct rubric CID

---

## Quick Reference Commands

```bash
# Create work product archive
cd blog-post-submission
zip -r ../hunterSubmission.zip .
cd ..

# Create primary archive (after updating manifest with work product CID)
cd blog-post-primary
zip -r ../blogPostEvaluation.zip .
cd ..

# Upload to IPFS (example)
ipfs add hunterSubmission.zip
ipfs add blogPostEvaluation.zip

# Test evaluation
curl -X POST http://localhost:8080/evaluate \
  -H "Content-Type: application/json" \
  -d '{"cid": "PRIMARY_CID,WORK_PRODUCT_CID"}'
```

---

## Best Practices for Directory Organization

### Simple Work Products
For work products with just a few files, a flat structure works well:
```
archive.zip
├── manifest.json
├── primary_query.json
└── document.txt
```

### Complex Work Products
For work products with multiple files, use subdirectories:
```
archive.zip
├── manifest.json
├── primary_query.json
├── submission/
│   ├── BlogPostSubmission.rtf
│   └── cover-letter.txt
├── assets/
│   ├── diagram.jpg
│   └── screenshot.png
└── research/
    └── sources.txt
```

### Recommended Directory Conventions
- `submission/` - Main work product files
- `src/` or `code/` - Source code files
- `docs/` - Documentation and explanations
- `tests/` - Test files and test results
- `assets/` or `media/` - Images, videos, and other media
- `data/` - Data files, datasets, or test data
- `research/` - Research materials, references, sources

### Example: Multi-File Manifest
```json
{
  "version": "1.0",
  "name": "ComplexSubmission",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "main-document",
      "type": "text/plain",
      "filename": "submission/report.txt"
    },
    {
      "name": "supporting-image",
      "type": "image/jpeg",
      "filename": "assets/diagram.jpg"
    },
    {
      "name": "research-notes",
      "type": "text/plain",
      "filename": "research/notes.txt"
    }
  ]
}
```

---

## Next Steps

After completing the blog post test:
1. Document the CIDs in the test plan
2. Verify the evaluation results match expectations
3. Proceed to create the Fibonacci code evaluation test (Test 2)


