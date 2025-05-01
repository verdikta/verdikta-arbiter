# Multi-CID Feature

## Overview

The Multi-CID feature extends the Verdikta External Adapter to support processing multiple CIDs (Content Identifiers) in a single request. This enables more complex evaluation scenarios that combine information from multiple archives, such as disputes with multiple parties presenting their arguments.

## Key Features

- **Multiple Archive Processing**: Combine content from multiple IPFS archives in a single evaluation
- **Hierarchy of Information**: Clearly defined structure with a primary archive and supporting bCID archives
- **Addendum Support**: Include real-time data as an addendum to the query
- **Backward Compatibility**: Maintains full compatibility with existing single-CID requests

## Manifest Structure

To use the Multi-CID feature, the primary manifest must include:

1. A `name` field to identify the primary archive
2. A `bCIDs` object mapping names to descriptions for each blockchain CID
3. An optional `addendum` field that describes the addendum data

Example primary manifest:

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
        "AI_MODEL": "gpt-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 2,
        "WEIGHT": 0.7
      }
    ],
    "ITERATIONS": 1
  },
  "bCIDs": {
    "plaintiffArgument": "The plaintiff's argument regarding the dispute",
    "defendantRebuttal": "The defendant's rebuttal to the plaintiff's claims"
  },
  "addendum": "Current price of ETH in USD"
}
```

Each bCID archive should have its own manifest with a `name` field that matches the key in the primary manifest's `bCIDs` object:

```json
{
  "version": "1.0",
  "name": "plaintiffArgument",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "evidence-document",
      "type": "UTF8",
      "filename": "evidence.txt"
    }
  ]
}
```

### Primary Query File Format

All CIDs must have a primary query file in JSON format:

```json
{
  "query": "The query text for this CID",
  "references": ["reference1", "reference2"],
  "outcomes": ["outcome1", "outcome2"]
}
```

The `outcomes` field is optional and only required in the primary manifest. If not provided, default outcomes will be created based on the `NUMBER_OF_OUTCOMES` parameter in the manifest.

## API Request Format

To invoke the Multi-CID feature, provide a comma-separated list of CIDs, with an optional addendum string appended after a colon:

```json
{
  "id": "request-123",
  "data": {
    "cid": "PrimaryCID,bCID1,bCID2:Addendum string"
  }
}
```

### Examples

**Basic Multi-CID Request:**
```json
{
  "id": "dispute-evaluation",
  "data": {
    "cid": "QmabcMainCID,QmdefPlaintiffCID,QmghiDefendantCID"
  }
}
```

**With Addendum:**
```json
{
  "id": "eth-price-dispute",
  "data": {
    "cid": "QmabcMainCID,QmdefPlaintiffCID,QmghiDefendantCID:2,127.50"
  }
}
```

## How It Works

1. The adapter parses the CID string, extracting the primary CID, bCIDs, and addendum
2. Each CID is fetched and extracted in parallel
3. The primary manifest is validated and the bCIDs are verified against those listed in the manifest
4. Each manifest is parsed and validated
5. The query content from all archives is combined into a unified prompt
6. Any additional files from all archives are included
7. The addendum string is appended if provided
8. The AI evaluation proceeds with the combined content

## Combined Prompt Structure

The final combined prompt follows this structure:

```
[Primary Content from primary CID]

**
[Description from bCIDs]: 
Name: [bCID Name]
[Content from bCID1]

**
[Description from bCIDs]:
Name: [bCID Name]
[Content from bCID2]

References:
[bCID1 Name]: 
[References from bCID1]

[bCID2 Name]: 
[References from bCID2]

Addendum: 
[Addendum description]: [Addendum value]
```

This structured format ensures proper attribution of content and clear separation between different parts of the combined query, making it easier for the AI to understand the context and relationships between different pieces of information.

## Comprehensive Example

### Request

```json
{
  "id": "dispute-evaluation",
  "data": {
    "cid": "QmPrimaryCID,QmPlaintiffCID,QmDefendantCID:2009.67"
  }
}
```

### Primary Manifest (`QmPrimaryCID`)

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
        "AI_MODEL": "gpt-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 2,
        "WEIGHT": 0.7
      }
    ],
    "ITERATIONS": 1
  },
  "bCIDs": {
    "plaintiffComplaint": "the dispute launched by client X",
    "defendantRebuttal": "Rebuttal by vendor Y"
  },
  "addendum": "The price of Ethereum at the time of the dispute"
}
```

### Primary Query (`QmPrimaryCID/primary_query.json`)

```json
{
  "query": "There are two parties in a dispute. The plaintiff will make a case, then the defendant. You must choose which party is correct after weighing all of the data.",
  "references": [],
  "outcomes": ["Plaintiff", "Defendant"]
}
```

### Plaintiff Manifest (`QmPlaintiffCID`)

