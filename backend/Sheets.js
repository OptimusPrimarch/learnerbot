// ============================================================
// Sheets.js \u2014 all data access (read/write the spreadsheet)
//
// One spreadsheet per person. Reads are memoised for the length of a
// single request and every write invalidates the tab it touched, so a
// request opens the spreadsheet once and reads each tab at most once.
// Cells are written as plain text so Sheets never turns user text into
// a formula or a date.
// ============================================================

// New columns are only ever added at the end, and initHeaders() adds a missing header to an existing
// sheet, so older sheets pick them up on the first request after an update.
const TABS = {
  Goals:    ['ID', 'Title', 'Priority', 'Status', 'Created', 'Tags', 'ParentID', 'Due', 'StatusDate', 'Reviewed', 'Ref'],
  Journal:  ['Date', 'Text', 'Tags', 'Minutes', 'ID', 'Status', 'Removed', 'Ref'],
  Reports:  ['Date', 'Type', 'Data', 'Score'],
  Feedback: ['Date', 'Text', 'Ref'],
  History:  ['Week', 'Score', 'Summary'],
  Tasks:    ['ID', 'GoalID', 'Title', 'Status', 'Created', 'StatusDate', 'Ref'],
  Chat:     ['Timestamp', 'Role', 'Text'],
  Settings: ['Key', 'Value'],
  // The Today page (Today.js): items sent by the planner or added by hand. Status is open, done or skipped.
  Today:    ['ID', 'Date', 'Title', 'Source', 'SourceID', 'Points', 'State', 'GoalID', 'Flags', 'Status', 'StatusDate', 'Minutes', 'LogID', 'Ref', 'Note', 'Links']
};

const PRIORITIES    = ['high', 'medium', 'low'];
const GOAL_STATUSES = ['active', 'completed', 'postponed', 'archived'];
const TASK_STATUSES = ['active', 'done', 'removed'];

// ---- Spreadsheet, tab and row access ------------------------

let _ssMemo = null;
const _sheetMemo = {};
const _rowsMemo = {};

// Where a request spends its time, in ms by label (open, tab, read, write, lock). It is sent back
// with every answer so the page can show server time next to total time.
const _prof = {};
function _timeIt(label, fn) {
  const t = Date.now();
  try { return fn(); } finally { _prof[label] = (_prof[label] || 0) + (Date.now() - t); }
}

function _ss() {
  if (_ssMemo) return _ssMemo;
  const id = _props().getProperty('SHEET_ID');
  _ssMemo = _timeIt('open', () => (id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet()));
  if (!_ssMemo) throw _err('no_sheet', 'No spreadsheet found. Open the script from the sheet (Extensions \u2192 Apps Script) or set a SHEET_ID script property.');
  return _ssMemo;
}

function getSheet(name) {
  if (_sheetMemo[name]) return _sheetMemo[name];
  const ss = _ss();
  let sh = _timeIt('tab', () => ss.getSheetByName(name));
  if (!sh) sh = _createTab(ss, name);
  _sheetMemo[name] = sh;
  return sh;
}

function _createTab(ss, name) {
  const sh = ss.insertSheet(name);
  _writeHeader(sh, TABS[name]);
  return sh;
}

function _writeHeader(sh, cols) {
  sh.getRange(1, 1, 1, cols.length)
    .setNumberFormat('@').setValues([cols])
    .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#e6e9ef');
  sh.setFrozenRows(1);
}

