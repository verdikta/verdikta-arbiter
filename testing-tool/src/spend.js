'use strict';

/**
 * What a real-jury run spends (node A7d): list prices, a call's worst case, and an append-only ledger.
 *
 * The ledger is the record and the stop. A call is reserved at its worst case and written to disk before it is
 * forwarded, and replaced by what the provider reported when it answers. A call that never answered stays at its
 * reservation, across a restart too, so the total can only be over what was spent, never under.
 */

const crypto = require('crypto');
const fs = require('fs');

const { modelOfRoute } = require('./routes');

const M = 1000000;

/**
 * List prices, USD per million tokens. Nothing here is a default: a model with no row cannot be counted, so the meter
 * refuses it. Sources, read on the date: OpenRouter's public /api/v1/models for all three, and Anthropic's own table
 * for the two Claude models and Haiku's price past 100K input tokens. The rows of the jurors the Q63 panels add
 * (@verdikta/common 1.9.0-attest.4: gemini-4-argon, gpt-6-luna, claude-opus-5-5) are OpenRouter's, read on
 * 2026-11-10, Luna's price past 272K input tokens included. The AI Node sends no cache_control, so the cache rows are
 * there only so that a surprise is not counted as free.
 */
const PRICES = Object.freeze({
  asOf: '2026-11-05',
  source: 'openrouter.ai/api/v1/models; Anthropic API price table',
  models: Object.freeze({
    'claude-sonnet-5-5': Object.freeze({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 }),
    'claude-haiku-5-5': Object.freeze({ inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, above: Object.freeze({ inputTokens: 100000, inputPerM: 0.5, outputPerM: 2.5 }) }),
    'deepseek/deepseek-v4-pro-0813': Object.freeze({ inputPerM: 0.115, outputPerM: 4.6, cacheReadPerM: 0.11, cacheWritePerM: 0.115 }),
    'google/gemini-4-argon': Object.freeze({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 0.1875 }),
    'gpt-6-luna': Object.freeze({ inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, above: Object.freeze({ inputTokens: 272000, inputPerM: 0.2, outputPerM: 0.75 }) }),
    'claude-opus-5-5': Object.freeze({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 })
  })
});

/** The input a body could hold. Hex, base64 and CJK reach 1.4-2 bytes a token (code-runner README, "A token"), and no token holds less than a byte. */
const BYTES_PER_TOKEN_WORST = 1;
/** What a call that names no ceiling is reserved at. */
const NO_CEILING_TOKENS = 64000;
/** A repair call quotes one reply (at most the juror's output, four bytes a token at most in UTF-8) plus its instructions. */
const REPAIR_PROMPT_BYTES = 40000;
/** The justifier quotes every juror's answer. */
const JUSTIFIER_PROMPT_BYTES_PER_JUROR = 45000;
/** @langchain/anthropic's ceiling on a modern model (ai-node, MODERN_MAX_TOKENS): the justifier sets none of its own. */
const JUSTIFIER_MAX_TOKENS = 8192;
/** As the External Adapter: a second attempt, on a retryable answer only. */
const ATTEMPTS = 2;

/**
 * A model's row, or the row of the pool model an OpenRouter route id stands for (routes.js): a call the AI Node sent
 * through OpenRouter carries that id, as gpt-6-luna does under jury-run.sh (openai/gpt-6-luna). The Q63 rows are
 * OpenRouter's own prices; for Haiku and Sonnet, Anthropic's, whose cache rows are at or above OpenRouter's.
 */
function priceOf(model) {
  // Own rows only: "constructor" is no model.
  const own = (id) => (Object.hasOwn(PRICES.models, id) ? PRICES.models[id] : null);
  const routed = modelOfRoute(model);
  const price = own(model) || (routed ? own(routed.model) : null);
  if (!price) throw new Error(`no list price for model ${model}: a call to it could not be counted`);
  return price;
}

const isCount = (value) => Number.isInteger(value) && value >= 0;
const optional = (value) => (value === undefined || value === null ? 0 : value);

/**
 * What a provider's answer says it used, at list price. Anthropic: usage.input_tokens, output_tokens and the cache
 * pair. OpenRouter: usage.prompt_tokens, completion_tokens and, when present, cost. `usd` is the larger of the list
 * price and a reported cost, since the stop has to hold against the bill.
 * @param {string} model
 * @param {object|null} body - the provider's parsed JSON
 * @returns {{inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number, listUsd:number, reportedUsd:number|null, usd:number}|null} null: nothing readable
 * @throws {Error} a model with no price
 */
