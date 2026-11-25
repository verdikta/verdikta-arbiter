/**
 * The operator's override that lets the arbiter answer with part of its jury
 * (src/utils/juryQuorum.ts). By default every juror must answer, so a test of what a
 * response says about a juror that failed has to turn the override on.
 */

const NAME = 'MIN_SUCCESSFUL_MODELS_PERCENT';

function restore(before: string | undefined): void {
  if (before === undefined) delete process.env[NAME];
  else process.env[NAME] = before;
}

/** Inside a describe: every test in it runs with the override set to `share`. */
export function allowPartialJury(share = '0.5'): void {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env[NAME];
    process.env[NAME] = share;
  });
  afterEach(() => restore(before));
}

/** One call with the override set to `share`. */
export async function withPartialJury<T>(run: () => Promise<T>, share = '0.5'): Promise<T> {
  const before = process.env[NAME];
  process.env[NAME] = share;
  try {
    return await run();
  } finally {
    restore(before);
  }
}
