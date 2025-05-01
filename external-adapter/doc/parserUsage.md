# Manifest Parser Usage Guide

## Table of Contents

1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Usage](#usage)
    - [Importing the Parser](#importing-the-parser)
    - [Parsing a Manifest](#parsing-a-manifest)
5. [Manifest Specification](#manifest-specification)
    - [Structure](#structure)
    - [Primary File Format](#primary-file-format)
    - [Key Fields](#key-fields)
6. [Output Structure](#output-structure)
7. [Error Handling](#error-handling)
8. [Examples](#examples)
    - [Basic Parsing](#basic-parsing)
    - [Handling Multiple AI Models](#handling-multiple-ai-models)
    - [Parsing Additional and Support Sections](#parsing-additional-and-support-sections)
9. [Advanced Features](#advanced-features)
10. [Best Practices](#best-practices)
11. [Troubleshooting](#troubleshooting)
12. [Contributing](#contributing)
13. [License](#license)

---

## Introduction

The **Manifest Parser** is a versatile tool designed to parse `manifest.json` files contained within various archive formats such as 7z, ZIP, or TAR+GZIP. This parser facilitates the extraction and validation of essential metadata required for AI-based applications, ensuring that your data is correctly structured and adheres to the specified manifest schema.

---

## Prerequisites

Before using the Manifest Parser, ensure you have the following:

- **Node.js** (version 12 or higher)
- **npm** (Node Package Manager)

---

## Installation

To incorporate the Manifest Parser into your project, follow these steps:

1. **Clone the Repository:**

    ```bash
    git clone https://github.com/your-repo/manifest-parser.git
    cd manifest-parser
    ```

2. **Install Dependencies:**

    ```bash
    npm install
    ```

3. **Include in Your Project:**

    If you're using this parser as a module, ensure it's correctly imported into your project files.

---

## Usage

### Importing the Parser

First, import the `ManifestParser` into your project file:

```javascript
const manifestParser = require('./path/to/manifestParser');
```

### Parsing a Manifest

To parse a manifest file located within an extracted archive directory, use the `parse` method:

```javascript
(async () => {
  try {
    const parsedManifest = await manifestParser.parse('/path/to/extracted/archive');
    console.log(parsedManifest);
  } catch (error) {
    console.error('Error parsing manifest:', error.message);
  }
})();
```

**Parameters:**

- `extractedPath` (`string`): The file system path to the directory where the archive has been extracted, containing the `manifest.json` file.

**Returns:**

- A `Promise` that resolves to an object containing the parsed manifest data.

---

## Manifest Specification

### Structure

The `manifest.json` file must adhere to the following structure:

```json
{
  "version": "1.0",
  "primary": {
    "filename": "primary_query.json",
    // or
    "hash": "bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q"
  },
  "additional": [
    {
      "name": "dataset",
      "type": "CSV",
      "filename": "data.csv"
      // or for IPFS files
      "hash": "bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q",
      "type": "ipfs/cid",
      "description": "Optional description"
    }
  ],
  "support": [
    {
      "hash": {
        "cid": "bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q",
        "description": "Support file description",
        "id": 1234567890
      }
    }
  ],
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "GPT-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 3,
        "WEIGHT": 1.0
      }
    ],
    "ITERATIONS": 1
  }
}
```

### Primary File Format

The primary file must be a JSON file with the following structure:

```json
{
  "query": "Your query here",
  "references": ["reference1", "reference2"],
  "outcomes": ["outcome1", "outcome2"] // optional
}
```

If no outcomes are provided in the primary file, the parser will create default outcomes based on the `NUMBER_OF_OUTCOMES` parameter in the manifest.

### Key Fields

1. **version** (`string`): Indicates the manifest version. Defaults to `"1.0"`.

2. **primary** (`object`): Describes the primary file.
    - **filename** (`string`, optional): The name of the primary JSON file located within the archive.
    - **hash** (`string`, optional): A cryptographic hash (CID) for a primary file hosted externally.
    - *Note: Either `filename` or `hash` must be provided, not both.*

3. **additional** (`array`, optional): Lists additional supporting files.
    - Each entry includes:
        - **name** (`string`): A unique identifier for the additional file.
        - **type** (`string`): The file format descriptor (e.g., `UTF8`, `JPEG`, `CSV`, `ipfs/cid`).
        - **filename** (`string`, optional): The name of the file within the archive.
        - **hash** (`string`, optional): A cryptographic hash (CID) for IPFS-hosted files.
        - **description** (`string`, optional): Description of the file.
    - *Note: For each entry, provide either `filename` or `hash`, not both.*

4. **support** (`array`, optional): References external archives containing additional files.
    - Each entry includes:
        - **hash** (`object`): Object containing:
            - **cid** (`string`): The IPFS CID for the supporting archive.
            - **description** (`string`, optional): Description of the support file.
            - **id** (`number`, optional): Unique identifier for the support file.

5. **juryParameters** (`object`, optional): Details the AI jury configuration.
    - **NUMBER_OF_OUTCOMES** (`number`): The number of possible outcomes the AI will choose between.
    - **AI_NODES** (`array`): Describes the AI models involved in the jury.
        - Each entry includes:
            - **AI_MODEL** (`string`): The name of the AI model (e.g., `GPT-4`, `BERT`).
            - **AI_PROVIDER** (`string`): The provider of the AI model (e.g., `OpenAI`, `Google`).
            - **NO_COUNTS** (`number`): The number of instances for the AI model.
            - **WEIGHT** (`number`): The weight assigned to the AI model.
    - **ITERATIONS** (`number`): The number of iterations for the AI jury to run.

---

## Output Structure

Upon successful parsing, the `ManifestParser` returns an object with the following structure:

```javascript
{
  prompt: "Your query extracted from the primary file",
  models: [
    {
      provider: "AI Provider Name",
      model: "AI Model Name",
      weight: 1.0,
      count: 3
    }
    // More models...
  ],
  iterations: 1,
  additional: [
    {
      name: "uniqueName",
      type: "FileType",
      filename: "fileName.txt",
      hash: "optionalHash"
    }
    // More additional files...
  ],
  support: [
    {
      hash: "supportingArchiveHash"
    }
    // More support entries...
  ]
}
```

**Fields:**

- **prompt** (`string`): The query extracted from the primary file.
- **models** (`array`): Details of the AI models configured in the `juryParameters`.
- **iterations** (`number`): Number of iterations for the AI jury process.
- **additional** (`array`, optional): List of additional supporting files.
- **support** (`array`, optional): List of external supporting archives.

---

## Error Handling

The `ManifestParser` throws descriptive errors for various failure scenarios. Ensure to handle these errors gracefully in your application.

**Common Errors:**

1. **Missing Required Fields:**
    - *Error Message:* `Invalid manifest: missing required fields "version" or "primary"`
    - *Cause:* The `manifest.json` lacks either the `version` or `primary` fields.

2. **Invalid JSON:**
    - *Error Message:* `Invalid JSON in manifest file: [details]`
    - *Cause:* The `manifest.json` contains malformed JSON.

3. **Primary File Specification Issues:**
    - *Error Message:* `Invalid manifest: primary must have either "filename" or "hash", but not both`
    - *Cause:* Both or neither `filename` and `hash` are provided in the `primary` section.

4. **Missing QUERY in Primary Content:**
    - *Error Message:* `No QUERY found in primary file`
    - *Cause:* The primary file lacks a `QUERY` line.

5. **Unsupported External Primary Files:**
    - *Error Message:* `External primary files (hash-based) are not yet supported`
    - *Cause:* The `primary` section references an external file via `hash`, which is not currently handled by the parser.

6. **Unexpected File Paths:**
    - *Error Message:* `Unexpected file path: [filePath]`
    - *Cause:* The parser encounters a file path that isn't mocked or expected during testing.

**Usage Example with Error Handling:**

```javascript
const manifestParser = require('./path/to/manifestParser');

(async () => {
  try {
    const parsedManifest = await manifestParser.parse('/path/to/extracted/archive');
    console.log('Parsed Manifest:', parsedManifest);
  } catch (error) {
    console.error('Error parsing manifest:', error.message);
    // Additional error handling logic...
  }
})();
```

---

## Examples

### Basic Parsing

**Manifest (`manifest.json`):**

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
        "AI_MODEL": "GPT-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 3,
        "WEIGHT": 1.0
      }
    ],
    "ITERATIONS": 1
  }
}
```

**Primary File (`primary_query.json`):**

```json
{
  "query": "Your query here",
  "references": ["reference1", "reference2"],
  "outcomes": ["outcome1", "outcome2"] // optional
}
```

**Usage:**

```javascript
const manifestParser = require('./manifestParser');

(async () => {
  try {
    const result = await manifestParser.parse('/mock/path');
    console.log(result);
  } catch (error) {
    console.error(error.message);
  }
})();
```

**Output:**

```javascript
{
  prompt: 'Your query here',
  models: [
    {
      provider: 'OpenAI',
      model: 'GPT-4',
      weight: 1.0,
      count: 3
    }
  ],
  iterations: 1
}
```

---

### Handling Multiple AI Models

**Manifest (`manifest.json`):**

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
        "AI_MODEL": "GPT-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 2,
        "WEIGHT": 0.7
      },
      {
        "AI_MODEL": "BERT",
        "AI_PROVIDER": "Google",
        "NO_COUNTS": 1,
        "WEIGHT": 0.3
      }
    ],
    "ITERATIONS": 2
  }
}
```

**Primary File (`primary_query.json`):**

```json
{
  "query": "Your query here",
  "references": ["reference1", "reference2"],
  "outcomes": ["outcome1", "outcome2"] // optional
}
```

**Usage:**

```javascript
const manifestParser = require('./manifestParser');

(async () => {
  try {
    const result = await manifestParser.parse('/mock/path');
    console.log(result);
  } catch (error) {
    console.error(error.message);
  }
})();
```

**Output:**

```javascript
{
  prompt: 'Your query here',
  models: [
    {
      provider: 'OpenAI',
      model: 'GPT-4',
      weight: 0.7,
      count: 2
    },
    {
      provider: 'Google',
      model: 'BERT',
      weight: 0.3,
      count: 1
    }
  ],
  iterations: 2
}
```

---

### Parsing Additional and Support Sections

**Manifest (`manifest.json`):**

```json
{
  "version": "1.0",
  "primary": {
    "filename": "transcript.txt"
  },
  "additional": [
    {
      "name": "transcript",
      "type": "UTF8",
      "filename": "transcript.txt"
    }
  ],
  "support": [],
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 3,
    "AI_NODES": [
      {
        "AI_MODEL": "Whisper",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 5,
        "WEIGHT": 0.8
      },
      {
        "AI_MODEL": "DeepSpeech",
        "AI_PROVIDER": "Mozilla",
        "NO_COUNTS": 2,
        "WEIGHT": 0.2
      }
    ],
    "ITERATIONS": 2
  }
}
```

**Transcript File (`transcript.txt`):**

```
REF:audioFile
QUERY: Transcribe the provided audio file and determine the speaker's sentiment (Positive, Neutral, Negative).
```

**Usage:**

```javascript
const manifestParser = require('./manifestParser');

(async () => {
  try {
    const result = await manifestParser.parse('/mock/path');
    console.log(result);
  } catch (error) {
    console.error(error.message);
  }
})();
```

**Output:**

```javascript
{
  prompt: "Transcribe the provided audio file and determine the speaker's sentiment (Positive, Neutral, Negative).",
  models: [
    {
      provider: 'OpenAI',
      model: 'Whisper',
      weight: 0.8,
      count: 5
    },
    {
      provider: 'Mozilla',
      model: 'DeepSpeech',
      weight: 0.2,
      count: 2
    }
  ],
  iterations: 2,
  additional: [
    {
      name: 'transcript',
      type: 'UTF8',
      filename: 'transcript.txt'
    }
  ],
  support: []
}
```

---

## Advanced Features

### Handling External Primary Files (`hash`)

Currently, the `ManifestParser` prioritizes the `filename` field for primary files and does not support fetching external files via `hash`. Future enhancements may include:

- **Fetching External Files:**
    - Implement functionality to retrieve external files using the provided `hash`.
    - Integrate with APIs or storage services that can resolve and fetch files based on their CIDs (Content Identifiers).

- **Enhanced Error Handling:**
    - Provide clear error messages and fallback mechanisms when external files cannot be retrieved.

### Validating `additional` and `support` Entries

Ensure each entry in the `additional` and `support` sections adheres to the required structure:

- **`additional`:**
    - Must include `name` and `type`.
    - Must include either `filename` or `hash`, not both.

- **`support`:**
    - Must include `hash`.

Implement validation logic within the parser to enforce these rules, throwing descriptive errors when violations occur.

---

## Best Practices

1. **Consistent Manifest Structure:**
    - Ensure all required fields are present and correctly formatted in `manifest.json`.
    - Maintain consistency in key naming (uppercase as specified).

2. **Error Handling:**
    - Always handle potential errors when parsing manifests to prevent application crashes.
    - Use try-catch blocks around parser usage to gracefully manage failures.

3. **Use of Test Fixtures:**
    - For comprehensive testing, utilize separate JSON files as fixtures to manage complex manifest scenarios.
    - This approach enhances maintainability and readability of your test suites.

4. **Documentation:**
    - Keep your manifest schemas and parser usage documentation up-to-date to assist current and future developers.
    - Document any custom extensions or modifications to the manifest structure.

5. **Version Control:**
    - Track changes to the manifest specification and parser to manage compatibility and upgrades effectively.
    - Utilize semantic versioning to indicate changes and backward compatibility.

---

## Troubleshooting

**Issue:** *Parser throws `No QUERY found in primary file`.*

- **Cause:** The primary file does not contain a line starting with `QUERY:`.
- **Solution:** Ensure that the primary file includes a properly formatted `QUERY:` line.

**Issue:** *Parser throws `Invalid JSON in manifest file`.*

- **Cause:** The `manifest.json` contains malformed JSON.
- **Solution:** Validate the JSON structure using tools like [JSONLint](https://jsonlint.com/) before parsing.

**Issue:** *Parser throws `Invalid manifest: missing required fields "version" or "primary"`.*

- **Cause:** The `manifest.json` is missing either the `version` or `primary` fields.
- **Solution:** Ensure that these fields are present and correctly named in the manifest.

**Issue:** *Parser throws `Invalid manifest: primary must have either "filename" or "hash", but not both`.*

- **Cause:** Both `filename` and `hash` are provided in the `primary` section.
- **Solution:** Update the manifest to include only one of these fields for the `primary` section.

---

## Contributing

Contributions are welcome! To contribute:

1. **Fork the Repository**
2. **Create a Feature Branch:**

    ```bash
    git checkout -b feature/YourFeatureName
    ```

3. **Commit Your Changes:**

    ```bash
    git commit -m "Add Your Feature"
    ```

4. **Push to the Branch:**

    ```bash
    git push origin feature/YourFeatureName
    ```

5. **Create a Pull Request**

Please ensure your code adheres to the existing style and includes relevant tests.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Contact

For any questions or support, please reach out to [support@example.com](mailto:support@example.com).