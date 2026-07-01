# Architecture Overview

This document provides a technical overview of the Verdikta-Arbiter system architecture for contributors and developers.

## System Overview

```mermaid
graph TB
    subgraph "Client Layer"
        A[Client Applications<br/>e.g. bounty program]
    end

    subgraph "Aggregation Layer (verdikta-dispatcher repo)"
        J[ReputationAggregator<br/>ETH-funded, commit-reveal]
        RK[ReputationKeeper<br/>oracle registry + selection]
    end

    subgraph "Verdikta Arbiter Node (this repo)"
        I[ArbiterOperator<br/>Chainlink Operator contract]
        E[Chainlink Node<br/>directrequest job]
        D[External Adapter<br/>Chainlink bridge + IPFS]
        C[AI Node<br/>Next.js deliberation]
    end

    subgraph "AI Providers"
        F[OpenAI / Anthropic / xAI / Hyperbolic]
        H[Ollama local models]
        OR[OpenRouter fallback]
    end

    A -->|requestAIEvaluationWithApproval + ETH| J
    J --> RK
    RK -->|selects arbiters by classId| J
    J -->|OracleRequest| I
    I --> E
    E -->|verdikta-ai bridge| D
    D -->|POST /api/rank-and-justify| C
    C --> F
    C --> H
    C --> OR
    D -->|scores + justification CID| E
    E -->|fulfillOracleRequestV| I
    I -->|response| J
    J -->|getEvaluation| A
```

## Core Components

### AI Node (`ai-node/`)

**Technology**: Next.js 14, TypeScript, React
**Purpose**: Web interface and AI model orchestration

```typescript
// Actual request/response shape of POST /api/rank-and-justify
// (see ai-node/src/app/api/rank-and-justify/route.ts)
interface RankAndJustifyInput {
  prompt: string;
  outcomes?: string[];              // outcome labels
  models: {                         // the jury panel
    provider: string;               // 'OpenAI' | 'Anthropic' | 'xAI' | 'Hyperbolic' | 'Open-source' | ...
    model: string;
    weight: number;                 // 0..1
    count?: number;                 // repeat calls per model (averaged)
  }[];
  iterations?: number;              // deliberation rounds (default 1)
  attachments?: string[];           // base64 data URIs or raw text
}

interface RankAndJustifyOutput {
  scores: { outcome: string; score: number }[];  // integers summing to 1,000,000
  justification: string;
  metadata?: { models_requested: number; models_successful: number; success_threshold_met: boolean };
  model_results?: unknown[];        // per-model status/timing
  warnings?: unknown[];
}
```

**Key Features**:
- Multi-model deliberation system
- ClassID model pool integration
- Evidence processing (PDF, images, text)
- Real-time arbitration interface
- Result visualization and export

**API Endpoints**:
- `POST /api/rank-and-justify` - Core deliberation: runs the model panel, aggregates weighted scores (summing to 1,000,000), and generates a justification
- `POST /api/generate` - Single-model generation; `GET /api/generate` lists available providers/models
- `GET /api/health` - Health check
- `GET /api/test-hyperbolic` - Hyperbolic provider connectivity probe

### External Adapter (`external-adapter/`)

**Technology**: Node.js, Express, IPFS
**Purpose**: Chainlink external adapter for blockchain integration

```javascript
// The adapter is a plain Express endpoint (external-adapter/src/index.js).
// The Chainlink job's "verdikta-ai" bridge POSTs { id, data: { cid, aggId } }.
app.post('/evaluate', async (req, res) => {
  const result = await evaluateHandler(req.body); // handlers/evaluateHandler.js
  res.status(result.statusCode || 200).json(result);
});

// data.cid carries an optional mode prefix used by the aggregator's commit-reveal:
//   "Qm…"      → mode 0: evaluate now, upload justification, return scores + CID
//   "1:Qm…"    → mode 1 (commit): evaluate, store locally, return only a hash commitment
//   "2:<hash>" → mode 2 (reveal): upload the stored justification, return scores + "CID:salt"
// Comma-separated CIDs after the prefix trigger multi-CID (multi-party) evaluation.
```

