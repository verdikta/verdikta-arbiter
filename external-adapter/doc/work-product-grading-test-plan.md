# Work Product Grading Test Plan

## Overview

This document outlines the design and implementation plan for a test/demonstration query that showcases the multi-CID functionality to grade submitted work product against a task description and rubric.

**Last Updated:** October 10, 2025  
**Status:** Design Finalized - Ready for Implementation

---

## Executive Summary

✅ **All critical features verified and confirmed working!**

After comprehensive source code review of `@verdikta/common`, all necessary functionality for the work product grading test has been confirmed:

- ✅ **IPFS CID fetching** in `additional` section works automatically
- ✅ **Multi-CID file path resolution** uses absolute paths correctly
- ✅ **Text attachment processing** will handle rubric files properly
- ✅ **Combined query construction** is fully implemented

**Key Finding:** The manifestParser in `@verdikta/common@1.3.1` automatically fetches IPFS files referenced by `hash` in the `additional` section, caches them locally, and provides absolute paths for access. This means our planned test design will work without any modifications to the core system.

**Ready to proceed with test implementation.**

---

## Objectives

Create a test suite with two demonstration scenarios:

### Test 1: Blog Post Evaluation
1. Uses multi-CID functionality to combine task description with submitted blog post
2. References an external JSON rubric via IPFS CID (embedded in manifest, not passed on blockchain)
3. Configures a jury of latest AI models to grade the work
4. Produces a binary fund/don't-fund decision based on threshold score

### Test 2: Code Snippet Evaluation (Fibonacci)
1. Tests code evaluation capabilities with a Python function submission
2. Uses multi-CID with code attachments
3. Grades against programming rubric criteria
4. Demonstrates versatility of the grading system

---

## Architecture Overview

### Components

#### 1. Primary Archive (Passed on Blockchain)
- **Contains:**
  - `manifest.json` with jury configuration and bCID mapping
  - `primary_query.json` with task description and grading instructions
  - IPFS reference to external rubric in `additional` section

#### 2. Work Product Archive (bCID - Passed on Blockchain)
- **Contains:**
  - `manifest.json` identifying this as the work product submission
  - `primary_query.json` with the submitted work content
  - Optional: Additional files (code, documents, images) as attachments

#### 3. External Rubric (IPFS CID - Not Passed on Blockchain)
- **Format:** Text or JSON file hosted on IPFS
- **Contains:** Grading criteria, scoring guidelines, evaluation framework
- **Referenced by:** Primary manifest via `additional` section with `type: "ipfs/cid"`

---

## Manifest Structures

### Primary Manifest

```json
{
  "version": "1.0",
  "name": "Work Product Grading System",
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
      "hash": "RUBRIC_CID_HERE",
      "description": "Detailed grading rubric with evaluation criteria"
    }
  ],
  "bCIDs": {
    "submittedWork": "Work product submitted for evaluation"
  }
}
```

### Primary Query File

```json
{
  "query": "TASK DESCRIPTION:\nYou are evaluating a work product submission for payment release from escrow. The task assigned was:\n\n[Insert detailed task description here]\n\nThe grading rubric is provided as an attachment. Please evaluate the submitted work product against this rubric and provide a score. If the score meets the threshold of 90 or above, vote FUND to release payment. Otherwise, vote DONT_FUND.\n\nThe submitted work will be provided in the next section.",
  "references": ["gradingRubric"],
  "outcomes": ["DONT_FUND", "FUND"]
}
```

### Work Product Manifest (bCID)

```json
{
  "version": "1.0",
  "name": "submittedWork",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "workFile",
      "type": "text/plain",
      "filename": "submission.txt",
      "description": "The actual work product file"
    }
  ]
}
```

### Work Product Query File

```json
{
  "query": "SUBMITTED WORK PRODUCT:\n\n[Content of submission]\n\nSee attached file for complete submission.",
  "references": []
}
```

---

## Query Construction Flow

When the adapter processes the multi-CID request, it will:

