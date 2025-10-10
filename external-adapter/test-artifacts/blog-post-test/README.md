# Blog Post Test - Setup Instructions

## Overview
This guide walks you through creating and uploading the test archives for the blog post evaluation test.

---

## Part 1: Work Product Submission Archive (Hunter's Submission)

### Step 1: Create Directory Structure
```bash
mkdir -p blog-post-submission
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
      "filename": "BlogPostSubmission.txt"
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

### Step 4: Add Your Blog Post Content
Create a file named `BlogPostSubmission.txt` and paste your blog post content into it.

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
      xxx  xx-xx-xxxx xx:xx   BlogPostSubmission.txt
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

**Note:** Replace `WORK_PRODUCT_CID` with the CID you got from Part 1, Step 6.

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
    "ITERATIONS": 1,
    "THRESHOLD": 90
  },
  "additional": [
    {
      "name": "gradingRubric",
      "type": "ipfs/cid",
      "hash": "QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz",
      "description": "Blog post grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {
    "submittedWork": "WORK_PRODUCT_CID"
  }
}
```

### Step 3: Create primary_query.json
Create a file named `primary_query.json` with this content:

```json
{
  "query": "EVALUATION REQUEST FOR ESCROW RELEASE\n\nYou are evaluating a blog post submission for payment release from escrow. The freelance writer has submitted a blog post for the Verdikta.org blog about the 'cravemakeover' project.\n\nTASK REQUIREMENTS:\nWrite a compelling, informative blog post for Verdikta.org about the cravemakeover project. The post should be engaging, well-structured, accurate, and suitable for publication on a professional technology blog.\n\nEVALUATION INSTRUCTIONS:\nThe grading rubric is provided as an attachment (gradingRubric). Please evaluate the submitted work product against all criteria in the rubric.\n\nIMPORTANT - FUNDING DECISION:\n- If the submission scores 90% or above based on the rubric criteria, vote FUND to release payment from escrow\n- If the submission scores below 90%, vote DONT_FUND to withhold payment\n\nProvide a detailed justification explaining your evaluation of each criterion and your final funding decision.\n\nThe submitted work product will be provided in the next section.",
  "references": ["gradingRubric"],
  "outcomes": ["DONT_FUND", "FUND"]
}
```

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

1. **RUBRIC_CID:** `QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz` (already exists)
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
- Example valid CID: `QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz`

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

## Next Steps

After completing the blog post test:
1. Document the CIDs in the test plan
2. Verify the evaluation results match expectations
3. Proceed to create the Fibonacci code evaluation test (Test 2)


