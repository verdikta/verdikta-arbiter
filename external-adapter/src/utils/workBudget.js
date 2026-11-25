/**
 * @fileoverview What one request may make this arbiter do, before any of it is done.
 *
 * The requester writes the manifest: the jury (AI_NODES with NO_COUNTS), ITERATIONS, the attachments
 * and the archives. The node is paid at most its fee, so the work a request asks for must be bounded
 * by the node, not by the requester. common's manifest schema alone allows 10 models x 5 counts x 5
 * iterations = 250 model calls per run, and attachments are neither counted nor sized (the same CID
 * may be listed under many names, and each listing is read and sent again).
 *
 * The defaults are the class map's ceilings (@verdikta/common data/classmap.v1.json: every ACTIVE
 * class allows a panel of 5, NO_COUNTS 2, ITERATIONS 3 = 30 calls, 10 supporting files, 40 MiB of
 * evidence and 20 MiB per file), widened where a multi-CID request legitimately carries more
 * (attachments from several bCID archives). A request over a limit is refused (errored, no commit,
 * no model call): never truncated, since truncating would change what the jury sees.
 *
 *   EA_MAX_MODEL_CALLS        sum of NO_COUNTS x ITERATIONS          (default 30)
 *   EA_MAX_ITERATIONS         ITERATIONS                              (default 3)
 *   EA_MAX_ATTACHMENTS        attachment entries read for one run     (default 20)
 *   EA_MAX_ATTACHMENT_BYTES   their bytes on disk, in all             (default 40 MiB)
 *   EA_MAX_ARCHIVE_ENTRIES    ZIP entries in one evidence archive     (default 2,000)
 *   EA_MAX_EXTRACTED_BYTES    bytes one evidence archive inflates to  (default 256 MiB)
 */

const MIB = 1024 * 1024;

const DEFAULT_WORK_BUDGET = Object.freeze({
  maxModelCalls: 30,
  maxIterations: 3,
  maxAttachments: 20,
  maxAttachmentBytes: 40 * MIB,
  maxArchiveEntries: 2000,
  maxExtractedBytes: 256 * MIB
});

const ENV_KEYS = Object.freeze({
  maxModelCalls: 'EA_MAX_MODEL_CALLS',
  maxIterations: 'EA_MAX_ITERATIONS',
  maxAttachments: 'EA_MAX_ATTACHMENTS',
  maxAttachmentBytes: 'EA_MAX_ATTACHMENT_BYTES',
  maxArchiveEntries: 'EA_MAX_ARCHIVE_ENTRIES',
  maxExtractedBytes: 'EA_MAX_EXTRACTED_BYTES'
});

class WorkBudgetError extends Error {
  constructor(reason) {
    super(`Request exceeds this arbiter's work limits: ${reason}`);
    this.name = 'WorkBudgetError';
    this.code = 'WORK_BUDGET';
    this.statusCode = 400;
  }
}

function isWorkBudgetError(error) {
  return error instanceof WorkBudgetError;
}

/** The limits in force: each EA_MAX_* that is a positive integer, else its default. */
function workBudgetFromEnv(env = process.env) {
  const budget = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    const parsed = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    budget[key] = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WORK_BUDGET[key];
  }
  return budget;
}

/** The model calls a query asks for: ITERATIONS x the sum of every model's count (1 when unset). */
function modelCalls(query) {
  const models = Array.isArray(query && query.models) ? query.models : [];
  const iterations = Number(query && query.iterations) || 1;
  const perIteration = models.reduce((sum, m) => sum + (Number(m && m.count) || 1), 0);
  return { iterations, perIteration, total: iterations * perIteration };
}

/** Refuse a jury larger than the budget, before any model call. */
function assertJuryBudget(query, budget = workBudgetFromEnv()) {
  const { iterations, perIteration, total } = modelCalls(query);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > budget.maxIterations) {
    throw new WorkBudgetError(`ITERATIONS ${iterations} (at most ${budget.maxIterations})`);
  }
  if (total > budget.maxModelCalls) {
    throw new WorkBudgetError(`${total} model calls (${iterations} iteration(s) x ${perIteration}; at most ${budget.maxModelCalls})`);
  }
}

module.exports = {
  DEFAULT_WORK_BUDGET, WorkBudgetError, isWorkBudgetError, workBudgetFromEnv, modelCalls, assertJuryBudget
};
