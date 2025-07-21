// services/commitStore.js
const { Mutex } = require('async-mutex');
const fs       = require('fs').promises;
const path     = require('path');

///////////////////////////////////////////////////////////////////////////////
// Flip this to switch between modes
//   true  → original behaviour (every call touches the JSON file)
//   false → RAM-only (never touches the JSON file)
//
// No other differences.
///////////////////////////////////////////////////////////////////////////////
const USE_FILE = false;           // ← change to false for memory-only tests

const DB_FILE  = path.join(__dirname, '..', '.commit-db.json');
const mtx      = new Mutex();

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */
async function _load () {
  if (!USE_FILE) {                              // RAM-only
    return _load._mem || (_load._mem = {});     // singleton in-process store
  }

  // file mode – read & parse on **every call**, exactly like the original
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch {
    return {};                                 // first run or corrupt file
  }
}

async function _save (obj) {
  if (!USE_FILE) {               // RAM-only
    _load._mem = obj;            // keep in-memory copy current
    return;
  }

  // file mode – rewrite the whole file atomically (unchanged)
  const tmp = DB_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, DB_FILE);
}

/* ------------------------------------------------------------------------ */
/* Public API – unchanged                                                   */
/* ------------------------------------------------------------------------ */
exports.save = async (hash, entry) =>
  mtx.runExclusive(async () => {
    const db = await _load();
    db[hash] = entry;
    await _save(db);
  });

exports.get  = async (hash) =>
  mtx.runExclusive(async () => (await _load())[hash]);

exports.del  = async (hash) =>
  mtx.runExclusive(async () => {
    const db = await _load();
    delete db[hash];
    await _save(db);
  });

exports.purgeStale = async function purgeStale (maxAgeMs = 3 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const db     = await _load();
  let   removed = 0;

  for (const [h, e] of Object.entries(db)) {
    if (Date.parse(e.created) < cutoff) { delete db[h]; removed++; }
  }
  if (removed) await _save(db);
  return removed;
};

