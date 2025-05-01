import { parseModelResponse } from '../../src/utils/parseModelResponse';

// Mock console to avoid cluttering test output
console.log = jest.fn();
console.error = jest.fn();

describe('parseModelResponse', () => {
  // Tests for well-formed JSON
  describe('Valid JSON parsing', () => {
    it('should parse well-formed JSON response', () => {
      const json = `{
        "score": [800000, 200000],
        "justification": "Simple justification text."
      }`;
      
      const result = parseModelResponse(json, ['Option A', 'Option B']);
      
      expect(result.decisionVector).toEqual([800000, 200000]);
      expect(result.justification).toBe('Simple justification text.');
      expect(result.scores).toEqual([
        { outcome: 'Option A', score: 800000 },
        { outcome: 'Option B', score: 200000 }
      ]);
    });

    it('should parse JSON in markdown code blocks', () => {
      const markdown = '```json\n{\n  "score": [600000, 400000],\n  "justification": "Code block justification"\n}\n```';
      
      const result = parseModelResponse(markdown, ['Option A', 'Option B']);
      
      expect(result.decisionVector).toEqual([600000, 400000]);
      expect(result.justification).toBe('Code block justification');
    });
  });

  // Tests for problematic JSON - based on failures observed in the examples
  describe('Problematic JSON parsing', () => {
    it('should handle unescaped quotes in justification', () => {
      const problematicJson = `{
        "score": [800000, 200000],
        "justification": "This justification contains "unescaped quotes" that would break JSON parsing."
      }`;
      
      const result = parseModelResponse(problematicJson, ['Option A', 'Option B']);
      
      expect(result.decisionVector).toEqual([800000, 200000]);
      const expectedSentence = 'This justification contains "unescaped quotes" that would break JSON parsing.';
      expect(result.justification).toEqual(expectedSentence);
    });

    it('should handle newlines and special characters in justification', () => {
      const problematicJson = `{
        "score": [700000, 300000],
        "justification": "First line.\nSecond line with special chars: [(){};+*&^%$#@!]"
      }`;
      
      const result = parseModelResponse(problematicJson, ['Option A', 'Option B']);
      
      expect(result.decisionVector).toEqual([700000, 300000]);
      expect(result.justification).toContain('First line');
      expect(result.justification).toContain('Second line');
    });

    it('should handle partial JSON extraction when parsing fails', () => {
      // This replicates the issue in the examples where parsing failed
      const brokenJson = `{
        "score": [800000, 200000],
        "justification": "First outcome (Vulnerabilities) scored 800000 because the provided smart contract contains a potential vulnerability in the transfer function. The contract uses "to.call(value: 100)" which lacks proper checks for the outcome of the transaction and can be exploited."
      }`;
      
      const result = parseModelResponse(brokenJson, ['Vulnerabilities', 'Safe']);
      
      expect(result.decisionVector).toEqual([800000, 200000]);
      expect(result.justification).toContain('potential vulnerability');
    });
  });

  // Tests for old format parsing
  describe('Old format parsing', () => {
    it('should handle old SCORE: and JUSTIFICATION: format', () => {
      const oldFormat = `SCORE: 900000, 100000
      JUSTIFICATION: The first option is clearly better.`;
      
      const result = parseModelResponse(oldFormat, ['Option A', 'Option B']);
      
      expect(result.decisionVector).toEqual([900000, 100000]);
      expect(result.justification).toBe('The first option is clearly better.');
    });
  });

  // Regression tests for the specific examples in the user's query
  describe('Regression tests from provided examples', () => {
    it('should handle the first example (failed parsing)', () => {
      const example1 = `\`\`\`json
{
"score": [800000, 200000],
"justification": "First outcome (Vulnerabilities) scored 800000 because the provided smart contract contains a potential vulnerability in the transfer function. The contract uses \\"to.call(value: 100)\\" which lacks proper checks for the outcome of the transaction and can be exploited. This can lead to security vulnerabilities such as reentrancy attacks. Second outcome (Safe) scored 200000 because the sample is minimal and straightforward, which slightly minimizes complexity; however, the lack of security checks makes it predominantly unsafe."
}
\`\`\``;
      
      const result = parseModelResponse(example1, ['Vulnerabilities', 'Safe']);
      
      expect(result.decisionVector).toEqual([800000, 200000]);
      expect(result.justification).toContain('reentrancy attacks');
    });

    it('should handle the second example (successful parsing)', () => {
      const example2 = `\`\`\`json
{
"score": [700000, 300000],
"justification": "The first outcome (Vulnerabilities) scored 700000 because the provided smart contract snippet seems to have a reentrancy vulnerability. The code hints at an external call (to.call) without apparent measures to prevent reentrancy, which is a common flaw where an attacker can recursively call the function, potentially draining the contract's funds. The second outcome (Safe) scored 300000 because apart from the potential reentrancy issue, the code is relatively simple, and no other immediate vulnerabilities are evident in this short snippet."
}
\`\`\``;
      
      const result = parseModelResponse(example2, ['Vulnerabilities', 'Safe']);
      
      expect(result.decisionVector).toEqual([700000, 300000]);
      expect(result.justification).toContain('reentrancy vulnerability');
    });
  });
}); 