**Key Features**:
- IPFS evidence retrieval (via `@verdikta/common`) and justification upload (Pinata JWT)
- Commit-reveal support (modes 0/1/2) so aggregated oracles can't copy each other
- Calls the AI Node's `/api/rank-and-justify`, formats scores + CID for the Chainlink job
- Retry logic with provider-error short-circuit
- Multi-CID archive support

### Chainlink Node (`chainlink-node/`)

**Technology**: Chainlink Core, PostgreSQL, Docker
**Purpose**: Oracle infrastructure for blockchain connectivity

**Configuration**:
```toml
[WebServer]
HTTPPort = 6688
SecureCookies = false

[Database] 
URL = "postgresql://chainlink:password@postgres:5432/chainlink"

[Log]
Level = "info"
```

### Smart Contracts (`arbiter-operator/`)

**Technology**: Solidity, Hardhat, OpenZeppelin
**Purpose**: On-chain arbitration logic and oracle management

This repo contains **`ArbiterOperator.sol`** — a Chainlink `Operator` extended with
multi-word responses and a ReputationKeeper access-control allow-list. It is the
per-node oracle contract, **not** the client-facing entry point.

```solidity
// arbiter-operator/contracts/ArbiterOperator.sol (Solidity 0.8.19)
contract ArbiterOperator is Operator, ERC165, IArbiterOperator {
    // Multi-word fulfillment: returns (uint256[] scores, string cid) to the consumer.
    function fulfillOracleRequestV(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    ) external returns (bool success);

    // ReputationKeeper allow-list (when empty, access control is disabled).
    function addReputationKeeper(address rk) external; // onlyOwner
    function isReputationKeeperListEmpty() external view returns (bool);
}
```

Clients never call `ArbiterOperator` directly. They call the **ETH-funded
`ReputationAggregator`** (in the separate `verdikta-dispatcher` repo), which
selects arbiters via the `ReputationKeeper` and dispatches `OracleRequest`s to
each selected `ArbiterOperator`:

```solidity
// verdikta-dispatcher: consumer-facing API (arbiters are paid in native ETH, no LINK)
function requestAIEvaluationWithApproval(
    string[] calldata cids, string calldata addendum,
    uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseFee,
    uint256 maxFeeScaling, uint64 jobClass
) external payable returns (bytes32 aggRequestId);

function getEvaluation(bytes32 aggRequestId)
    external view returns (uint256[] memory scores, string memory justificationCID, bool exists);
```

### Installation System (`installer/`)

**Technology**: Bash, Docker Compose, Node.js
**Purpose**: Automated deployment and configuration

**Flow**:
1. Prerequisites validation
2. Environment setup (Node.js, Docker, etc.)
3. Component installation (AI Node, Adapter, Chainlink)
4. Smart contract deployment
5. Service configuration and startup
6. Oracle registration with dispatcher

## Data Flow

### Arbitration Request Flow

A single arbiter's slice of the flow (the aggregator runs this across several
arbiters via commit-reveal and aggregates the responses):

```mermaid
sequenceDiagram
    participant C as Client
    participant AG as ReputationAggregator
    participant OP as ArbiterOperator
    participant CL as Chainlink Node
    participant EA as External Adapter
    participant AN as AI Node
    participant I as IPFS

    C->>AG: requestAIEvaluationWithApproval(cids, …) + ETH
    AG->>OP: OracleRequest (to each selected arbiter)
    OP->>CL: emit log → directrequest job
    CL->>EA: POST /evaluate { cid, aggId }
    EA->>I: fetch evidence archive(s)
    EA->>AN: POST /api/rank-and-justify
    AN->>AN: query model panel (parallel), weighted-aggregate to 1,000,000
    AN->>EA: scores + justification
    EA->>I: upload justification JSON → CID
    EA->>CL: { aggregatedScore[], justificationCid }
    CL->>OP: fulfillOracleRequestV(requestId, scores, cid)
    OP->>AG: response recorded (commit-reveal)
    C->>AG: getEvaluation(aggRequestId) → scores, justificationCID
```

### ClassID Integration Flow

