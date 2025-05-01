const AIClient = require('../../services/aiClient');
const axios = require('axios');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const nock = require('nock');
const config = require('../../config');

describe('AI Client Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-test-'));
    
    // Create required manifest file
    await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify({
      version: "1.0",
      primary: { filename: "test.json" },
      additional: [],
      juryParameters: {
        NUMBER_OF_OUTCOMES: 2,
        AI_NODES: [
          {
            AI_MODEL: "gpt-4",
            AI_PROVIDER: "OpenAI",
            NO_COUNTS: 1,
            WEIGHT: 1.0
          }
        ],
        ITERATIONS: 1
      }
    }));

    // Create test.json with meaningful content
    await fs.writeFile(path.join(tempDir, 'test.json'), JSON.stringify({
      query: "Evaluate code quality",
      references: []
    }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should properly evaluate text content', async () => {
    const query = {
      prompt: 'Evaluate if the following text contains sensitive information: "This is a public document about weather patterns."',
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0
      }],
      outcomes: ['Sensitive', 'Safe'],
      iterations: 1
    };

    const result = await AIClient.evaluate(query, tempDir);
    
    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
    expect(result.scores.length).toBe(2);
    result.scores.forEach(score => {
      expect(score).toHaveProperty('outcome');
      expect(['Sensitive', 'Safe']).toContain(score.outcome);
      expect(score).toHaveProperty('score');
      expect(typeof score.score).toBe('number');
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(1000000);
    });
  });

  it('should handle missing attachments gracefully', async () => {
    const testQuery = {
      prompt: 'Evaluate if the following statement is true: "Water boils at 100 degrees Celsius at sea level." Consider standard atmospheric pressure and pure water.',
      models: [{ 
        provider: 'OpenAI', 
        model: 'gpt-4', 
        weight: 1.0 
      }],
      outcomes: ['True', 'False'],
      iterations: 1
    };

    const result = await AIClient.evaluate(testQuery, tempDir);
    
    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
    expect(result.scores.length).toBe(2);
    result.scores.forEach(score => {
      expect(score).toHaveProperty('outcome');
      expect(['True', 'False']).toContain(score.outcome);
      expect(score).toHaveProperty('score');
      expect(typeof score.score).toBe('number');
    });
  });

  it('should handle code evaluation requests', async () => {
    const query = {
      prompt: 'Analyze if the following code contains proper error handling: try { someFunction(); } catch (error) { console.error(error); }',
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0
      }],
      outcomes: ['Good', 'Poor'],
      iterations: 1
    };

    const result = await AIClient.evaluate(query, tempDir);
    
    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
    expect(result.scores.length).toBe(2);
    result.scores.forEach(score => {
      expect(score).toHaveProperty('outcome');
      expect(['Good', 'Poor']).toContain(score.outcome);
      expect(score).toHaveProperty('score');
      expect(typeof score.score).toBe('number');
    });
  });

  it('should handle missing referenced files', async () => {
    const testQuery = {
      prompt: "Evaluate if the following code follows best practices: function add(a, b) { return a + b; }",
      models: [{ provider: "OpenAI", model: "gpt-4", weight: 1, count: 1 }],
      iterations: 1
    };

    const result = await AIClient.evaluate(testQuery, tempDir);
    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
  });

  it('should handle complex evaluation requests', async () => {
    const query = {
      prompt: `
        Analyze this code for error handling practices:
        function processData(data) {
          try {
            return JSON.parse(data);
          } catch (error) {
            console.error('Failed to parse data:', error);
            return null;
          }
        }
      `,
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0
      }],
      outcomes: ['Good', 'Poor']
    };

    const result = await AIClient.evaluate(query, tempDir);
    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
    expect(result.scores.length).toBe(2);
    result.scores.forEach(score => {
      expect(score).toHaveProperty('outcome');
      expect(['Good', 'Poor']).toContain(score.outcome);
      expect(score).toHaveProperty('score');
      expect(typeof score.score).toBe('number');
    });
  });
});

describe('AIClient Integration Tests', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-test-'));
    
    // Create required manifest file
    await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify({
      version: "1.0",
      primary: { filename: "test.json" },
      additional: [],
      juryParameters: {
        NUMBER_OF_OUTCOMES: 2,
        AI_NODES: [
          {
            AI_MODEL: "gpt-4",
            AI_PROVIDER: "OpenAI",
            NO_COUNTS: 1,
            WEIGHT: 1.0
          }
        ],
        ITERATIONS: 1
      }
    }));

    // Create test.json with meaningful content
    await fs.writeFile(path.join(tempDir, 'test.json'), JSON.stringify({
      query: "Evaluate statement validity",
      references: []
    }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should handle evaluation with outcomes correctly', async () => {
    const mockQuery = {
      prompt: 'Given the statement "The sky is blue", evaluate if this is true or false. Consider that during normal daytime conditions on Earth, the sky appears blue due to Rayleigh scattering of sunlight.',
      models: [
        {
          provider: 'OpenAI',
          model: 'gpt-4',
          weight: 1.0
        }
      ],
      outcomes: ['True', 'False']
    };

    const result = await AIClient.evaluate(mockQuery, tempDir);

    expect(result).toHaveProperty('scores');
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]).toHaveProperty('outcome');
    expect(result.scores[0]).toHaveProperty('score');
    expect(result.scores[1]).toHaveProperty('outcome');
    expect(result.scores[1]).toHaveProperty('score');
    expect(['True', 'False']).toContain(result.scores[0].outcome);
    expect(['True', 'False']).toContain(result.scores[1].outcome);
  });

  it('should handle evaluation without outcomes correctly', async () => {
    const query = {
      prompt: 'Evaluate if the following statement is factual: "The Earth orbits around the Sun."',
      models: [
        {
          provider: 'OpenAI',
          model: 'gpt-4',
          weight: 1.0
        }
      ]
    };

    const result = await AIClient.evaluate(query, tempDir);

    expect(result).toHaveProperty('scores');
    expect(result.scores).toBeInstanceOf(Array);
    expect(result.scores.length).toBe(2); // Default case returns two scores
    result.scores.forEach(score => {
      expect(score).toHaveProperty('outcome');
      expect(score).toHaveProperty('score');
      expect(typeof score.score).toBe('number');
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(1000000);
    });
  });

  it('should handle provider errors with new response format', async () => {
    const mockQuery = {
      prompt: 'Evaluate this statement with an invalid provider',
      models: [
        {
          provider: 'test-provider',
          model: 'test-model',
          weight: 1.0
        }
      ]
    };

    try {
      await AIClient.evaluate(mockQuery, tempDir);
      throw new Error('Expected error was not thrown');
    } catch (error) {
      expect(error.message).toMatch(/PROVIDER_ERROR/);
    }
  });

  it('should handle provider errors appropriately', async () => {
    const query = {
      prompt: 'Evaluate this statement with a nonexistent provider',
      models: [
        {
          provider: 'NonexistentProvider',
          model: 'nonexistent-model',
          weight: 1.0
        }
      ]
    };

    try {
      await AIClient.evaluate(query, tempDir);
      throw new Error('Expected error was not thrown');
    } catch (error) {
      expect(error.message).toMatch(/PROVIDER_ERROR/);
    }
  });
});