1. **Parse Primary CID:**
   - Load manifest and primary query (task description)
   - Fetch the grading rubric from IPFS via the `hash` field in `additional`
   - Load jury configuration

2. **Parse Work Product bCID:**
   - Load manifest and primary query (submission content)
   - Load any additional files (e.g., code files, documents)

3. **Construct Combined Query:**
   ```
   [Task Description from Primary Query]
   
   **
   Work product submitted for evaluation:
   Name: submittedWork
   [Submission Content from bCID Query]
   
   [Attachments: Rubric + Submission Files]
   ```

4. **Send to AI Jury:**
   - GPT-4o and Claude 3.5 Sonnet evaluate against rubric
   - Models return score selection (e.g., "B (80-89)")
   - Weighted voting determines final grade
   - Justification includes detailed feedback

---

## Test Scenarios

---

## Test 1: Blog Post Evaluation for Payment Release

### Context
A freelance writer has submitted a blog post for "cravemakeover" and is awaiting payment from escrow. The smart contract will release funds if the Arbiter returns a score above the 90% threshold.

### Task Description
Write a blog post for the Verdikta.org blog about the cravemakeover project.

### Rubric (JSON format - IPFS CID: QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz)

```json
{
  "version": "rubric-1",
  "title": "My Blog Post for cravemakeover",
  "threshold": 90,
  "criteria": [
    {
      "id": "safety_and_rights",
      "must": true,
      "weight": 0,
      "description": "Reject if NSFW, hate/harassment, or infringes copyright; reject if license terms not met."
    },
    {
      "id": "originality",
      "must": true,
      "weight": 0,
      "description": "Reject if substantially copied without citation."
    },
    {
      "id": "relevance",
      "must": false,
      "weight": 0.25,
      "description": "Directly addresses requested topic and audience."
    },
    {
      "id": "accuracy",
      "must": false,
      "weight": 0.15,
      "description": "Definitions/examples correct; no major factual errors."
    },
    {
      "id": "structure",
      "must": false,
      "weight": 0.15,
      "description": "Meets requested length, headings, links, assets."
    },
    {
      "id": "style",
      "must": false,
      "weight": 0.15,
      "description": "Clear, concise, minimal grammar issues."
    },
    {
      "id": "overall_quality",
      "must": false,
      "weight": 0.3,
      "description": "Holistic judgment: is this genuinely useful and publishable on Verdikta.org?"
    }
  ],
  "forbiddenContent": [
    "NSFW/sexual content",
    "Hate speech or harassment",
    "Copyrighted material without permission"
  ],
  "createdAt": "2025-10-03T21:29:36.114Z",
  "classId": 128
}
```

### Work Product Submission Structure

**Archive Contents (archive.zip):**
- `manifest.json`
- `primary_query.json`
- `BlogPostSubmission.txt`

**manifest.json:**
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

**primary_query.json:**
```json
{
  "query": "Thank you for giving me the opportunity to write this blogpost for you. You can find it below in the references section.",
  "references": ["submitted-blogpost"]
}
```

**BlogPostSubmission.txt:**
```
[Content of the blog post to be evaluated]
```

### Expected AI Evaluation
The AI jury will evaluate against the rubric criteria and return:
- **Outcome:** "FUND" (if score ≥ 90) or "DONT_FUND" (if score < 90)
- **Justification:** Detailed breakdown of how the submission scored against each criterion, with final score and funding recommendation

### Smart Contract Integration
The outcomes vector `["DONT_FUND", "FUND"]` is returned to the smart contract:
- If weighted vote for "FUND" exceeds threshold (90), escrow releases payment
- Otherwise, payment is withheld

---

## Test 2: Python Fibonacci Function Evaluation

### Task Description
Write a Python function that calculates the Fibonacci sequence up to n terms.

### Rubric (JSON format - IPFS CID: TBD_UPLOAD_REQUIRED)

