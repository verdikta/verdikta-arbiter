// Node A4b: one deadline, from receipt (design §11).

const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const {
  DEFAULT_DEADLINE_MS, COMMIT_RESERVE_MS, JUSTIFIER_RESERVE_MS, JUROR_FLOOR_MS, createDeadline, juryWorthCalling
} = require('../../codeReview/time');
const { CodeReviewAbstain } = require('../../codeReview/errors');

describe('the budget', () => {
  it('780 s is the 840 s bridge timeout less the 60 s commit reserve', () => {
    expect(DEFAULT_DEADLINE_MS).toBe(780000);
    expect(COMMIT_RESERVE_MS).toBe(60000);
    expect(DEFAULT_DEADLINE_MS + COMMIT_RESERVE_MS).toBe(codeReview.MAX_DEADLINE_MS);
  });

  it('the justifier reserve is the AI Node\'s, and the juror floor is above the smallest jury it accepts', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../../ai-node/src/lib/code-review/deadline.ts'), 'utf8');
    const value = (name) => Number(new RegExp(`${name} = ([0-9]+)`).exec(source)[1]);
    expect(JUSTIFIER_RESERVE_MS).toBe(value('JUSTIFIER_RESERVE_MS'));
    expect(JUROR_FLOOR_MS).toBeGreaterThan(value('MIN_JURY_MS'));
  });

  it('a jury is worth calling only while remaining > reserve + floor', () => {
    const limit = JUSTIFIER_RESERVE_MS + JUROR_FLOOR_MS;
    expect(juryWorthCalling(limit)).toBe(false);
    expect(juryWorthCalling(limit + 1)).toBe(true);
    expect(juryWorthCalling(0)).toBe(false);
  });
});

describe('createDeadline', () => {
  let t;
  const make = (over = {}) => createDeadline({ receivedAt: 1000, deadlineMs: 780000, now: () => t, ...over });

  beforeEach(() => { t = 1000; });

  it('remaining is what is left of it, an integer, from receipt', () => {
    const deadline = make();
    expect(deadline.at).toBe(781000);
    expect(deadline.remaining()).toBe(780000);
    t = 1000 + 123.75;
    expect(deadline.remaining()).toBe(779876);
    expect(Number.isInteger(deadline.remaining())).toBe(true);
  });

  it('time already spent before the deadline object existed counts', () => {
    t = 91000;
    expect(make().remaining()).toBe(690000);
  });

  it('never below zero, and never above the budget when the clock steps back', () => {
    const deadline = make();
    t = 781001;
    expect(deadline.remaining()).toBe(0);
    t = -5000;
    expect(deadline.remaining()).toBe(780000);
  });

  it('passed: exactly at the deadline is still in time, a millisecond later is not', () => {
    const deadline = make();
    t = 781000;
    expect(deadline.passed()).toBe(false);
    t = 781001;
    expect(deadline.passed()).toBe(true);
  });

  it('assertOpen throws the deadline abstention, naming what could not happen', () => {
    const deadline = make();
    expect(() => deadline.assertOpen('commit')).not.toThrow();
    t = 781001;
    expect(() => deadline.assertOpen('commit')).toThrow(CodeReviewAbstain);
    expect(() => deadline.assertOpen('commit')).toThrow(/CODE_REVIEW_DEADLINE.*commit/);
  });

  it('abortAtDeadline fires at the deadline, or at the shorter limit it is given, and clear stops it', async () => {
    const real = createDeadline({ receivedAt: Date.now(), deadlineMs: 30 });
    const one = real.abortAtDeadline();
    const started = Date.now();
    await new Promise((resolve) => one.signal.addEventListener('abort', resolve));
    expect(Date.now() - started).toBeLessThan(1000);
    one.clear();

    const long = createDeadline({ receivedAt: Date.now(), deadlineMs: 60000 });
    const two = long.abortAtDeadline({ maxMs: 20 });
    await new Promise((resolve) => two.signal.addEventListener('abort', resolve));
    two.clear();

    const three = long.abortAtDeadline();
    three.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(three.signal.aborted).toBe(false);
  });

  it('race gives the work\'s answer in time, else the deadline abstention, and leaves the work alone', async () => {
    const real = createDeadline({ receivedAt: Date.now(), deadlineMs: 60000 });
    await expect(real.race(Promise.resolve('done'), 'run')).resolves.toBe('done');
    await expect(real.race(Promise.reject(new Error('its own')), 'run')).rejects.toThrow('its own');

    const short = createDeadline({ receivedAt: Date.now(), deadlineMs: 20 });
    let finished = false;
    const work = new Promise((resolve) => setTimeout(() => { finished = true; resolve('late'); }, 60));
    await expect(short.race(work, 'run')).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    await work;
    expect(finished).toBe(true);
  });
});