```json
{
  "version": "1.0",
  "name": "plaintiffComplaint",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "argument-transcript",
      "type": "UTF8",
      "filename": "transcript.txt"
    }
  ]
}
```

### Plaintiff Query (`QmPlaintiffCID/primary_query.json`)

```json
{
  "query": "You can tell from the transcript that I clearly told the defendant that I would only purchase 10 ETH from him if the price fell below $2000 by March 1, 2025",
  "references": ["argument-transcript"]
}
```

### Defendant Manifest (`QmDefendantCID`)

```json
{
  "version": "1.0",
  "name": "defendantRebuttal",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "emails-with-plaintiff",
      "type": "UTF8",
      "filename": "emails.txt"
    }
  ]
}
```

### Defendant Query (`QmDefendantCID/primary_query.json`)

```json
{
  "query": "Once you review the emails you will see that the Plaintiff agreed to purchase 10 ETH from me and though we discussed price fluctuation the price was not part of the agreement.",
  "references": ["emails-with-plaintiff"]
}
```

### Combined Query (Generated Internally)

The adapter generates a combined query like this:

```
There are two parties in a dispute. The plaintiff will make a case, then the defendant. You must choose which party is correct after weighing all of the data.

**
the dispute launched by client X:
Name: plaintiffComplaint
You can tell from the transcript that I clearly told the defendant that I would only purchase 10 ETH from him if the price fell below $2000 by March 1, 2025

**
Rebuttal by vendor Y:
Name: defendantRebuttal
Once you review the emails you will see that the Plaintiff agreed to purchase 10 ETH from me and though we discussed price fluctuation the price was not part of the agreement.

References:
plaintiffComplaint: 
argument-transcript

defendantRebuttal: 
emails-with-plaintiff

Addendum: 
The price of Ethereum at the time of the dispute: 2009.67
```

### Response

```json
{
  "jobRunID": "dispute-evaluation",
  "statusCode": 200,
  "status": "success",
  "data": {
    "aggregatedScore": [0.2, 0.8],
    "justificationCID": "QmResultJustification"
  }
}
```

## Error Handling

The feature includes robust error handling for common issues:

- **Missing bCIDs**: The adapter validates that the number of provided bCIDs matches the number listed in the primary manifest
- **Name Mismatches**: The adapter warns if a bCID archive's name doesn't match the expected name in the primary manifest
- **Malformed Input**: The adapter sanitizes the addendum string to prevent security issues
- **CID Access Failures**: The adapter provides clear error messages if any CID cannot be accessed or is invalid

## Backward Compatibility

The Multi-CID feature maintains full backward compatibility with existing single-CID requests. When only one CID is provided, the adapter processes it using the original flow without any changes to the existing API contract.

## Use Cases

- **Legal Disputes**: Present arguments from multiple parties (plaintiff/defendant)
- **Code Reviews**: Combine code and review comments from multiple contributors
- **Financial Evaluations**: Include market data as an addendum to financial analyses
- **Medical Second Opinions**: Combine multiple medical opinions with real-time patient data

## Implementation Considerations

- All archives must be valid and accessible via IPFS
- The primary CID must always be listed first
- The order of bCIDs matters and should match the order in the primary manifest
- The maximum number of CIDs depends on the complexity of the content and the AI model's context window
- Attachments from all archives are aggregated and sent to the AI service

## Performance Considerations

- Fetching multiple CIDs adds processing time proportional to the number of archives
- The adapter processes CIDs in parallel to minimize latency
- Large archives or many attachments may impact performance
- Consider the AI model's context window limitations when designing multi-CID requests

## Troubleshooting

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| `Number of bCIDs does not match` | The number of CIDs provided doesn't match the bCIDs in primary manifest | Ensure all required CIDs are included and match the manifest |
| `bCID manifest name does not match expected name` | A bCID archive has a name that doesn't match the primary manifest | Update the bCID manifest name to match the key in the primary manifest |
| `Failed to process CID` | A CID is invalid or inaccessible | Verify the CID is correct and accessible on IPFS |
| `Primary manifest is missing bCIDs section` | Multiple CIDs provided but primary manifest doesn't have bCIDs | Add a bCIDs section to the primary manifest |

## Example Scenario: ETH Price Dispute

Consider a dispute where:
1. The primary CID contains the dispute overview and evaluation criteria
2. The plaintiff CID presents an argument that they agreed to purchase ETH only if the price fell below $2,000
3. The defendant CID argues that the final agreement had no price condition
4. The addendum provides the actual ETH price on the agreement date

The adapter will fetch all three archives, combine their content, append the price as an addendum, and provide a unified evaluation of which party's position is correct based on all the evidence.

## Future Enhancements

Potential future improvements to the Multi-CID feature:

- Support for nested bCID hierarchies
- Dynamic weighting of content from different sources
- Query-specific processing instructions for each bCID
- Built-in conflict resolution between contradictory information 