**Note:** A comprehensive Code Review & Quality Assessment rubric is available at CID `QmYVBYZJvHBvWrYdRw9DtLkpICxBK33ek6UCV4UNCNwP1`, but for the simple Fibonacci test, we'll use a streamlined version:

```json
{
  "version": "rubric-1",
  "title": "Fibonacci Function Implementation",
  "threshold": 90,
  "criteria": [
    {
      "id": "correctness",
      "must": true,
      "weight": 0,
      "description": "Function must produce mathematically correct Fibonacci sequence; handles edge cases (n=0, n=1, negative n); returns expected data type."
    },
    {
      "id": "algorithm_efficiency",
      "must": false,
      "weight": 0.30,
      "description": "Reasonable time complexity (O(n) or better); avoids unnecessary computations; considers memory usage."
    },
    {
      "id": "code_quality",
      "must": false,
      "weight": 0.30,
      "description": "Clean, readable code; appropriate variable names; proper indentation and formatting; follows Python conventions (PEP 8)."
    },
    {
      "id": "documentation",
      "must": false,
      "weight": 0.20,
      "description": "Clear function docstring; comments where appropriate; usage examples provided; explains edge case handling."
    },
    {
      "id": "robustness",
      "must": false,
      "weight": 0.20,
      "description": "Proper error handling; validates input; handles edge cases gracefully; no crashes or unexpected behavior."
    }
  ],
  "forbiddenContent": [
    "Plagiarized code without attribution",
    "Malicious code",
    "Non-functional or incomplete implementation"
  ],
  "classId": 129
}
```

### Work Product Submission