/** Creates missing tabs and headers. Safe to run repeatedly (migrates missing columns). */
function initHeaders() {
  const ss = _ss();
  let created = 0;
  Object.keys(TABS).forEach(name => {
    const cols = TABS[name];
    const sh = ss.getSheetByName(name);
    if (!sh) { _createTab(ss, name); created++; return; }
    if (sh.getLastRow() === 0) { _writeHeader(sh, cols); return; }
    const existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    cols.forEach((col, i) => {
      if (!existing.includes(col)) {
        sh.getRange(1, i + 1).setValue(col)
          .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#e6e9ef');
      }
    });
  });
  // A brand-new spreadsheet starts with an empty "Sheet1"; drop it, but only when every one of our
  // tabs was just created. A sheet that already had data is never tidied this way.
  const blank = ss.getSheetByName('Sheet1');
  if (created === Object.keys(TABS).length && blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  Object.keys(_sheetMemo).forEach(k => delete _sheetMemo[k]);
  Object.keys(_rowsMemo).forEach(k => delete _rowsMemo[k]);
}

/** Data rows of a tab (header excluded). With `tail`, only the last `tail` rows. */
function rows(name, tail) {
  const key = name + '|' + (tail || 0);
  if (_rowsMemo[key]) return _rowsMemo[key];
  const sh = getSheet(name);
  const out = _timeIt('read', () => {
    const last = sh.getLastRow();
    const cols = sh.getLastColumn();
    if (last > 1 && cols > 0) {
      const start = tail ? Math.max(2, last - tail + 1) : 2;
      return sh.getRange(start, 1, last - start + 1, cols).getValues();
    }
    return [];
  });
  _rowsMemo[key] = out;
  return out;
}

function _invalidate(name) {
  Object.keys(_rowsMemo).forEach(k => { if (k.indexOf(name + '|') === 0) delete _rowsMemo[k]; });
}

function _appendRow(name, row) {
  const sh = getSheet(name);
  _timeIt('write', () => {
    const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
    rng.setNumberFormat('@');
    rng.setValues([row.map(v => typeof v === 'number' ? v : String(v == null ? '' : v))]);
  });
  _invalidate(name);
}

/** A cell as plain text (real Date cells from older sheets become yyyy-mm-dd). */
function _cell(v) { return v instanceof Date ? _day(v) : String(v == null ? '' : v); }

/** Writes `values` as text into one row, starting at column `col`. `i` is the row's index in rows(name). */
function _writeSpan(name, i, col, values) {
  _timeIt('write', () => {
    const rng = getSheet(name).getRange(i + 2, col, 1, values.length);
    rng.setNumberFormat('@');
    rng.setValues([values]);
  });
  _invalidate(name);
}

/** Deletes whole rows (1-based sheet row numbers) in as few calls as possible, lowest block last so numbers stay valid. */
function _deleteRowNumbers(name, rowNumbers) {
  const sh = getSheet(name);
  const nums = Array.from(new Set(rowNumbers)).sort((a, b) => b - a);
  _timeIt('write', () => {
    let i = 0;
    while (i < nums.length) {
      const start = nums[i];
      let count = 1;
      while (i + count < nums.length && nums[i + count] === start - count) count++;
      sh.deleteRows(start - count + 1, count);
      i += count;
    }
  });
  _invalidate(name);
}

function _setCellById(name, id, col, value) {
  const i = rows(name).findIndex(r => String(r[0]) === String(id));
  if (i < 0) return false;
  const sh = getSheet(name);
  _timeIt('write', () => sh.getRange(i + 2, col).setValue(value));
  _invalidate(name);
  return true;
}

function _nextId(name) {
  const sh = getSheet(name);
  return _timeIt('read', () => {
    const last = sh.getLastRow();
    if (last < 2) return 1;
    return sh.getRange(2, 1, last - 1, 1).getValues()
      .reduce((m, r) => Math.max(m, parseInt(r[0], 10) || 0), 0) + 1;
  });
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  // Not getting the lock means another request was busy writing. That passes, so the page keeps the change and sends it again.
  try { _timeIt('lock', () => lock.waitLock(20000)); }
  catch (e) { throw _err('busy', 'The sheet is busy right now. Your change is kept and will be sent again in a moment.'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

/**
 * The page's own id for one change (a 16-character hex string). A change that was sent but whose answer was lost
 * is sent again with `replay` set; the row it created the first time is found by this id and returned instead of
 * being created twice. Anything that is not a plain hex id is ignored.
 */
function _ref(v) { return typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v) ? v : ''; }
const _refOf = (r, col) => (r[col] !== '' && r[col] != null ? String(r[col]) : '');

// ---- Small helpers ------------------------------------------

function _parseTags(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
}

function _tagString(tags) {
  return _clip(Array.isArray(tags) ? tags.join(',') : tags, LIMITS.tags).toUpperCase();
}

function _clip(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function _priority(p)  { return PRIORITIES.indexOf(p) >= 0 ? p : 'medium'; }

const MAX_MINUTES = 1440;

/** '' (no deadline) or a real calendar date as yyyy-mm-dd. */
function _cleanDue(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 2000 || +m[1] > 2100) {
    throw _err('bad_request', 'The due date must be a real date, year-month-day.');
  }
  return s;
}

/** '' (not recorded) or whole minutes from 1 to 1440. Zero means "not recorded". */
function _cleanMinutes(v) {
  if (v === '' || v == null) return '';
  // Only a number or digits in a string: Number() alone would also accept true, [30] and the like.
  const n = (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v))) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_MINUTES) throw _err('bad_request', 'Time must be a whole number of minutes, up to ' + MAX_MINUTES + '.');
  return n === 0 ? '' : n;
}

