// ============================================================
// Log.js \u2014 looking back at, editing and removing journal entries
//
// Entries used to be write-only. Each one now has an id and a status, so it can be listed, changed or
// removed. Removing hides an entry (it stays in the sheet, out of sight, and the person can bring it back
// for a moment with Undo); Tidy.js deletes hidden entries for good after the keep-for period.
// ============================================================

const LOG_MAX_ENTRIES = 500;     // most entries sent in one answer
const LOG_READ_ROWS = 5000;      // most rows looked at in one request

/**
 * Gives every entry that has no id one (oldest first), so any entry can be named later. Entries written by
 * older versions have none. The first call on a sheet writes them; afterwards it is remembered for six hours
 * and costs nothing.
 */
function ensureJournalIds() {
  const cache = CacheService.getScriptCache();
  if (cache.get('jids_ok')) return 0;
  const sh = getSheet('Journal');
  const last = sh.getLastRow();
  let added = 0;
  if (last >= 2) {
    added = withLock(() => {
      const rng = sh.getRange(2, 5, last - 1, 1);
      const ids = _timeIt('read', () => rng.getValues());
      let max = ids.reduce((m, r) => Math.max(m, parseInt(r[0], 10) || 0), 0), n = 0;
      const out = ids.map(r => { if (r[0] !== '' && r[0] != null) return [String(r[0])]; n++; return [String(++max)]; });
      if (n) {
        _timeIt('write', () => { rng.setNumberFormat('@'); rng.setValues(out); });
        _invalidate('Journal');
      }
      return n;
    });
  }
  cache.put('jids_ok', '1', 21600);
  return added;
}

/** The next entry id: one more than the largest in the ID column. */
function _nextJournalId() {
  const sh = getSheet('Journal');
  return _timeIt('read', () => {
    const last = sh.getLastRow();
    if (last < 2) return 1;
    return sh.getRange(2, 5, last - 1, 1).getValues().reduce((m, r) => Math.max(m, parseInt(r[0], 10) || 0), 0) + 1;
  });
}

/** The entry a change created earlier, found by the page's id for that change (see _ref). */
function _journalEntryByRef(ref) {
  const sh = getSheet('Journal');
  const last = sh.getLastRow();
  if (last < 2 || sh.getLastColumn() < 8) return null;
  const refs = _timeIt('read', () => sh.getRange(2, 8, last - 1, 1).getValues());
  const k = refs.findIndex(r => String(r[0]) === ref);
  if (k < 0) return null;
  const row = _timeIt('read', () => sh.getRange(k + 2, 1, 1, 8).getValues()[0]);
  if (row[4] === '' || row[4] == null) return null;
  return { id: String(row[4]), date: _day(row[0]).slice(0, 10), text: String(row[1]), tags: _parseTags(row[2]), minutes: _minutes(row[3]) };
}

/** The 1-based sheet row of an entry (hidden ones included), or 0 when there is none. */
function _journalRowNumber(id) {
  const sh = getSheet('Journal');
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = _timeIt('read', () => sh.getRange(2, 5, last - 1, 1).getValues());
  const k = ids.findIndex(r => String(r[0]) === String(id));
  return k < 0 ? 0 : k + 2;
}

function _logEntry(r) {
  return { id: String(r[4]), date: _day(r[0]).slice(0, 10), text: String(r[1]), tags: _parseTags(r[2]), minutes: _minutes(r[3]) };
}

/**
 * The person's own log, newest first. `days` (default 30) says how far back to look; `more` is true when
 * older entries exist beyond that, so the page can offer "Show older".
 */
function getLog(args) {
  args = args || {};
  const days = Math.max(1, Math.min(Number(args.days) || 30, 3650));
  ensureJournalIds();
  const cutoff = _daysAgo(days);
  const visible = _visibleJournal(LOG_READ_ROWS).filter(r => r[1] && r[4] !== '' && r[4] != null);
  const inWindow = visible.filter(r => _day(r[0]) >= cutoff).map(_logEntry);
  inWindow.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : Number(b.id) - Number(a.id)));
  const older = visible.length > inWindow.length || getSheet('Journal').getLastRow() - 1 > LOG_READ_ROWS;
  const entries = inWindow.slice(0, LOG_MAX_ENTRIES);
  return { entries: entries, days: days, more: older || inWindow.length > entries.length };
}

/** Changes the text, tags and/or time of an entry; only the fields present in `f` change. */
function updateLog(id, f) {
  f = f || {};
  const has = k => Object.prototype.hasOwnProperty.call(f, k);
  const next = {};
  if (has('text')) { next.text = _clip(f.text, LIMITS.text); if (!next.text) throw _err('bad_request', 'An entry needs some text.'); }
  if (has('tags')) next.tags = _tagString(f.tags);
  if (has('minutes')) next.minutes = _cleanMinutes(f.minutes);
  ensureJournalIds();
  return withLock(() => {
    const at = _journalRowNumber(id);
    if (!at) throw _err('not_found', 'That entry was not found.');
    const sh = getSheet('Journal');
    const row = _timeIt('read', () => sh.getRange(at, 1, 1, 7).getValues()[0]);
    if (row[5] === 'removed') throw _err('not_found', 'That entry was removed.');
    if ('text' in next) row[1] = next.text;
    if ('tags' in next) row[2] = next.tags;
    if ('minutes' in next) row[3] = next.minutes;
    _timeIt('write', () => {
      const rng = sh.getRange(at, 2, 1, 3);
      rng.setNumberFormat('@');
      rng.setValues([[_cell(row[1]), _cell(row[2]), _cell(row[3])]]);
    });
    _invalidate('Journal');
    return _logEntry(row);
  });
}

/** Hides an entry (it is deleted for good later). Answers with the chips the page shows. */
function removeLog(id) {
  ensureJournalIds();
  const out = withLock(() => {
    const at = _journalRowNumber(id);
    if (!at) throw _err('not_found', 'That entry was not found.');
    _timeIt('write', () => {
      const rng = getSheet('Journal').getRange(at, 6, 1, 2);
      rng.setNumberFormat('@');
      rng.setValues([['removed', _today()]]);
    });
    _invalidate('Journal');
    return { id: String(id) };
  });
  out.streak = getStreak();
  out.weekMinutes = weekMinutes();
  maybePurge();
  return out;
}

/** Brings a hidden entry back (Undo). It cannot come back once it has been deleted for good. */
function restoreLog(id) {
  ensureJournalIds();
  const out = withLock(() => {
    const at = _journalRowNumber(id);
    if (!at) throw _err('not_found', 'That entry is gone for good, so it cannot be brought back.');
    const sh = getSheet('Journal');
    const row = _timeIt('read', () => sh.getRange(at, 1, 1, 7).getValues()[0]);
    _timeIt('write', () => {
      const rng = sh.getRange(at, 6, 1, 2);
      rng.setNumberFormat('@');
      rng.setValues([['', '']]);
    });
    row[5] = '';
    _invalidate('Journal');
    return { entry: _logEntry(row) };
  });
  out.streak = getStreak();
  out.weekMinutes = weekMinutes();
  return out;
}