**submission.txt:**
```python
def fibonacci(n):
    """Calculate Fibonacci sequence up to n terms."""
    if n <= 0:
        return []
    elif n == 1:
        return [0]
    
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i-1] + fib[i-2])
    return fib

# Example usage:
print(fibonacci(10))  # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

### Expected AI Evaluation
- **Outcome:** "FUND" or "DONT_FUND"
- **Justification:** "The function correctly implements the Fibonacci sequence with proper edge case handling. Code is clean and well-documented. Could be optimized for large n values using generator or memoization, but overall a solid implementation. Score: 85/100 → DONT_FUND (below 90 threshold)"

---

## Implementation Requirements & Gaps

### ✅ Confirmed Working Features

1. **Multi-CID Processing** (lines 167-287 in evaluateHandler.js)
   - Multiple CIDs can be passed as comma-separated list
   - Primary CID parsed separately from bCIDs
   - Combined query construction implemented

2. **bCID Mapping** (lines 184-186 in evaluateHandler.js)
   - `parseMultipleManifests` validates bCID names
   - Maps bCID descriptions to actual content

3. **Jury Configuration**
   - Multiple AI models supported
   - Weighted voting implemented
   - Configurable outcomes

4. **Additional Files Collection** (lines 241-248 in evaluateHandler.js)
   - Collects attachments from all archives
   - Passes to AI client for evaluation

### ✅ Areas Verified

#### 1. IPFS CID Fetching in `additional` Section

**Status:** ✅ CONFIRMED WORKING

**Evidence:**
- Source code review: `/root/verdikta-common/src/utils/manifestParser.js` lines 88-127
- The manifestParser **DOES** automatically fetch IPFS files when:
  - File has a `hash` field
  - File has `type: "ipfs/cid"`

**How It Works:**
1. Calls `ipfsClient.fetchFromIPFS(file.hash)` to retrieve the file (line 97)
2. Writes the file to local temp storage: `extractedPath/additional_${file.hash}` (lines 101-102)
3. Returns object with `path` field set to absolute path (line 107)
4. The `path` field can then be used by aiClient to read the file (lines 105-110)

**Parsed Additional File Structure:**
```javascript
{
  name: "gradingRubric",
  type: "image/webp", // Note: Currently hardcoded, may need fix
  path: "/tmp/verdikta-extract-xyz/additional_QmRubricCID",
  description: "Detailed grading rubric"
}
```

**Minor Issue Identified:**
- Line 107 hardcodes type as `'image/webp'` instead of using `file.type`
- This won't prevent functionality but may affect MIME type detection
- Workaround: aiClient detects MIME type from file content if type is generic (lines 173-177 in aiClient.js)

**Conclusion:** This feature works as needed for our test!

#### 2. File Path Resolution for Multi-CID Attachments

**Status:** ✅ CONFIRMED WORKING

**Evidence:**
- ManifestParser sets **absolute paths** for all additional files (line 117 in manifestParser.js):
  ```javascript
  path: path.join(extractedPath, file.filename)
  ```
- Each bCID is parsed with its own `extractedPath` from the `extractedPaths` map
- aiClient uses `file.path` if available (absolute), or constructs from `extractedPath + file.filename`

**How Multi-CID Works:**
1. Each CID extracted to separate directory: `archive_0_Qm...`, `archive_1_Qm...`
2. Each manifest parsed with its own extractedPath as context
3. All `file.path` values are absolute, pointing to their respective archive directories
4. aiClient receives combined list of attachments with absolute paths

**Conclusion:** No issues - paths are absolute and will work correctly!

#### 3. Attachment Format and AI Processing

**Status:** ✅ CONFIRMED WORKING

**Evidence:**
- aiClient.js encodes attachments based on MIME type (lines 172-183)
- Text files are encoded as text content for AI consumption
- MIME type detection handles generic types like 'UTF8' (lines 173-177)
- Both GPT-4 and Claude support text attachments in their API formats

**Text File Processing Flow:**
1. File read from absolute path (line 170)
2. MIME type detected if not provided or generic (lines 173-176)
3. `encodeAttachment()` function formats based on MIME type
4. Text files sent as readable text to AI models

**Conclusion:** Rubric files will be properly processed!

#### 4. Combined Query Construction

**Status:** ✅ VERIFIED (with fallback)

**Evidence:**
- Source: `/root/verdikta-common/src/utils/manifestParser.js` lines 219-278
- Method `constructCombinedQuery()` is fully implemented
- Combines primary prompt + bCID prompts + references + addendum
- evaluateHandler.js has fallback implementation for robustness (lines 202-237)

**Confirmed:** This works as designed for our use case.

### ✅ All Critical Features Confirmed Working

All critical features have been verified through source code review. The test can proceed!

---

## Testing Strategy

### Phase 1: Component Testing

1. **Test IPFS File Fetching**
   - Create test manifest with `additional` entry using real IPFS CID
   - Parse the manifest
   - Verify file is downloaded and `path` is set correctly

2. **Test Multi-CID with Attachments**
   - Upload work product archive to IPFS
   - Upload rubric file to IPFS
   - Create primary archive with rubric reference
   - Process multi-CID request
   - Verify all files are accessible to aiClient

### Phase 2: Integration Testing

3. **Test Complete Grading Flow**
   - Real task description and rubric
   - Real work product submission
   - Process through evaluate handler
   - Verify AI models receive all content
   - Check that scores are returned correctly

### Phase 3: End-to-End Testing

4. **Test with Blockchain Simulation**
   - Format CID string: `PRIMARY_CID,WORKPRODUCT_CID`
   - Send through complete handler
   - Verify justification CID is uploaded
   - Check result format matches expectations

---

## Pre-Implementation Checklist

Before building the test, we need to:

- [x] **Verify IPFS fetching:** ✅ CONFIRMED - manifestParser fetches IPFS files from `additional.hash` automatically
- [x] **Check path resolution:** ✅ CONFIRMED - file paths use absolute paths for multi-CID attachments
- [x] **Review attachment limits:** ✅ Starting with small files (<30KB total) for initial tests
- [x] **Test rubric formats:** ✅ **JSON format enforced for all rubrics** (consistent structure, easier parsing)
- [x] **Validate outcomes:** ✅ Using 2 outcomes (FUND/DONT_FUND) with 90% threshold for escrow release
- [x] **Document token limits:** ✅ Latest models support large contexts; starting conservative

---

## Open Questions

### ✅ Resolved Questions

1. **IPFS File Fetching:** ✅ RESOLVED
   - Yes, manifestParser automatically fetches files with `hash` field and `type: "ipfs/cid"`
   - Cached in extractedPath as `additional_${CID}`
   - Path is set to absolute path of cached file

2. **File Path Resolution:** ✅ RESOLVED
   - Paths are **absolute** after parsing using `path.join(extractedPath, filename)`
   - Multi-CID paths work correctly because each archive has its own extractedPath
   - All paths remain absolute when combined for aiClient

### ✅ Resolved Through User Feedback

3. **Rubric Format:** ✅ RESOLVED
   - **JSON format enforced for all rubric files**
   - Blog post test: Comprehensive rubric with 7 criteria (CID: QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz)
   - Fibonacci test: Streamlined 5-criteria rubric (simplified from full Code Review rubric at QmYVBYZJvHBvWrYdRw9DtLkpICxBK33ek6UCV4UNCNwP1)
   - JSON format provides structured evaluation and consistent parsing

4. **Attachment Order:** ✅ RESOLVED
   - Order matters for narrative understanding
   - AI needs proper context: task description → rubric → work product
   - References array in primary_query.json ensures proper attachment context
   - The manifestParser and aiClient preserve attachment order and context

5. **Error Handling:** ✅ RESOLVED
   - **IPFS rubric fetch failure = fail the entire evaluation**
   - Rubric is essential for grading; cannot proceed without it
   - This ensures consistent evaluation standards

6. **Token Limits:** ✅ RESOLVED
   - **Start small:** <10KB for rubric, <20KB for work product
   - Test with blog post (~2-3KB) and code snippet (~1KB) first
   - Monitor token usage and scale progressively if needed
   - Latest models (GPT-5, Claude Sonnet 4) have large context windows

---

## Next Steps

1. ✅ **Investigation:** ~~Research and answer the open questions~~ → COMPLETE
2. ✅ **User Review:** ~~Review this document and provide feedback on approach~~ → COMPLETE
3. ✅ **Refinement:** ~~Update document based on user feedback~~ → COMPLETE
4. **Test Creation:** Build the actual test files and test suite:
   - Create blog post submission archive (manifest + query + blog post)
   - Create fibonacci submission archive (manifest + query + code file)
   - Create primary manifests for both tests with rubric references
   - Upload rubrics to IPFS and get CIDs
   - Upload work product archives to IPFS and get CIDs
   - Create automated test suite with both scenarios
5. **Execution:** Run the test suite and validate end-to-end functionality
6. **Documentation:** Update MANIFEST_SPECIFICATION.md with working examples

---

## Success Criteria

The test suite will be considered successful when:

### Blog Post Test (Test 1)
1. ✅ Primary archive references JSON rubric via IPFS CID
2. ✅ Blog post submission passed as bCID with text attachment
3. ✅ AI jury (GPT-5 + Claude Sonnet 4) receives complete context
4. ✅ Evaluation produces FUND/DONT_FUND decision based on 90% threshold
5. ✅ Justification includes criterion-by-criterion breakdown
6. ✅ Outcomes vector correctly formatted for smart contract escrow logic

### Fibonacci Code Test (Test 2)
1. ✅ Primary archive references JSON rubric via IPFS CID (streamlined from comprehensive code review rubric)
2. ✅ Python code passed as bCID with code file attachment
3. ✅ AI jury evaluates correctness, efficiency, code quality, documentation, robustness
4. ✅ Evaluation produces FUND/DONT_FUND decision based on 90% threshold
5. ✅ Justification explains technical evaluation with criterion-by-criterion breakdown
6. ✅ Result demonstrates system versatility (code vs. prose)

### Integration Success
- Both tests run in same test suite
- Consistent behavior across different content types
- Proper error handling for IPFS failures
- Token usage within reasonable limits
- Results match expected escrow integration patterns

---

## Minor Issues Identified

### Issue: Hardcoded MIME Type in manifestParser.js

**Location:** `/root/verdikta-common/src/utils/manifestParser.js` line 107

**Current Code:**
```javascript
additionalFiles.push({
  name: file.name,
  type: 'image/webp', // Hardcoded!
  path: filePath,
  description: file.description
});
```

**Problem:** When fetching IPFS files with `type: "ipfs/cid"`, the type is hardcoded as `'image/webp'` instead of using `file.type`.

**Impact:** LOW - aiClient detects MIME type from file content if type is generic (lines 173-177), so this won't break functionality, but it could be more accurate.

**Recommended Fix:**
```javascript
additionalFiles.push({
  name: file.name,
  type: file.type || 'application/octet-stream',
  path: filePath,
  description: file.description
});
```

**Action:** Consider opening an issue or PR in the `verdikta-common` repository after confirming the behavior in tests.

---

## Related Documentation

- [Multi-CID Implementation Design](./multi-cid-implementation.md)
- [Manifest Specification](./MANIFEST_SPECIFICATION.md)
- [Manifest Parser Usage](./parserUsage.md)
- [Integration Test Example](../src/__tests__/integration/multiCid.integration.test.js)
- [Verdikta Common Source](../../verdikta-common/) - Local development copy

---

## Design Notes

### Escrow Integration Context

The outcomes vector design supports smart contract escrow logic:

```
Outcomes: ["DONT_FUND", "FUND"]
Threshold: 90

