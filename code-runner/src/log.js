'use strict';

/**
 * JSON-lines logging to stdout. Logs carry ids, outcomes and causes, never
 * the token, a request body or a claim's content.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLog({ level = process.env.LOG_LEVEL || 'info', stream = process.stdout } = {}) {
  const min = LEVELS[level] || LEVELS.info;
  const write = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields })}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

module.exports = { createLog };
