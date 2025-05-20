// services/commitStore.js
const fs   = require('fs').promises;
const path = require('path');
const DB   = path.join(__dirname, '..', '.commit-db.json');

async function _load() {
  try { return JSON.parse(await fs.readFile(DB, 'utf8')); }
  catch { return {}; }          // first run – file doesn’t exist yet
}
async function _save(db) { await fs.writeFile(DB, JSON.stringify(db, null, 2)); }

exports.save = async (hash, obj) => {
  const db = await _load();
  db[hash] = obj;
  await _save(db);
};

exports.get  = async (hash) => (await _load())[hash];
exports.del  = async (hash) => {
  const db = await _load();
  delete db[hash];
  await _save(db);
};

/**
 * Purge commitments older than `maxAgeMs`.
 * 
 * @param {number} [maxAgeMs]  Retention window in milliseconds.
 *                             Default = 3 days.
 * @returns {number}           How many entries were deleted.
 *
 * Usage example:
 *   const removed = await commitStore.purgeStale();          // 3-day default
 *   const removed = await commitStore.purgeStale(7*24*60*60*1000); // 7 days
 */
exports.purgeStale = async function purgeStale(maxAgeMs = 3 * 24 * 60 * 60 * 1000) {
  const db      = await _load();
  const cutoff  = Date.now() - maxAgeMs;
  let   removed = 0;

  for (const [hash, entry] of Object.entries(db)) {
    const createdMs = Date.parse(entry.created);   // ISO-8601 → ms
    if (!isNaN(createdMs) && createdMs < cutoff) {
      delete db[hash];
      removed++;
    }
  }

  if (removed) await _save(db);
  return removed;
};