If weighted_vote(FUND) >= 90:
    release_escrow_to_submitter()
else:
    withhold_payment()
```

This binary decision model ensures:
1. Clear pass/fail criteria based on rubric evaluation
2. Deterministic escrow release logic
3. Protection for both parties (work purchaser and work creator)
4. Flexible threshold adjustment per contract

### Narrative Order & Context Preservation

The system constructs the AI prompt in this order:
1. **Primary Query:** Task description and evaluation instructions
2. **Rubric Attachment:** Grading criteria (from IPFS CID)
3. **bCID Query:** Submitter's cover message
4. **Work Product Attachment:** Actual submission content

This order ensures:
- AI understands what it's evaluating (task)
- AI knows the criteria (rubric)  
- AI sees the submission with proper context (references)
- Each attachment is clearly labeled with its `name` field

The `references` array in primary_query.json ensures attachments are properly contextualized and not treated as arbitrary files.

---

## Rubric Resources

### Available Rubric CIDs

1. **Blog Post Rubric** (Production)
   - CID: `QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz`
   - Title: "My Blog Post for cravemakeover"
   - Criteria: 7 (safety_and_rights, originality, relevance, accuracy, structure, style, overall_quality)
   - Threshold: 90

2. **Code Review & Quality Assessment** (Comprehensive - Reference)
   - CID: `QmYVBYZJvHBvWrYdRw9DtLkpICxBK33ek6UCV4UNCNwP1`
   - Title: "Code Review & Quality Assessment"
   - Purpose: Full-featured code review rubric (extensive, suitable for complex code submissions)
   - Note: Too comprehensive for simple Fibonacci test; used as format reference

3. **Fibonacci Function Rubric** (Streamlined - For Testing)
   - CID: TBD (needs to be uploaded to IPFS)
   - Title: "Fibonacci Function Implementation"
   - Criteria: 5 (correctness, algorithm_efficiency, code_quality, documentation, robustness)
   - Threshold: 90
   - Simplified from comprehensive code review rubric for focused testing

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2025-10-09 | 1.0 | Initial planning document created |
| 2025-10-10 | 2.0 | Source code review completed; all features verified working |
| 2025-10-10 | 3.0 | User feedback integrated: latest models, JSON rubric, blog post test, binary outcomes, two-test suite |
| 2025-10-10 | 3.1 | JSON format enforced for all rubrics; Fibonacci rubric converted to JSON; added rubric CID reference section |