// A date or number the model supplied that turns out to be unusable is dropped, not an error.
function _safeDue(v)     { try { return _cleanDue(v); } catch (_) { return ''; } }
function _safeMinutes(v) { try { return _cleanMinutes(v); } catch (_) { return ''; } }

/** Whole days from today to a yyyy-mm-dd date (negative when past). */
function _daysUntil(ymd) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_today()), b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 864e5);
}

// Old rows may hold real Date cells (Sheets parses date-looking text); normalise on read.
function _day(v) { return v instanceof Date ? Utilities.formatDate(v, _tzName(), 'yyyy-MM-dd') : String(v == null ? '' : v); }
function _ts(v)  { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }

function _today() { return Utilities.formatDate(new Date(), _tzName(), 'yyyy-MM-dd'); }

function _daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, _tzName(), 'yyyy-MM-dd');
}

// ---- Goals --------------------------------------------------

function _goal(r) {
  return {
    id: String(r[0]), title: String(r[1]), priority: String(r[2]), status: String(r[3]),
    created: _day(r[4]), tags: _parseTags(r[5]), parentId: r[6] !== '' && r[6] != null ? String(r[6]) : '',
    due: r[7] !== '' && r[7] != null ? _day(r[7]).slice(0, 10) : '',
    // The day the goal last changed status (completed, postponed, removed), and whether a review chose to keep it.
    since: r[8] !== '' && r[8] != null ? _day(r[8]).slice(0, 10) : '',
    kept: r[9] !== '' && r[9] != null
  };
}

function getAllGoals() {
  return rows('Goals').filter(r => r[0] !== '' && r[3] !== 'archived').map(_goal);
}

function getActiveGoals() {
  return getAllGoals().filter(g => g.status === 'active');
}

function getHistoryGoals() {
  return rows('Goals').filter(r => r[0] !== '' && r[3] !== 'active').map(_goal);
}

/** Adds a goal and returns it in the same shape getAllGoals() uses. `due` is optional (yyyy-mm-dd). */
function addGoal(title, priority, tags, parentId, due, ref, replay) {
  const r = _ref(ref);
  if (r && replay) { const hit = rows('Goals').find(x => _refOf(x, 10) === r); if (hit) return _goal(hit); }
  const t = _clip(title, LIMITS.title);
  if (!t) throw _err('bad_request', 'A goal needs a title.');
  const dueDay = _cleanDue(due);
  const parent = parentId ? String(parentId) : '';
  if (parent && !rows('Goals').some(r => String(r[0]) === parent)) throw _err('not_found', 'The parent goal does not exist.');
  return withLock(() => {
    const id = _nextId('Goals');
    const p = _priority(priority);
    const tagStr = _tagString(tags);
    const created = _today();
    _appendRow('Goals', [id, t, p, 'active', created, tagStr, parent, dueDay, '', '', r]);
    return { id: String(id), title: t, priority: p, status: 'active', created: created, tags: _parseTags(tagStr), parentId: parent, due: dueDay, since: '', kept: false };
  });
}

