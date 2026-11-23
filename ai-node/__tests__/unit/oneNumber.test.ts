/**
 * One-number questions: a request with exactly one outcome asks each juror for a single score
 * from 0 to 1,000,000, and that score is never scaled to add up to 1,000,000 (with one outcome
 * the scaling would always give [1000000]). See verdikta-common's MANIFEST_SPECIFICATION.md,
 * "One-number questions", on its beacon branch.
 */
import { isOneNumberQuestion, isValidOneNumber, SCORE_TOTAL } from '../../src/utils/oneNumber';
import { parseModelResponse } from '../../src/utils/parseModelResponse';
import {
  buildScoreRepairPrompt,
  parseRepairedScores,
  repairModelScores,
} from '../../src/utils/repairModelResponse';
import { prePromptConfig } from '../../src/config/prePromptConfig';

console.log = jest.fn();
console.error = jest.fn();
console.warn = jest.fn();

const ONE = ['completeness'];
const TWO = ['DONT_FUND', 'FUND'];
const reply = (score: unknown) => JSON.stringify({ score, justification: 'Most of the required parts are present.' });

describe('one-number questions', () => {
  describe('isOneNumberQuestion', () => {
    test('exactly one outcome is a one-number question', () => {
      expect(isOneNumberQuestion(ONE)).toBe(true);
    });

    test('two or more outcomes, none, or no list are not', () => {
      expect(isOneNumberQuestion(TWO)).toBe(false);
      expect(isOneNumberQuestion(['a', 'b', 'c'])).toBe(false);
      expect(isOneNumberQuestion([])).toBe(false);
      expect(isOneNumberQuestion(undefined)).toBe(false);
    });
  });

  describe('isValidOneNumber', () => {
    test('a finite value from 0 to 1,000,000', () => {
      expect(SCORE_TOTAL).toBe(1000000);
      for (const v of [0, 1, 730000, 1000000]) expect(isValidOneNumber(v)).toBe(true);
    });

    test('outside the scale, or not a number', () => {
      for (const v of [-1, 1000001, NaN, Infinity]) expect(isValidOneNumber(v)).toBe(false);
    });
  });

  describe('the pre-prompt', () => {
    const prompt = prePromptConfig.getPrompt(ONE);

    test('asks for one score from 0 to 1,000,000, not a split that sums to 1,000,000', () => {
      expect(prompt).toContain('0 to 1,000,000');
      expect(prompt).toContain('completeness');
      expect(prompt).not.toMatch(/sum to 1,000,000/);
    });

    test('its examples are never the scaled [1000000]', () => {
      expect(prompt).not.toContain('[1000000]');
      expect(prompt).toMatch(/"score": \[\d+\]/);
    });

    test('a request with two outcomes is asked as before', () => {
      expect(prePromptConfig.getPrompt(TWO)).toMatch(/sum to 1,000,000/);
    });
  });

  describe('parseModelResponse', () => {
    test('a single score is kept as given, not scaled', () => {
      expect(parseModelResponse(reply([730000]), ONE).decisionVector).toEqual([730000]);
      expect(parseModelResponse(reply([0]), ONE).decisionVector).toEqual([0]);
      expect(parseModelResponse(reply([1000000]), ONE).decisionVector).toEqual([1000000]);
    });

    test('a score outside 0 to 1,000,000 is rejected (the repair call then reads it)', () => {
      expect(parseModelResponse(reply([1200000]), ONE).decisionVector).toBeNull();
      expect(parseModelResponse(reply([-5]), ONE).decisionVector).toBeNull();
    });

    test('more than one value for a one-number question is rejected', () => {
      expect(parseModelResponse(reply([300000, 700000]), ONE).decisionVector).toBeNull();
    });

    test('two outcomes still need scores that sum to 1,000,000', () => {
      expect(parseModelResponse(reply([300000, 700000]), TWO).decisionVector).toEqual([300000, 700000]);
      expect(parseModelResponse(reply([30, 70]), TWO).decisionVector).toBeNull();
    });
  });

  describe('the repair call', () => {
    test('asks for the single score on the 0 to 1,000,000 scale, converted from the reply\'s own', () => {
      const prompt = buildScoreRepairPrompt('Completeness: 73/100.', ONE);
      expect(prompt).toContain('0 to 1,000,000');
      expect(prompt).toContain('completeness');
      expect(prompt).toContain('730000');
    });

    test('a single repaired score is kept as given, not scaled to [1000000]', () => {
      expect(parseRepairedScores('{"score": [730000]}', 1)).toEqual([730000]);
      expect(parseRepairedScores('{"score": [0]}', 1)).toEqual([0]);
    });

    test('a single repaired score outside the scale, or none, is null', () => {
      expect(parseRepairedScores('{"score": [1000001]}', 1)).toBeNull();
      expect(parseRepairedScores('{"score": [-1]}', 1)).toBeNull();
      expect(parseRepairedScores('{"score": null}', 1)).toBeNull();
    });

    test('repairModelScores returns the single score as given', async () => {
      const provider = { generateResponse: jest.fn().mockResolvedValue('{"score": [730000]}') };
      await expect(repairModelScores(provider, 'm', 'Completeness: 73/100.', ONE)).resolves.toEqual([730000]);
    });

    test('two outcomes are still scaled to 1,000,000', () => {
      expect(parseRepairedScores('{"score": [0, 100]}', 2)).toEqual([0, 1000000]);
    });
  });
});
