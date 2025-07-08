# Verdikta Manifest.json Specification

**Version:** 2.0  
**Last Updated:** December 2024  
**Status:** Current Implementation  

## Overview

The `manifest.json` file is the core configuration file for Verdikta AI arbitration cases. It defines the structure, content references, and jury parameters for AI-based decision-making scenarios. This specification documents the current implementation as found in `manifestParser.js` and related validation schemas.

## Table of Contents

1. [Basic Structure](#basic-structure)
2. [Field Specifications](#field-specifications)
3. [Implementation Status](#implementation-status)
4. [Multi-CID Support](#multi-cid-support)
5. [File Format Support](#file-format-support)
6. [Examples](#examples)
7. [Validation Rules](#validation-rules)
8. [Migration Guide](#migration-guide)
9. [Known Limitations](#known-limitations)

---

## Basic Structure

### Minimal Required Manifest
```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  }
}
```

### Complete Manifest Structure
```json
{
  "version": "1.0",
  "name": "Case Identifier",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  },
  "additional": [
    {
      "name": "supportingDoc",
      "type": "text/plain",
      "filename": "document.txt",
      "description": "Supporting evidence"
    }
  ],
  "support": [
    {
      "hash": {
        "cid": "bafybeid...",
        "description": "External archive",
        "id": 1234567890
      }
    }
  ],
  "bCIDs": {
    "partyA": "Description of party A content",
    "partyB": "Description of party B content"
  },
  "addendum": "Real-time data description"
}
```

---

## Field Specifications

### Core Fields

#### `version` (Required)
- **Type:** String
- **Current Value:** `"1.0"`
- **Description:** Manifest format version identifier
- **Validation:** Must be present, typically `"1.0"`

#### `primary` (Required)
- **Type:** Object
- **Description:** Defines the primary query file for the case
- **Structure:**
  ```json
  {
    "filename": "primary_query.json"  // Local file reference
    // OR
    "hash": "bafybeid..."             // IPFS CID reference
  }
  ```
- **Validation:** Must contain either `filename` OR `hash`, but not both

### Optional Identification Fields

#### `name` (Optional)
- **Type:** String
- **Description:** Human-readable identifier for the case or archive
- **Usage:** Required for multi-CID scenarios to identify each archive
- **Example:** `"plaintiffComplaint"`, `"defendantRebuttal"`

### Jury Configuration

#### `juryParameters` (Optional)
- **Type:** Object
- **Description:** Defines the AI jury panel and decision parameters
- **Default Behavior:** If omitted, uses single GPT-4 model with default settings
- **Structure:**
  ```json
  {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI", 
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  }
  ```

##### `NUMBER_OF_OUTCOMES` (Optional)
- **Type:** Number
- **Default:** 2
- **Description:** Number of possible decision outcomes
- **Usage:** Used to generate default outcomes if not specified in primary file

##### `AI_NODES` (Optional)
- **Type:** Array
- **Description:** Defines the AI models in the jury panel
- **Default:** Single GPT-4 model
- **Each Node Structure:**
  ```json
  {
    "AI_MODEL": "gpt-4o",        // Model identifier
    "AI_PROVIDER": "OpenAI",     // Provider name  
    "NO_COUNTS": 1,              // Number of instances
    "WEIGHT": 0.5                // Voting weight (0.0-1.0)
  }
  ```

##### `ITERATIONS` (Optional)
- **Type:** Number
- **Default:** 1
- **Description:** Number of decision iterations to perform

### File References

#### `additional` (Optional)
- **Type:** Array
- **Description:** Additional supporting files for the case
- **Structure:**
  ```json
  [
    {
      "name": "uniqueIdentifier",
      "type": "image/jpeg",
      "filename": "local-file.jpg",
      "description": "Optional description"
    },
    {
      "name": "externalFile",
      "type": "ipfs/cid",
      "hash": "bafybeid...",
      "description": "IPFS-hosted file"
    }
  ]
  ```

**Field Details:**
- `name`: Unique identifier for referencing the file
- `type`: MIME type or format descriptor
- `filename`: Local file reference (mutually exclusive with `hash`)
- `hash`: IPFS CID reference (mutually exclusive with `filename`)
- `description`: Optional human-readable description

#### `support` (Optional)
- **Type:** Array
- **Description:** References to external archives containing additional evidence
- **Structure:**
  ```json
  [
    {
      "hash": {
        "cid": "bafybeid...",
        "description": "Archive description",
        "id": 1234567890
      }
    }
  ]
  ```

### Multi-CID Support

#### `bCIDs` (Optional)
- **Type:** Object
- **Description:** Maps blockchain CID names to descriptions for multi-party cases
- **Usage:** Enables combining multiple archives in a single evaluation
- **Structure:**
  ```json
  {
    "plaintiffComplaint": "The plaintiff's argument and evidence",
    "defendantRebuttal": "The defendant's counter-argument"
  }
  ```

#### `addendum` (Optional)
- **Type:** String  
- **Description:** Description of real-time data to be appended to the query
- **Usage:** Allows injection of current data (e.g., market prices) into the evaluation
- **Security:** Content is sanitized to prevent code injection

---

## Primary File Format

The primary file referenced in the `primary` section must be a JSON file with the following structure:

```json
{
  "query": "The main question or scenario to be evaluated",
  "references": ["ref1", "ref2"],
  "outcomes": ["option1", "option2"]
}
```

### Field Details:

#### `query` (Required)
- **Type:** String
- **Description:** The main decision prompt for the AI jury

#### `references` (Optional)
- **Type:** Array of Strings
- **Description:** References to additional files or external sources
- **Default:** Empty array

#### `outcomes` (Optional)
- **Type:** Array of Strings
- **Description:** Predefined decision options
- **Default Behavior:** If omitted, generates default outcomes based on `NUMBER_OF_OUTCOMES`
- **Generated Format:** `["outcome1", "outcome2", ...]`

---

## Implementation Status

### ✅ Fully Implemented Features

1. **Basic Manifest Parsing**
   - Required field validation (`version`, `primary`)
   - JSON structure validation
   - Error handling with descriptive messages

2. **Primary File Handling**
   - Local file references (`filename`)
   - IPFS CID references (`hash`)
   - JSON content parsing and validation

3. **Jury Configuration**
   - Multiple AI model support
   - Weight-based voting
   - Iteration control
   - Default configuration fallback

4. **Additional Files**
   - Local file references
   - IPFS CID fetching and caching
   - Multiple file type support

5. **Multi-CID Support**
   - Multiple archive processing
   - Hierarchical content combination
   - Name validation and mapping

6. **Addendum Support**
   - Real-time data injection
   - Content sanitization
   - Query augmentation

7. **Support Files**
   - External archive references
   - IPFS integration
   - Automatic file caching

### ⚠️ Partially Implemented Features

1. **Schema Validation**
   - Basic validation implemented
   - Joi schema defined but not fully enforced
   - Some edge cases may not be caught

### ❌ Known Limitations

1. **Hash-only Primary Files**
   - Implementation exists but may have edge cases
   - Limited testing in production scenarios

2. **Complex File Type Detection**
   - Basic MIME type support
   - Some specialized formats may not be recognized

3. **Validation Completeness**
   - Not all validation rules from schema are enforced
   - Some inconsistencies between validation and parser

---

## File Format Support

### Supported Formats

#### Images
- `image/jpeg` (.jpg, .jpeg)
- `image/png` (.png)
- `image/webp` (.webp)
- `image/gif` (.gif)

#### Documents  
- `text/plain` (.txt)
- `application/pdf` (.pdf)
- `application/rtf` (.rtf)
- `application/msword` (.doc)
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (.docx)

#### Data
- `text/csv` (.csv)
- `application/json` (.json)
- `text/markdown` (.md)

#### Special Types
- `UTF8` - Generic text content
- `ipfs/cid` - IPFS Content Identifier

---

## Examples

### 1. Basic Single-File Case

```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 1.0
      }
    ],
    "ITERATIONS": 1
  }
}
```

### 2. Multi-Model Jury Panel

```json
{
  "version": "1.0", 
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 3,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      },
      {
        "AI_MODEL": "claude-3-5-sonnet-20241022",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.5
      }
    ],
    "ITERATIONS": 1
  }
}
```

### 3. Case with Supporting Files

```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "supportingFile1",
      "type": "image/jpeg",
      "filename": "evidence.jpg",
      "description": "Photographic evidence"
    },
    {
      "name": "transcript",
      "type": "text/plain",
      "filename": "interview.txt",
      "description": "Witness testimony"
    }
  ],
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 1.0
      }
    ],
    "ITERATIONS": 1
  }
}
```

### 4. Multi-CID Complex Case

**Primary Manifest:**
```json
{
  "version": "1.0",
  "name": "Dispute over Eth price",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4o",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 1,
        "WEIGHT": 0.7
      },
      {
        "AI_MODEL": "claude-3-5-sonnet-20241022",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.3
      }
    ],
    "ITERATIONS": 1
  },
  "bCIDs": {
    "plaintiffComplaint": "The dispute launched by client X regarding ETH purchase",
    "defendantRebuttal": "Rebuttal by vendor Y regarding the ETH transaction"
  },
  "addendum": "The price of Ethereum at the time of the dispute"
}
```

**Secondary Archive Manifest:**
```json
{
  "version": "1.0",
  "name": "plaintiffComplaint",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "agreement-transcript",
      "type": "UTF8",
      "filename": "transcript.txt"
    }
  ]
}
```

### 5. IPFS-Based Case

```json
{
  "version": "1.0",
  "primary": {
    "hash": "bafybeidexample123"
  },
  "additional": [
    {
      "name": "externalEvidence",
      "type": "ipfs/cid",
      "hash": "bafybeidexample456",
      "description": "Evidence hosted on IPFS"
    }
  ],
  "support": [
    {
      "hash": {
        "cid": "bafybeidexample789",
        "description": "Supporting archive",
        "id": 1234567890
      }
    }
  ]
}
```

---

## Validation Rules

### Required Fields
- `version`: Must be present and non-empty string
- `primary`: Must be object with either `filename` or `hash`

### Validation Constraints  
- `primary`: Cannot have both `filename` and `hash`
- `additional[].name`: Must be unique within the array
- `juryParameters.AI_NODES[].WEIGHT`: Should sum to reasonable total (not enforced)
- `bCIDs`: Keys must match `name` field in corresponding archives

### Schema Validation (Joi)
The implementation includes a Joi schema that validates:
- Data types for all fields
- Required vs optional fields  
- Array structure for `additional` and `support`
- Object structure for nested fields

---

## Migration Guide

### From Legacy Documentation

If migrating from older manifest specifications:

1. **Field Renames:**
   - No major field renames identified
   - Structure has remained largely consistent

2. **New Features Added:**
   - `name` field for multi-CID support
   - `bCIDs` object for archive hierarchy
   - `addendum` field for real-time data
   - Enhanced IPFS support

3. **Deprecated Features:**
   - None identified - backward compatibility maintained

### Testing Tool Integration

The testing tool supports two manifest formats:

1. **Legacy Format:** Full manifest with all parameters
2. **Simplified Format:** Minimal manifest focusing on attachments

For testing tool usage, consider using the simplified format:
```json
{
  "format": "simplified",
  "name": "Test Case Name",
  "attachments": [
    {
      "filename": "file.txt",
      "name": "Test File",
      "type": "text/plain"
    }
  ]
}
```

---

## Error Handling

### Common Error Messages

1. **`Invalid manifest: missing required fields "version" or "primary"`**
   - **Cause:** Missing required root-level fields
   - **Solution:** Ensure both `version` and `primary` are present

2. **`Invalid manifest: primary must have either "filename" or "hash", but not both`**
   - **Cause:** Incorrect primary file specification
   - **Solution:** Use only `filename` OR `hash` in `primary` object

3. **`No QUERY found in primary file`**
   - **Cause:** Primary JSON file missing required `query` field
   - **Solution:** Add `query` field to primary file

4. **`Invalid JSON in manifest file`**
   - **Cause:** Malformed JSON syntax
   - **Solution:** Validate JSON syntax using a JSON validator

5. **`Failed to fetch primary file from IPFS`**
   - **Cause:** IPFS connectivity or invalid CID
   - **Solution:** Verify IPFS node connectivity and CID validity

### Best Practices for Error Prevention

1. **Always validate JSON syntax** before deployment
2. **Test IPFS connectivity** when using hash references
3. **Ensure file references exist** in the archive
4. **Use consistent naming** for multi-CID scenarios
5. **Validate weight totals** in jury configurations

---

## Performance Considerations

### File Processing
- Local files are read directly from filesystem
- IPFS files are fetched and cached locally
- Large files may impact processing time

### Multi-CID Processing
- Archives are processed sequentially
- Consider archive size when designing multi-CID cases
- Network latency affects IPFS-based content

### Recommendations
- Keep individual archives under 10MB when possible
- Use local files for frequently accessed content
- Cache IPFS content when reusing across cases
- Optimize image files for faster processing

---

## API Integration

### Parser Output Format

The manifest parser returns a structured object:

```javascript
{
  prompt: "Combined query text",
  models: [
    {
      provider: "OpenAI",
      model: "gpt-4o", 
      weight: 0.5,
      count: 1
    }
  ],
  iterations: 1,
  outcomes: ["outcome1", "outcome2"],
  name: "Case Name",
  addendum: "Addendum description",
  bCIDs: { /* bCID mappings */ },
  references: ["ref1", "ref2"],
  additional: [
    {
      name: "file1",
      type: "image/jpeg",
      filename: "file.jpg",
      path: "/absolute/path/to/file.jpg"
    }
  ],
  support: [
    {
      hash: "bafybeid...",
      path: "/absolute/path/to/cached/file"
    }
  ]
}
```

### Usage Example

```javascript
const manifestParser = require('./utils/manifestParser');

async function processCase(archivePath) {
  try {
    const parsed = await manifestParser.parse(archivePath);
    
    // Access parsed data
    console.log('Query:', parsed.prompt);
    console.log('Models:', parsed.models);
    console.log('Outcomes:', parsed.outcomes);
    
    return parsed;
  } catch (error) {
    console.error('Parsing failed:', error.message);
    throw error;
  }
}
```

---

## Conclusion

This specification documents the current state of the Verdikta manifest.json format as implemented in the codebase. The format has evolved to support complex multi-party arbitration scenarios while maintaining backward compatibility with simpler use cases.

For questions or clarifications regarding this specification, refer to:
- `external-adapter/src/utils/manifestParser.js` - Implementation source
- `external-adapter/src/utils/validator.js` - Validation schema  
- `external-adapter/src/__tests__/integration/fixtures/` - Test examples

**Note:** This specification reflects the actual implementation as of December 2024. The original `manifestFile-r3.docx` may contain outdated information and should be considered superseded by this document. 