/**
 * Changes the title, priority, tags and/or due date of a goal. Only the fields present in `f` change;
 * a due of '' clears the deadline. The whole row is rewritten in one call. Returns the goal.
 */
function updateGoal(id, f) {
  f = f || {};
  const has = k => Object.prototype.hasOwnProperty.call(f, k);
  const next = {};
  if (has('title')) { next.title = _clip(f.title, LIMITS.title); if (!next.title) throw _err('bad_request', 'A goal needs a title.'); }
  if (has('priority')) next.priority = _priority(f.priority);
  if (has('tags')) next.tags = _tagString(f.tags);
  if (has('due')) next.due = _cleanDue(f.due);
  return withLock(() => {
    const i = rows('Goals').findIndex(r => String(r[0]) === String(id));
    if (i < 0) throw _err('not_found', 'Goal not found.');
    const row = rows('Goals')[i].slice();
    while (row.length < TABS.Goals.length) row.push('');
    if ('title' in next)    row[1] = next.title;
    if ('priority' in next) row[2] = next.priority;
    if ('tags' in next)     row[5] = next.tags;
    if ('due' in next)      row[7] = next.due;
    const out = row.slice(0, TABS.Goals.length).map((v, c) => (c === 0 && typeof v === 'number') ? v : (v instanceof Date ? _day(v) : String(v == null ? '' : v)));
    _timeIt('write', () => {
      const rng = getSheet('Goals').getRange(i + 2, 1, 1, out.length);
      rng.setNumberFormat('@');
      rng.setValues([out]);
    });
    _invalidate('Goals');
    return _goal(out);
  });
}

/** Changes a goal's status and records the day, so completed and removed goals know how old they are. */
function setGoalStatus(id, status) {
  if (GOAL_STATUSES.indexOf(status) < 0) throw _err('bad_request', 'Unknown goal status.');
  const i = rows('Goals').findIndex(r => String(r[0]) === String(id));
  if (i < 0) return false;
  const r = rows('Goals')[i];
  // Columns 4 to 10: Status, Created, Tags, ParentID, Due, StatusDate, Reviewed (a change of status clears an earlier "kept").
  _writeSpan('Goals', i, 4, [status, _cell(r[4]), _cell(r[5]), _cell(r[6]), _cell(r[7]), status === 'active' ? '' : _today(), '']);
  return true;
}

// ---- Tasks --------------------------------------------------

function getAllTasks() {
  return rows('Tasks').filter(r => r[0] !== '' && r[3] !== 'removed')
    .map(_task);
}

const _task = r => ({ id: String(r[0]), goalId: String(r[1]), title: String(r[2]), status: String(r[3]), created: _day(r[4]) });

function addTask(goalId, title, ref, replay) {
  const rf = _ref(ref);
  if (rf && replay) { const hit = rows('Tasks').find(x => _refOf(x, 6) === rf); if (hit) return _task(hit); }
  const t = _clip(title, LIMITS.title);
  if (!t) throw _err('bad_request', 'A task needs a title.');
  if (!rows('Goals').some(r => String(r[0]) === String(goalId))) throw _err('not_found', 'That goal does not exist.');
  return withLock(() => {
    const id = _nextId('Tasks');
    const created = _today();
    _appendRow('Tasks', [id, String(goalId), t, 'active', created, '', rf]);
    return { id: String(id), goalId: String(goalId), title: t, status: 'active', created: created };
  });
}

