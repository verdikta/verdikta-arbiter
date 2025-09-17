# Architecture Overview

This document provides a technical overview of the Verdikta-Arbiter system architecture for contributors and developers.

## System Overview

```mermaid
graph TB
    subgraph "Client Layer"
        A[Client Applications]
        B[Web Interface]
    end
    
    subgraph "Verdikta Arbiter Node"
        C[AI Node<br/>Next.js App]
        D[External Adapter<br/>Chainlink Bridge]
        E[Chainlink Node<br/>Oracle Service]
    end
    
    subgraph "AI Providers"
        F[OpenAI GPT Models]
        G[Anthropic Claude]
        H[Ollama Local Models]
    end
    
    subgraph "Blockchain Layer"
        I[Arbiter Operator<br/>Smart Contract]
        J[Dispatcher Contract]
        K[Base Network]
    end
    
    A --> C
    B --> C
    C --> F
    C --> G  
    C --> H
    C --> D
    D --> E
    E --> I
    I --> J
    J --> K
```

## Core Components

### AI Node (`ai-node/`)

**Technology**: Next.js 14, TypeScript, React
**Purpose**: Web interface and AI model orchestration

```typescript
// Key interfaces
interface QueryManifest {
  outcomes: string[];
  panel: ModelSpec[];
  iterations: number;
  evidence: EvidenceFile[];
}

interface ArbitrationResult {
  outcomes: OutcomeRanking[];
  justification: string;
  metadata: ResultMetadata;
}
```

**Key Features**:
- Multi-model deliberation system
- ClassID model pool integration
- Evidence processing (PDF, images, text)
- Real-time arbitration interface
- Result visualization and export

**API Endpoints**:
- `POST /api/arbitrate` - Run arbitration query
- `POST /api/rank-and-justify` - Rank outcomes with justification  
- `GET /api/health` - Health check
- `GET /api/models` - Available AI models

### External Adapter (`external-adapter/`)

**Technology**: Node.js, Express, IPFS
**Purpose**: Chainlink external adapter for blockchain integration

```javascript
// Core adapter interface
const adapter = {
  name: 'Verdikta',
  execute: async (request, callback) => {
    const { manifest, classId } = request.data;
    const result = await processArbitration(manifest, classId);
    callback(result.statusCode, result);
  }
};
```

**Key Features**:
- IPFS evidence storage and retrieval
- Chainlink job execution
- Result formatting for blockchain
- Error handling and retry logic
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

```solidity
contract ArbiterOperator {
    struct ArbitrationRequest {
        bytes32 requestId;
        address requester;
        uint256 classId;
        string manifestCID;
        uint256 fee;
    }
    
    function requestArbitration(
        uint256 classId,
        string calldata manifestCID
    ) external payable returns (bytes32);
    
    function fulfillArbitration(
        bytes32 requestId,
        string calldata resultCID
    ) external;
}
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

```mermaid
sequenceDiagram
    participant C as Client
    participant D as Dispatcher
    participant O as Oracle
    participant A as AI Node
    participant M as AI Models
    participant I as IPFS
    
    C->>D: Submit arbitration request
    D->>O: Trigger oracle job
    O->>A: HTTP request with manifest
    A->>I: Fetch evidence files
    A->>M: Process with AI models
    M->>A: Return model responses
    A->>A: Aggregate and rank outcomes
    A->>I: Store result
    A->>O: Return result CID
    O->>D: Submit result on-chain
    D->>C: Arbitration complete
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

```typescript
class DeliberationEngine {
  async deliberate(manifest: QueryManifest): Promise<ArbitrationResult> {
    const responses = await Promise.all(
      manifest.panel.map(model => this.queryModel(model, manifest))
    );
    
    return this.aggregateResponses(responses, manifest.outcomes);
  }
  
  private async aggregateResponses(
    responses: ModelResponse[],
    outcomes: string[]
  ): Promise<ArbitrationResult> {
    // Weighted voting and justification generation
  }
}
```

### Evidence Processing Pipeline

```typescript
class EvidenceProcessor {
  async processEvidence(files: EvidenceFile[]): Promise<ProcessedEvidence> {
    return Promise.all(files.map(async (file) => {
      const content = await this.extractContent(file);
      const metadata = await this.analyzeMetadata(file);
      return { content, metadata, originalFile: file };
    }));
  }
}
```

### Error Handling Strategy

```typescript
class ErrorHandler {
  // Graceful degradation for AI model failures
  async handleModelError(error: ModelError, fallbackModels: Model[]) {
    logger.warn('Primary model failed, trying fallback', { error });
    return this.tryFallbackModels(fallbackModels);
  }
  
  // Retry logic for network failures
  async withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
  }
}
```

## Security Considerations

### Input Validation

```typescript
// All external inputs are validated
const manifestSchema = z.object({
  outcomes: z.array(z.string().max(500)).max(20),
  panel: z.array(modelSpecSchema).max(5),
  iterations: z.number().int().min(1).max(3),
  evidence: z.array(evidenceFileSchema).max(10)
});
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

### Caching Strategy

```typescript
class CacheManager {
  // Model response caching
  async getCachedResponse(prompt: string, model: string): Promise<string | null> {
    const key = this.generateCacheKey(prompt, model);
    return this.cache.get(key);
  }
  
  // IPFS content caching
  async getCachedContent(cid: string): Promise<Buffer | null> {
    return this.ipfsCache.get(cid);
  }
}
```

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

```yaml
# docker-compose.yml
services:
  ai-node:
    image: verdikta/ai-node:latest
    ports: ["3000:3000"]
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    
  external-adapter:
    image: verdikta/external-adapter:latest
    ports: ["8080:8080"]
    depends_on: [ipfs]
    
  chainlink:
    image: smartcontract/chainlink:latest
    ports: ["6688:6688"] 
    depends_on: [postgres]
```

### Scaling Considerations

- Horizontal scaling for AI Node (load balancer)
- Database read replicas for Chainlink
- IPFS cluster for evidence storage
- CDN for static assets
- Monitoring and alerting setup

This architecture provides a robust, scalable foundation for decentralized AI-powered arbitration while maintaining security and performance standards.
