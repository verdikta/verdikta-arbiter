/**
 * Code mode's single deadline (design §11): juror and justifier budgets from deadlineMs.
 * The jury's window leaves the justifier a 45 s reserve; the justifier itself may use
 * whatever the deadline leaves when it starts (A22).
 */
import {
  CODE_JURY_MAX_MS,
  JUSTIFIER_RESERVE_MS,
  MIN_JURY_MS,
  justifierBudgetMs,
  planCodeReviewTimes,
  raceAbort,
} from '../../../lib/code-review/deadline';
import { parseCodeJurorReply, roundToTotal } from '../../../lib/code-review/jury';

describe('code-review deadline plan (§11)', () => {
  test('reserves 45 s for the justifier and gives the jurors the rest', () => {
    expect(JUSTIFIER_RESERVE_MS).toBe(45000);
    const times = planCodeReviewTimes(100000, 1000)!;
    expect(times.deadlineAt).toBe(101000);
    expect(times.jurorTimeoutMs).toBe(55000);
    expect(times.juryDeadlineAt).toBe(56000);
  });

  test('caps the jury at the 480 s budget when the deadline is further away', () => {
    expect(CODE_JURY_MAX_MS).toBe(480000);
    const times = planCodeReviewTimes(840000, 0)!;
    expect(times.jurorTimeoutMs).toBe(480000);
    expect(times.deadlineAt).toBe(840000);
  });

  test('the cap only lowers what the deadline leaves: the jury and the justifier still end by deadlineMs', () => {
    // The EA's whole deadline (780 s from its receipt) when nothing came before the jury.
    const far = planCodeReviewTimes(780000, 0)!;
    expect(far.jurorTimeoutMs).toBe(480000);
    // A deadline closer than cap + reserve: the jury gets what is left after the reserve.
    for (const deadlineMs of [525000, 500000, 300000, 100000]) {
      const times = planCodeReviewTimes(deadlineMs, 0)!;
      expect(times.jurorTimeoutMs).toBe(Math.min(480000, deadlineMs - JUSTIFIER_RESERVE_MS));
      expect(times.juryDeadlineAt + JUSTIFIER_RESERVE_MS).toBeLessThanOrEqual(times.deadlineAt);
    }
  });

  test('refuses a deadline that leaves no jury time after the justifier reserve', () => {
    expect(planCodeReviewTimes(JUSTIFIER_RESERVE_MS + MIN_JURY_MS - 1, 0)).toBeNull();
    expect(planCodeReviewTimes(JUSTIFIER_RESERVE_MS + MIN_JURY_MS, 0)).not.toBeNull();
  });

  test('the justifier gets what the deadline leaves when it starts, not a fixed 45 s, and never past the deadline', () => {
    const times = planCodeReviewTimes(285000, 0)!;
    // A jury that finished at 10 s leaves the justifier everything up to the deadline.
    expect(justifierBudgetMs(times, 10000)).toBe(275000);
    // A jury that used its whole window leaves exactly the reserve.
    expect(justifierBudgetMs(times, times.juryDeadlineAt)).toBe(JUSTIFIER_RESERVE_MS);
    expect(justifierBudgetMs(times, 260000)).toBe(25000);
    expect(justifierBudgetMs(times, 285000)).toBe(0);
    expect(justifierBudgetMs(times, 300000)).toBe(0);
  });

  test('on the EA\'s whole deadline, a jury done early leaves the justifier minutes; the jury\'s window is unchanged', () => {
    const times = planCodeReviewTimes(780000, 0)!;
    expect(times.jurorTimeoutMs).toBe(480000);
    expect(justifierBudgetMs(times, 250000)).toBe(530000);
    expect(justifierBudgetMs(times, times.juryDeadlineAt)).toBe(300000);
  });

  test('wherever the jury ends, the justifier has at least the reserve and ends at the deadline exactly', () => {
    for (const deadlineMs of [55000, 100000, 285000, 525000, 600000, 780000]) {
      const times = planCodeReviewTimes(deadlineMs, 7000)!;
      for (const juryEnd of [times.receivedAt, times.receivedAt + 1000, Math.floor((times.receivedAt + times.juryDeadlineAt) / 2), times.juryDeadlineAt]) {
        const budget = justifierBudgetMs(times, juryEnd);
        expect(budget).toBeGreaterThanOrEqual(JUSTIFIER_RESERVE_MS);
        expect(juryEnd + budget).toBe(times.deadlineAt);
      }
    }
  });

  test('raceAbort rejects as soon as the signal aborts, even if the work never settles', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const raced = raceAbort(never, controller.signal);
    controller.abort();
    await expect(raced).rejects.toThrow(/aborted/i);
  }, 5000);

  test('raceAbort passes the result through when the work wins', async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok');
  }, 5000);
});

describe('code-mode vector arithmetic', () => {
  test('roundToTotal keeps exactly 1,000,000 by largest remainder, ties to the lower index', () => {
    expect(roundToTotal([0.5, 999999.5, 0, 0, 0, 0])).toEqual([1, 999999, 0, 0, 0, 0]);
    const thirds = roundToTotal([333333.3333, 333333.3333, 333333.3334, 0, 0, 0]);
    expect(thirds.reduce((a, b) => a + b, 0)).toBe(1000000);
    expect(thirds).toEqual([333333, 333333, 333334, 0, 0, 0]);
    expect(roundToTotal([0, 0, 0, 0, 1000000, 0])).toEqual([0, 0, 0, 0, 1000000, 0]);
  });

  test('parseCodeJurorReply takes only a reply that is exactly one valid JSON object', () => {
    const six = ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const ok = '{"score": [0, 0, 0, 0, 1000000, 0], "justification": "HIGH"}';
    expect(parseCodeJurorReply(ok, six)).toEqual({ vector: [0, 0, 0, 0, 1000000, 0], justification: 'HIGH' });
    expect(parseCodeJurorReply(`\`\`\`json\n${ok}\n\`\`\``, six)).not.toBeNull();
    expect(parseCodeJurorReply(`My verdict: ${ok}`, six)).toBeNull();
    expect(parseCodeJurorReply('{"score": [0, 0, 0, 0, 999999, 0], "justification": "x"}', six)).toBeNull();
    expect(parseCodeJurorReply('{"score": [-1, 0, 0, 0, 1000001, 0], "justification": "x"}', six)).toBeNull();
    expect(parseCodeJurorReply('{"score": [0, 0, 0, 0, 1000000], "justification": "x"}', six)).toBeNull();
    expect(parseCodeJurorReply('{"score": [0, 0, 0, 0, 999999.5, 0.5], "justification": "x"}', six)).toBeNull();
  });
});