function usageOf(model, body) {
  const price = priceOf(model);
  const usage = body && typeof body === 'object' ? body.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = usage.input_tokens === undefined ? usage.prompt_tokens : usage.input_tokens;
  const outputTokens = usage.output_tokens === undefined ? usage.completion_tokens : usage.output_tokens;
  const cacheReadTokens = optional(usage.cache_read_input_tokens);
  const cacheWriteTokens = optional(usage.cache_creation_input_tokens);
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(isCount)) return null;
  const rate = price.above && inputTokens > price.above.inputTokens ? price.above : price;
  const listUsd = (inputTokens * rate.inputPerM + outputTokens * rate.outputPerM
    + cacheReadTokens * price.cacheReadPerM + cacheWriteTokens * price.cacheWritePerM) / M;
  const reportedUsd = typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, listUsd, reportedUsd, usd: Math.max(listUsd, reportedUsd === null ? 0 : reportedUsd) };
}

/**
 * A call's worst case.
 * @param {string} model
 * @param {number} bodyBytes - the request body's length
 * @param {number} [maxTokens] - the call's output ceiling
 * @returns {number} USD
 * @throws {Error} a model with no price
 */
function reservationUsd(model, bodyBytes, maxTokens) {
  const price = priceOf(model);
  const inputTokens = Math.ceil(bodyBytes / BYTES_PER_TOKEN_WORST);
  const outputTokens = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : NO_CEILING_TOKENS;
  const rate = price.above && inputTokens > price.above.inputTokens ? price.above : price;
  return (inputTokens * rate.inputPerM + outputTokens * rate.outputPerM) / M;
}

/**
 * The most one claim could add: each juror and a repair call, the justifier, and all of it again for the one retry.
 * Asked before a claim starts, so a run stops short of the limit rather than at a provider error.
 * @param {object} o
 * @param {number} o.promptBytes
 * @param {{AI_NODES: Array<{AI_MODEL:string}>}} o.juryParameters
 * @param {string} o.justifierModel
 * @param {number} o.jurorOutputTokens
 * @returns {number} USD
 */
function worstCaseClaimUsd({ promptBytes, juryParameters, justifierModel, jurorOutputTokens }) {
  const jurors = juryParameters.AI_NODES.map((node) => node.AI_MODEL);
  const jury = jurors.reduce((sum, model) => sum + reservationUsd(model, promptBytes, jurorOutputTokens) + reservationUsd(model, REPAIR_PROMPT_BYTES, jurorOutputTokens), 0);
  const justifier = reservationUsd(justifierModel, JUSTIFIER_PROMPT_BYTES_PER_JUROR * jurors.length, JUSTIFIER_MAX_TOKENS);
  return ATTEMPTS * (jury + justifier);
}

function parseRows(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const rows = [];
  lines.forEach((line, i) => {
    try {
      rows.push(JSON.parse(line));
    } catch (_error) {
      // A row is synced before the call it records goes out, so a torn last line is a write that never finished.
      if (i !== lines.length - 1) throw new Error(`the ledger ${file} is damaged at line ${i + 1}`);
    }
  });
  return rows;
}

function summarize(rows) {
  const reserved = new Map();
  const calls = [];
  const refused = [];
  for (const row of rows) {
    if (row.kind === 'reserve') reserved.set(row.id, row);
    else if (row.kind === 'refused') refused.push(row);
    else if (row.kind === 'settle') {
      const start = reserved.get(row.id);
      if (!start) throw new Error(`the ledger settles a call it never reserved: ${row.id}`);
      reserved.delete(row.id);
      calls.push({ ...row, model: start.model, maxTokens: start.maxTokens, reservedUsd: start.usd });
    }
  }
  const openUsd = [...reserved.values()].reduce((sum, row) => sum + row.usd, 0);
  const totalUsd = calls.reduce((sum, row) => sum + row.usd, openUsd);
  return { totalUsd, openUsd, open: reserved.size, calls, refused };
}

/**
 * The ledger as a reader sees it.
 * @param {string} file
 * @returns {{totalUsd:number, openUsd:number, open:number, calls:object[], refused:object[]}}
 */
function readLedger(file) {
  return summarize(parseRows(file));
}