```mermaid
graph LR
    A[ClassID Request] --> B[classMap.getClass()]
    B --> C[Validate Models]
    C --> D[Configure AI Node]
    D --> E[Update models.ts]
    E --> F[Pull Ollama Models]
    F --> G[Ready for Arbitration]
```

## Key Design Patterns

### Multi-Model Deliberation

The panel runs **in parallel** with per-model timeouts. `Promise.allSettled`
lets deliberation continue when some models fail: failed models are excluded
from score aggregation (but their notes are kept for the justification), and the
request only fails if fewer than `MIN_SUCCESSFUL_MODELS_PERCENT` (default 50%) of
models succeed. Successful decision vectors are combined with a weighted average
that sums to 1,000,000. A separate `JUSTIFIER_MODEL` then writes the final
justification. See `ai-node/src/app/api/rank-and-justify/route.ts`.

```typescript
// Simplified from the real route handler.
for (let i = 0; i < iterations; i++) {
  const settled = await Promise.allSettled(
    models.map(m => withTimeout(processModelForIteration(m, prompt, attachments), MODEL_TIMEOUT_MS))
  );
  const successful = settled.filter(isFulfilledAndParsed);
  if (successful.length < Math.ceil(models.length * MIN_SUCCESSFUL_MODELS_PERCENT)) {
    throw new Error('Insufficient successful models…'); // → HTTP 400
  }
  aggregatedScore = computeAverageVectors(successful.map(s => s.vector), weights); // sums to 1,000,000
}
justification = await generateJustification(aggregatedScore, justifications, justifierProvider, justifierModel);
```

### Evidence Processing Pipeline

Attachments arrive from the External Adapter as base64 data URIs or raw text.
Models with native document support (e.g. GPT-4o, Claude 4) receive attachments
directly; otherwise the AI Node extracts plain text first (PDF/RTF/DOCX/HTML/…)
to fit token budgets. See `ai-node/src/utils/attachment-processor.ts` and
`ai-node/src/lib/text-extraction/`.

```typescript
if (allModelsSupportNativePDF) {
  attachments = body.attachments.map(toLLMDocumentOrImage);   // pass through
} else {
  const { results, skippedCount } = await processAttachments(body.attachments, provider, model);
  attachments = convertToLLMFormat(results);                  // text extraction + skip-with-warning
}
```

### Error Handling Strategy

Two complementary layers:

```javascript
// External Adapter (external-adapter/src/services/aiClient.js):
// retry transient failures, but short-circuit provider errors (bad model/key)
const operation = retry.operation({ attempts: 3, factor: 2, minTimeout: 1000, maxTimeout: 4000 });
// … if (isProviderError) reject('PROVIDER_ERROR: …');  // no retry; surfaced as an error justification
```

```typescript
// AI Node: per-model + whole-request timeouts; a failed/unparseable model gets a
// neutral fallback vector and is excluded from aggregation rather than aborting the run.
// Whole-request timeout → HTTP 408; insufficient successful models → HTTP 400.
```

## Security Considerations

### Input Validation

Request and manifest validation is centralized in **`@verdikta/common`**
(Joi-based `validateRequest` / `requestSchema`, plus `manifestParser`), consumed
by the External Adapter. Per-ClassID limits are enforced via the shared ClassMap
— e.g. class 128 caps outcomes at 20, unique models at 5, iterations at 3, runs
per model at 2, and total evidence at 40 MB. The AI Node additionally validates
weights (`0 < totalWeight ≤ models.length`) and each model's shape before
invoking a provider.

```javascript
// external-adapter/src/handlers/evaluateHandler.js
const { createClient, validateRequest } = require('@verdikta/common');
await validateRequest(request);              // shape + required fields
const parsedManifest = await manifestParser.parse(extractedPath);
```

### API Security

- Rate limiting on all endpoints
- Input sanitization and validation
- CORS configuration for web interface
- API key validation for external access

### Smart Contract Security

- OpenZeppelin security patterns
- Access control for oracle functions
- Reentrancy protection
- Input validation on all public functions

## Performance Optimizations

### Request handling

- IPFS archives are fetched and extracted into a per-request temp workspace
  (`os.tmpdir()/verdikta-extract-*`) and cleaned up after each run.