function setTaskStatus(id, status) {
  if (TASK_STATUSES.indexOf(status) < 0) throw _err('bad_request', 'Unknown task status.');
  const i = rows('Tasks').findIndex(r => String(r[0]) === String(id));
  if (i < 0) return false;
  const r = rows('Tasks')[i];
  _writeSpan('Tasks', i, 4, [status, _cell(r[4]), status === 'active' ? '' : _today()]);   // Status, Created, StatusDate
  return true;
}

// ---- Chat ---------------------------------------------------

function getChatHistory(n) {
  const count = n || 30;
  // A "new conversation" is a divider row. Only what comes after the last one belongs to the current conversation;
  // earlier messages stay in the sheet but are no longer shown.
  const tail = rows('Chat', Math.max(count, 300)).filter(r => r[1] && r[2]);
  let from = 0;
  tail.forEach((r, i) => { if (String(r[1]) === 'divider') from = i + 1; });
  return tail.slice(from).slice(-count).map(r => ({ ts: _ts(r[0]), role: String(r[1]), text: String(r[2]) }));
}

/** Starts a fresh conversation with the assistant: later messages are shown (and, when the assistant gains memory, used) on their own. */
function startNewChat() {
  withLock(() => _appendRow('Chat', [new Date().toISOString(), 'divider', 'new conversation']));
  return { chatHistory: [] };
}
function saveChatMessage(role, text) {
  withLock(() => _appendRow('Chat', [new Date().toISOString(), role, _clip(text, LIMITS.text)]));
}

// ---- Journal ------------------------------------------------

const JOURNAL_TAIL = 1500;

/** Entries that have not been removed (a removed entry stays in the sheet, hidden, until it is purged). */
function _visibleJournal(tail) { return rows('Journal', tail).filter(r => r[5] !== 'removed'); }

/** Logs an entry for today and returns it. `minutes` is optional (whole minutes; the page offers 15-minute steps). */
function addJournalEntry(text, tags, minutes, ref, replay) {
  const rf = _ref(ref);
  if (rf && replay) { const hit = _journalEntryByRef(rf); if (hit) return hit; }
  const t = _clip(text, LIMITS.text);
  if (!t) throw _err('bad_request', 'Nothing to log.');
  const mins = _cleanMinutes(minutes);
  return withLock(() => {
    const id = _nextJournalId(), date = _today(), tagStr = _tagString(tags);
    _appendRow('Journal', [date, t, tagStr, mins, id, '', '', rf]);
    return { id: String(id), date: date, text: t, tags: _parseTags(tagStr), minutes: mins === '' ? 0 : mins };
  });
}

function _minutes(v) { const n = Number(v); return v !== '' && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_MINUTES) : 0; }

/** Entries from the last `days` days (0 minutes means none was recorded). */
function getRecentJournal(days) {
  const cutoff = _daysAgo(days || 7);
  return _visibleJournal(JOURNAL_TAIL).filter(r => r[1] && _day(r[0]) >= cutoff)
    .map(r => ({ date: _day(r[0]), text: String(r[1]), tags: _parseTags(r[2]), minutes: _minutes(r[3]) }));
}

/** Total recorded minutes over the last 7 days, today included. */
function weekMinutes() {
  const cutoff = _daysAgo(6);
  return _visibleJournal(JOURNAL_TAIL).filter(r => r[1] && _day(r[0]) >= cutoff)
    .reduce((sum, r) => sum + _minutes(r[3]), 0);
}

function getStreak() {
  const days = new Set(_visibleJournal(JOURNAL_TAIL).filter(r => r[0]).map(r => _day(r[0]).slice(0, 10)));
  if (!days.size) return 0;
  // Not having logged yet today doesn't break a streak; yesterday still counts.
  const offset = days.has(_daysAgo(0)) ? 0 : 1;
  let streak = 0;
  while (streak < 365 && days.has(_daysAgo(offset + streak))) streak++;
  return streak;
}