/**
 * One holder at a time. The lock appears whole, naming a PID, or not at all: it is written beside its place and linked
 * in, which fails if one is there. Nothing here takes a lock over: two processes that both saw a dead holder could each
 * remove the other's new lock, and two meters would then check the limit against two totals. The holder removes its own
 * lock, also on a TERM, and jury-run.sh removes those of the children it has stopped. After anything else, a person does.
 * @param {string} file
 * @param {string} what - for the message
 * @returns {() => void} release
 * @throws {Error} a lock is there
 */
function acquireLock(file, what) {
  const partial = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(partial, `${process.pid}\n`, { mode: 0o600 });
  try {
    fs.linkSync(partial, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    let state = 'an unknown process';
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        state = `process ${pid}`;
      } catch (signalError) {
        state = signalError.code === 'EPERM' ? `process ${pid}` : `process ${pid}, which no longer runs, so removing that file goes on`;
      }
    }
    throw new Error(`${what} is already held by ${state} (${file})`);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return () => fs.rmSync(file, { force: true });
}

/**
 * Cut a torn last line off: the write never finished, so its call was never sent, and the next row must not join it.
 * @param {string} file
 */
function dropTornTail(file) {
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end !== bytes.length) fs.truncateSync(file, end);
}

/** The writer. One process holds it, by lock: the meter. */
class Ledger {
  /**
   * @param {string} file
   * @param {{stopUsd:number}} o - no reservation may take the total past this
   */
  constructor(file, { stopUsd }) {
    this.stopUsd = stopUsd;
    this.release = acquireLock(`${file}.lock`, 'the ledger');
    dropTornTail(file);
    const rows = parseRows(file);
    const earlier = summarize(rows);
    const settled = new Set(earlier.calls.map((call) => call.id));
    this.settledUsd = earlier.totalUsd - earlier.openUsd;
    this.openCalls = new Map(rows.filter((row) => row.kind === 'reserve' && !settled.has(row.id)).map((row) => [row.id, row.usd]));
    this.refusedAny = false;
    this.fd = fs.openSync(file, 'a', 0o600);
  }

  /** Whole and on disk, or it throws, and every later write throws too: past a failed write the file's end is unknown. */
  write(row) {
    if (this.broken) throw new Error('the ledger could not be written earlier, so nothing further is authorised');
    const bytes = Buffer.from(`${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
    try {
      for (let at = 0; at < bytes.length;) at += fs.writeSync(this.fd, bytes, at);
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  totalUsd() {
    let total = this.settledUsd;
    for (const usd of this.openCalls.values()) total += usd;
    return total;
  }

  /** A call has been refused, or the ledger can no longer record one: either way, nothing further goes out. */
  stopped() {
    return this.refusedAny || this.broken === true;
  }

  /**
   * @param {{usd:number, model:string, maxTokens?:number}} o - maxTokens: the output ceiling the call asked for, for the record
   * @returns {string|null} the call's id, or null when it would take the total past the stop
   * @throws {Error} the reservation could not be recorded, or is not a number: the call must not go out
   */
  reserve({ usd, model, maxTokens }) {
    if (!Number.isFinite(usd) || usd < 0) throw new Error(`a reservation of ${usd} for ${model} cannot be counted`);
    if (this.totalUsd() + usd > this.stopUsd + 1e-9) {
      this.refusedAny = true;
      this.write({ kind: 'refused', model, usd, totalUsd: this.totalUsd(), stopUsd: this.stopUsd });
      return null;
    }
    const id = crypto.randomBytes(8).toString('hex');
    this.write({ kind: 'reserve', id, model, usd, maxTokens });
    this.openCalls.set(id, usd);
    return id;
  }

  /**
   * @param {string} id
   * @param {object} fields - usd, basis, status and what the provider reported; no text
   */
  settle(id, fields) {
    if (!this.openCalls.has(id)) throw new Error(`settling an unknown call: ${id}`);
    // Written first: if it fails, the call stays at its reservation, here and on disk.
    this.write({ ...fields, kind: 'settle', id });
    this.openCalls.delete(id);
    this.settledUsd += fields.usd;
  }

  close() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
    this.release();
  }
}

module.exports = { PRICES, usageOf, reservationUsd, worstCaseClaimUsd, Ledger, readLedger, acquireLock, JUSTIFIER_MAX_TOKENS };