- The model panel runs in parallel, bounded by `MODEL_TIMEOUT_MS` per model and
  `REQUEST_TIMEOUT_MS` for the whole request (justification generation has its own
  `JUSTIFICATION_TIMEOUT_MS`).
- Commit-reveal (mode 1/2) avoids recomputation on reveal: the mode-1 result is
  stored by the External Adapter (`commitStore`) and returned in mode 2.

> There is no model-response cache: each arbitration is computed fresh so that
> independent oracles produce independent responses.

### Resource Management

- Connection pooling for database and IPFS
- Request queuing for AI model calls
- Memory management for large evidence files
- Graceful shutdown handling

### Monitoring and Observability

```typescript
// Metrics collection
const metrics = {
  arbitrationRequests: new Counter('arbitration_requests_total'),
  responseTime: new Histogram('response_time_seconds'),
  modelErrors: new Counter('model_errors_total')
};

// Structured logging
logger.info('Arbitration completed', {
  requestId,
  classId,
  duration: Date.now() - startTime,
  modelCount: manifest.panel.length
});
```

## Extension Points

### Adding New AI Providers

1. Implement `LLMProvider` interface
2. Add provider to `LLMFactory`
3. Update model configuration
4. Add provider-specific tests

```typescript
interface LLMProvider {
  generateResponse(prompt: string, options: GenerationOptions): Promise<string>;
  supportsImages(): boolean;
  supportsAttachments(): boolean;
}
```

### Custom Evidence Processors

```typescript
interface EvidenceProcessor {
  canProcess(file: EvidenceFile): boolean;
  process(file: EvidenceFile): Promise<ProcessedContent>;
}

// Register custom processor
evidenceProcessorRegistry.register('custom-format', new CustomProcessor());
```

### Blockchain Network Support

1. Deploy contracts to new network
2. Update Chainlink node configuration  
3. Add network-specific environment variables
4. Test oracle functionality

## Development Guidelines

### Code Organization

```
src/
├── components/     # React UI components
├── lib/           # Core business logic
├── utils/         # Utility functions
├── types/         # TypeScript definitions
├── config/        # Configuration files
└── __tests__/     # Test files
```

### Testing Strategy

- **Unit Tests**: Individual component testing
- **Integration Tests**: Component interaction testing  
- **E2E Tests**: Full workflow testing
- **Contract Tests**: Smart contract functionality
- **Performance Tests**: Load and stress testing

### Documentation Standards

- JSDoc comments for all public APIs
- README files for each component
- Architecture Decision Records (ADRs)
- API documentation with examples
- Deployment and configuration guides

## Deployment Architecture

### Production Environment

A node is provisioned by the installer (`installer/bin/install.sh`), not from
published container images. The runtime layout on an operator host:

- **AI Node** and **External Adapter** run as Node.js processes (managed by
  `start-arbiter.sh` / `stop-arbiter.sh` in the install directory), on ports
  `3000` and `8080` respectively.
- **Chainlink Node** and **PostgreSQL** run as Docker containers (see
  `installer/bin/setup-docker.sh` and `installer/bin/setup-chainlink.sh`);
  Chainlink's UI is on port `6688`.
- **IPFS** is not self-hosted: evidence is fetched from public gateways and
  justifications are pinned to **Pinata** (`IPFS_PINNING_KEY`).
- Health and repair: `arbiter-status.sh` and `arbiter-doctor.sh` (`--fix`).

```bash
# Typical operator lifecycle (from the install directory, default ~/verdikta-arbiter-node)
./start-arbiter.sh      # start AI Node + External Adapter + Chainlink stack
./arbiter-status.sh     # check all services
./arbiter-doctor.sh     # health check (+ --fix)
./stop-arbiter.sh
```

### Scaling / decentralization

Rather than horizontally scaling a single node, the network achieves robustness
by running **many independent arbiters**. The `ReputationAggregator` selects a
pool per request (default K/M/N/P = 6/4/3/2) and aggregates their commit-reveal
responses, so no single node's availability or answer is decisive.

This architecture provides a robust, decentralized foundation for AI-powered
arbitration while maintaining security and performance standards.