// ---- Settings (small key/value pairs that live in the sheet, so they outlive a re-copied script) ----

function getSetting(key) {
  const r = rows('Settings').find(x => String(x[0]) === key);
  return r ? String(r[1] == null ? '' : r[1]) : '';
}

/** Stores the text exactly as given (no trimming of inner text); whitespace-only counts as empty. */
function setSetting(key, value, max) {
  let v = String(value == null ? '' : value).replace(/\r\n?/g, '\n').slice(0, max || LIMITS.text);
  if (!v.trim()) v = '';
  return withLock(() => { _putSetting(key, v); return v; });
}

/** Writes one Settings row (adds it if missing). The caller already holds the lock: locks cannot be nested. */
function _putSetting(key, v) {
  const i = rows('Settings').findIndex(x => String(x[0]) === key);
  if (i < 0) { _appendRow('Settings', [key, v]); return; }
  _timeIt('write', () => {
    const rng = getSheet('Settings').getRange(i + 2, 2);
    rng.setNumberFormat('@');
    rng.setValue(v);
  });
  _invalidate('Settings');
}

/** The saved look ({theme, primary, accent, font}), or null when none has been saved or the saved text is not usable. */
function getAppearance() {
  const raw = getSetting('appearance');
  if (!raw) return null;
  try { return _cleanAppearance(JSON.parse(raw)); } catch (_) { return null; }
}

/**
 * Checks a look and returns it in canonical form; throws on anything unknown. A missing theme or font means
 * the default, and a blank accent means "the theme's own accent". `primary` is the page colour of the Custom
 * theme and `accent` the colour of buttons and highlights; each is blank or a #rrggbb colour.
 */
function _cleanAppearance(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw _err('bad_request', 'That look is not valid.');
  const theme = a.theme == null || a.theme === '' ? 'dark' : a.theme;
  const font = a.font == null || a.font === '' ? 'system' : a.font;
  if (typeof theme !== 'string' || APPEARANCE_THEMES.indexOf(theme) < 0) throw _err('bad_request', 'Unknown theme.');
  if (typeof font !== 'string' || APPEARANCE_FONTS.indexOf(font) < 0) throw _err('bad_request', 'Unknown font.');
  const colour = (v, what) => {
    if (v == null || v === '') return '';
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw _err('bad_request', 'The ' + what + ' color must look like #6ea8fe.');
    return v.toLowerCase();
  };
  return { theme: theme, primary: colour(a.primary, 'primary'), accent: colour(a.accent, 'accent'), font: font };
}

function setAppearance(a) {
  const look = _cleanAppearance(a);
  setSetting('appearance', JSON.stringify(look), 200);
  return look;
}

function getCoachVoice()      { return getSetting('coach_voice'); }
function setCoachVoice(text)  { return setSetting('coach_voice', text, LIMITS.voice); }

// ---- My voices: coach voices the person wrote and keeps, so they can switch between them ----
// Stored as one JSON list in the Settings tab (key my_voices): [{ id, name, text }]. Choosing one only fills the voice
// box on the page; the voice the coach uses is still coach_voice, saved the usual way, so nothing here changes the coach.

/** Text as typed (line breaks normalised, stray control characters dropped), cut to the voice limit; '' when blank. */
function _voiceText(v) {
  const t = String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, LIMITS.voice);
  return t.trim() ? t : '';
}

/** A name for a saved voice: one line, single spaces, cut to the limit. */
function _voiceName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, LIMITS.voiceName); }

/** The saved voices, oldest first. An unreadable or odd saved list is treated as having nothing in it. */
function getMyVoices() {
  const raw = getSetting('my_voices');
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const seen = {};
  return list.filter(x => x && typeof x === 'object' && typeof x.id === 'string' && /^v\d{1,6}$/.test(x.id) && !seen[x.id] && (seen[x.id] = true))
    .map(x => ({ id: x.id, name: _voiceName(x.name), text: _voiceText(x.text) }))
    .filter(x => x.name && x.text)
    .slice(0, LIMITS.myVoices);
}

function _storeMyVoices(list) {
  const json = JSON.stringify(list);
  if (json.length > 45000) throw _err('bad_request', 'Those voices are too long to keep. Shorten or remove some.');   // a cell holds 50,000 characters
  _putSetting('my_voices', json);
}

/** Keeps a voice under a name (a name already in the list, in any capitals, is replaced). Answers with the whole list. */
function saveMyVoice(name, text) {
  const n = _voiceName(name), t = _voiceText(text);
  if (!n) throw _err('bad_request', 'Give this voice a name.');
  if (!t) throw _err('bad_request', 'Write the voice first, then save it.');
  return withLock(() => {
    _invalidate('Settings');
    const list = getMyVoices();
    const same = list.findIndex(v => v.name.toLowerCase() === n.toLowerCase());
    if (same >= 0) list[same] = { id: list[same].id, name: n, text: t };
    else {
      if (list.length >= LIMITS.myVoices) throw _err('bad_request', 'You can keep ' + LIMITS.myVoices + ' voices of your own. Remove one first.');
      const next = list.reduce((m, v) => Math.max(m, Number(v.id.slice(1))), 0) + 1;
      list.push({ id: 'v' + next, name: n, text: t });
    }
    _storeMyVoices(list);
    return list;
  });
}

/** Forgets a saved voice (one that is already gone is not an error). Answers with the whole list. */
function removeMyVoice(id) {
  return withLock(() => {
    _invalidate('Settings');
    const list = getMyVoices();
    const keep = list.filter(v => v.id !== String(id));
    if (keep.length !== list.length) _storeMyVoices(keep);
    return keep;
  });
}

// ---- Feedback -----------------------------------------------

function addFeedback(text, ref, replay) {
  const rf = _ref(ref);
  if (rf && replay && rows('Feedback').some(x => _refOf(x, 2) === rf)) return;
  const t = _clip(text, LIMITS.text);
  if (!t) throw _err('bad_request', 'Nothing to send.');
  withLock(() => _appendRow('Feedback', [_today(), t, rf]));
}

function getRecentFeedback(n) {
  const count = n || 5;
  return rows('Feedback', count).slice(-count).filter(r => r[1])
    .map(r => ({ date: _day(r[0]), text: String(r[1]) }));
}

// ---- Reports ------------------------------------------------

function saveReport(type, data) {
  const score = (type === 'weekly' && data.score != null) ? data.score : '';
  withLock(() => _appendRow('Reports', [new Date().toISOString(), type, JSON.stringify(data), score]));
}

function getLatestReport(type) {
  const sh = getSheet('Reports');
  const last = sh.getLastRow();
  if (last < 2) return null;
  // Scan only the small Type column, then read the one matching row.
  const types = sh.getRange(2, 2, last - 1, 1).getValues();
  for (let i = types.length - 1; i >= 0; i--) {
    if (types[i][0] !== type) continue;
    const r = sh.getRange(i + 2, 1, 1, 4).getValues()[0];
    try { return { date: _ts(r[0]), type: String(r[1]), data: JSON.parse(r[2]), score: r[3] }; }
    catch (_) { /* unreadable row \u2014 keep looking */ }
  }
  return null;
}

// ---- History ------------------------------------------------

function addHistoryEntry(score, summary) {
  withLock(() => _appendRow('History', [_today(), score, _clip(summary, LIMITS.text)]));
}

function getRecentHistory(n) {
  const count = n || 5;
  return rows('History', count).slice(-count).filter(r => r[0])
    .map(r => ({ week: _day(r[0]), score: r[1] === '' ? null : Number(r[1]), summary: String(r[2]) }));
}

