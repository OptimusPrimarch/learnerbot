// Today.js: the to-do list (a folded card on the Goals Dashboard) and Today's Look (the day from 8 AM to 8 PM, with things placed on it).
//
// A planner on the owner's computer gathers the day's work (calendar gaps, work items, team objectives) into a file and
// sends a trimmed copy here with setTodayFeed. Titles arrive already shortened, and nothing else about the work (links,
// descriptions, people, meeting names) is ever sent. The 7am coach reads this tab, and so does the Today page.
// Items can be linked to a goal, and linking is optional. Checking one off asks for the time it took and saves a log entry.
//
// Tab columns (see TABS in Sheets.js):
//   0 ID  1 Date  2 Title  3 Source (planner | me)  4 SourceID  5 Points  6 State  7 GoalID  8 Flags
//   9 Status (open | done | skipped | closed)  10 StatusDate  11 Minutes  12 LogID  13 Ref  14 Note  15 Links (JSON)
//   16 Start (hh:mm, when it is placed on Today's Look)  17 Dur (minutes)  18 Tags (focus blocks)
//   Source is planner (work items), google-task (Google Tasks, see GTasks.js) or me (added by hand), plus two kinds that exist only on the
//   calendar view: focus (a loose block of work or learning, taggable) and focus-action (a bullet from the daily focus, placed on the day). closed = it left its source
//   (finished or dropped there) since the last refresh.

const TODAY_STATUSES = ['open', 'done', 'skipped', 'closed'];
const TODAY_MAX_ITEMS = 60;
const TODAY_TITLE_MAX = 80;
const TODAY_KEEP_DAYS = 45;      // older rows are removed whenever a feed arrives; their log entries stay
const TODAY_CARRY_DAYS = 3;      // open items from the last few days are shown as "carried over"
const TODAY_META_KEY = 'today_feed';
const TODAY_COACH_ITEMS = 20;
const LOOK_START = 8 * 60;       // Today's Look runs from 8am ...
const LOOK_END = 20 * 60;        // ... to 8pm
const LOOK_MIN = 15, LOOK_MAX = 240;
const _isBlockSource = s => s === 'focus' || s === 'focus-action';

const _todayItem = r => ({
  id: String(r[0]), date: _day(r[1]).slice(0, 10), title: String(r[2]), source: String(r[3] || 'me'),
  sourceId: String(r[4] || ''), points: r[5] === '' || r[5] == null ? null : Number(r[5]),
  state: String(r[6] || ''), goalId: r[7] === '' || r[7] == null ? '' : String(r[7]),
  flags: String(r[8] || '').split(',').map(s => s.trim()).filter(Boolean),
  status: TODAY_STATUSES.indexOf(String(r[9])) >= 0 ? String(r[9]) : 'open',
  doneOn: r[10] === '' || r[10] == null ? '' : _day(r[10]).slice(0, 10),
  minutes: r[11] === '' || r[11] == null ? 0 : _minutes(r[11]),
  logId: String(r[12] || ''), note: String(r[14] || ''), links: _parseLinks(r[15]),
  start: _cleanHm(r[16]), dur: r[17] === '' || r[17] == null ? 0 : Math.max(0, Math.min(LOOK_MAX, Math.round(Number(r[17]) || 0))),
  tags: _parseTags(r[18])
});

/** Links on an item (a Google Task and what it points at). Only https links to Google are kept, so nothing odd can be opened from here. */
function _cleanLinks(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(x => {
    const u = String((x && (x.u || x.link)) || '').trim().slice(0, 400);
    if (out.length < 3 && /^https:\/\/([a-z0-9-]+\.)*google\.com\/[^\s"<>]*$/i.test(u)) out.push({ u: u, d: _clip((x && (x.d || x.description)) || '', 40) });
  });
  return out;
}
function _parseLinks(raw) {
  if (!raw) return [];
  try { return _cleanLinks(JSON.parse(String(raw))); } catch (_) { return []; }
}

/** Tags used on focus blocks lately, most used first, so the page can offer them. */
function _tagHints(all) {
  const n = {};
  all.filter(t => t.source === 'focus').forEach(t => t.tags.forEach(g => { n[g] = (n[g] || 0) + 1; }));
  return Object.keys(n).sort((a, b) => n[b] - n[a] || (a < b ? -1 : 1)).slice(0, 8);
}

function _todayRows() { return rows('Today').filter(r => r[0] !== '' && r[0] != null); }

function _todayMeta() {
  try { const m = JSON.parse(getSetting(TODAY_META_KEY) || 'null'); return m && typeof m === 'object' ? m : null; }
  catch (_) { return null; }
}

/** What the page and the coach need: today's items, anything still open from the last few days, and the feed's summary. */
function getTodayView() {
  const today = _today();
  const cutoff = _daysAgo(TODAY_CARRY_DAYS);
  const all = _todayRows().map(_todayItem);
  const items = all.filter(t => t.date === today);
  const have = {};
  items.forEach(t => { have[t.source + '|' + (t.sourceId || t.title)] = true; });
  const carried = all.filter(t => t.date < today && t.date >= cutoff && t.status === 'open' && !_isBlockSource(t.source) && !have[t.source + '|' + (t.sourceId || t.title)]);
  const meta = _todayMeta();
  const gcal = getGoogleCalStatus();
  const sched = _scheduleFor(meta, gcal);
  // With a schedule, `feed` carries the merged windows even before the planner has delivered today's plan.
  const feed = sched ? Object.assign({}, meta || { date: today, at: '', objectives: [] },
    { busy: sched.busy, focus: sched.focus, budget: sched.budget, allDay: sched.allDay, sources: sched.sources }) : meta;
  return { date: today, fresh: !!meta && meta.date === today, feed: feed, items: items, carried: carried, tasks: getGoogleTasksStatus(), calendar: gcal, schedule: getWorkdaySchedule(),
    busy: sched ? sched.busyAll : [], tagHints: _tagHints(all) };
}

// ---- cleaning what arrives ------------------------------------

function _cleanPoints(v) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : '';
}

function _cleanHm(v) { return /^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : ''; }

/** The work day the schedule is computed with (set in the planner's .env); anything odd falls back to the defaults. */
function _cleanSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  const hm = (v, d) => (/^\d{2}:\d{2}$/.test(String(v)) && _toMin(v) < 1440 ? String(v) : d);
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return { workStart: hm(s.workStart, WORK_DEFAULTS.workStart), workEnd: hm(s.workEnd, WORK_DEFAULTS.workEnd),
    minFocus: Math.round(num(s.minFocus, 15, 240, WORK_DEFAULTS.minFocus)), hoursPerPoint: num(s.hoursPerPoint, 0.5, 24, WORK_DEFAULTS.hoursPerPoint) };
}

function _cleanFeedMeta(date, m) {
  m = m && typeof m === 'object' ? m : {};
  const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
  const win = w => ({ start: _cleanHm(w && w.start), end: _cleanHm(w && w.end), minutes: Math.max(0, Math.min(1440, Math.round(Number(w && w.minutes) || 0))) });
  return {
    date: date,
    at: new Date().toISOString(),
    budget: _cleanPoints(m.budget),
    focus: list(m.focus, 12).map(win).filter(w => w.start && w.end),
    busy: list(m.busy, 40).map(w => ({ start: _cleanHm(w && w.start), end: _cleanHm(w && w.end), src: w && (w.src === 'Outlook' || w.src === 'Google') ? w.src : '' })).filter(w => w.start && w.end),
    allDay: Math.max(0, Math.min(20, Math.round(Number(m.allDay) || 0))),   // how many all-day items, never their names
    outlookKnown: m.outlookKnown !== false,                                  // false: the planner had no Outlook calendar for today
    settings: _cleanSettings(m.settings),
    objectives: list(m.objectives, 12).map(o => ({
      key: _clip(o && o.key, 12), name: _clip(o && o.name, 80),
      progress: Math.max(0, Math.min(100, Math.round(Number(o && o.progress) || 0))), due: _clip(o && o.due, 10)
    })).filter(o => o.name)
  };
}

function _appendRows(name, list) {
  if (!list.length) return;
  const sh = getSheet(name);
  _timeIt('write', () => {
    const rng = sh.getRange(sh.getLastRow() + 1, 1, list.length, list[0].length);
    rng.setNumberFormat('@');
    rng.setValues(list.map(row => row.map(v => (typeof v === 'number' ? v : String(v == null ? '' : v)))));
  });
  _invalidate(name);
}

// ---- the feed from the planner --------------------------------

/**
 * Adds new items for `date` from one source, refreshes the wording of ones it already has (the person's own choices are never touched),
 * and, when `complete` says the list is the whole truth, closes open items the source no longer lists. Call inside withLock.
 */
function _upsertItems(date, source, items, complete) {
  let added = 0, updated = 0, closed = 0;
  const fresh = [];
  const seen = {};
  let nextId = _nextId('Today');
  items.forEach(x => {
    seen[x.sourceId] = true;
    const links = x.links && x.links.length ? JSON.stringify(x.links) : '';
    const i = rows('Today').findIndex(r => r[0] !== '' && _day(r[1]).slice(0, 10) === date && String(r[3]) === source && String(r[4]) === x.sourceId);
    if (i >= 0) {
      const r = rows('Today')[i];
      // Title, points, state, flags, note and links follow the source. Status, goal link, time and log entry are the person's.
      _writeSpan('Today', i, 3, [x.title, source, x.sourceId, x.points, x.state, _cell(r[7]), x.flags]);   // Title .. Flags
      _writeSpan('Today', i, 15, [x.note, links]);                                                          // Note, Links
      updated++;
    } else {
      fresh.push([String(nextId++), date, x.title, source, x.sourceId, x.points, x.state, '', x.flags, 'open', '', '', '', '', x.note, links]);
      added++;
    }
  });
  _appendRows('Today', fresh);
  if (complete) {
    rows('Today').forEach((r, i) => {
      if (r[0] !== '' && _day(r[1]).slice(0, 10) === date && String(r[3]) === source && String(r[9]) === 'open' && !seen[String(r[4])]) {
        _writeSpan('Today', i, 10, ['closed', _today()]);   // Status, StatusDate
        closed++;
      }
    });
  }
  return { added: added, updated: updated, closed: closed };
}

/** Master connection only. `complete: true` says this is the whole list of work items today, so ones missing from it are closed. */
function setTodayFeed(a) {
  _needMaster();
  a = a || {};
  const date = String(a.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw _err('bad_request', 'The feed needs a date (yyyy-mm-dd).');
  const away = _daysUntil(date);
  if (away == null || Math.abs(away) > 1) throw _err('bad_request', 'That feed is for ' + date + ', which is not today.');
  const incoming = (Array.isArray(a.items) ? a.items : []).slice(0, TODAY_MAX_ITEMS).map(x => ({
    sourceId: _clip(x && x.sourceId, 40), title: _clip(x && x.title, TODAY_TITLE_MAX), points: _cleanPoints(x && x.points),
    state: _clip(x && x.state, 30),
    flags: (Array.isArray(x && x.flags) ? x.flags : []).slice(0, 6).map(f => _clip(f, 24).replace(/,/g, ' ')).filter(Boolean).join(','),
    note: _clip(x && x.note, 80), links: []
  })).filter(x => x.title && x.sourceId);

  const out = withLock(() => {
    const previous = _todayRows().length;
    const r = _upsertItems(date, 'planner', incoming, a.complete === true);
    _setTodayMeta(date, a.meta);
    const purged = _purgeOldToday();
    return { added: r.added, updated: r.updated, closed: r.closed, purged: purged, count: incoming.length, previous: previous };
  });
  // Google Tasks refresh with every feed (6 AM and 3 PM). Outside the lock above because it takes its own; it never throws.
  out.tasks = refreshGoogleTasks();
  out.calendar = refreshGoogleCalendar();
  out.view = getTodayView();
  return out;
}

function _setTodayMeta(date, meta) { _putSetting(TODAY_META_KEY, JSON.stringify(_cleanFeedMeta(date, meta))); }

function _purgeOldToday() {
  const cutoff = _daysAgo(TODAY_KEEP_DAYS);
  const nums = [];
  rows('Today').forEach((r, i) => { if (r[0] !== '' && _day(r[1]).slice(0, 10) < cutoff) nums.push(i + 2); });
  if (nums.length) _deleteRowNumbers('Today', nums);
  return nums.length;
}

// ---- the person's own changes ---------------------------------

function _todayIndex(id) {
  const i = rows('Today').findIndex(r => String(r[0]) === String(id));
  if (i < 0) throw _err('not_found', 'That task was not found.');
  return i;
}

function _goalExists(goalId) {
  return rows('Goals').some(r => String(r[0]) === String(goalId));
}

function addTodayTask(a) {
  a = a || {};
  const rf = _ref(a.ref);
  if (rf && a.replay === true) { const hit = _todayRows().find(r => String(r[13]) === rf); if (hit) return { task: _todayItem(hit) }; }
  const title = _clip(a.title, TODAY_TITLE_MAX);
  if (!title) throw _err('bad_request', 'A task needs a title.');
  const goalId = a.goalId === '' || a.goalId == null ? '' : String(a.goalId);
  if (goalId && !_goalExists(goalId)) throw _err('not_found', 'That goal does not exist.');
  return withLock(() => {
    const id = String(_nextId('Today'));
    const row = [id, _today(), title, 'me', '', '', '', goalId, '', 'open', '', '', '', rf, ''];
    _appendRows('Today', [row]);
    return { task: _todayItem(row) };
  });
}

/** Linking a task to a goal is optional: an empty goalId takes the link away. */
function setTodayGoal(a) {
  a = a || {};
  const i = _todayIndex(a.id);
  const goalId = a.goalId === '' || a.goalId == null ? '' : String(a.goalId);
  if (goalId && !_goalExists(goalId)) throw _err('not_found', 'That goal does not exist.');
  _writeSpan('Today', i, 8, [goalId]);
  return { task: _todayItem(rows('Today')[i]) };
}

/** Skip a task for today, or put it back. Reopening a finished task also takes its log entry away (the log keeps it hidden, like any removed entry). */
function setTodayStatus(a) {
  a = a || {};
  if (a.status !== 'open' && a.status !== 'skipped') throw _err('bad_request', 'Use completeTodayTask to finish a task.');
  const i = _todayIndex(a.id);
  const r = rows('Today')[i];
  let removed = null;
  if (String(r[9]) === 'done' && r[12]) {
    try { removed = removeLog(String(r[12])); } catch (e) { if (!e || e.code !== 'not_found') throw e; }
  }
  _writeSpan('Today', i, 10, [a.status, a.status === 'open' ? '' : _today(), '', '']);   // Status, StatusDate, Minutes, LogID
  const out = { task: _todayItem(rows('Today')[i]) };
  if (removed) { out.streak = removed.streak; out.weekMinutes = removed.weekMinutes; }
  return out;
}

/**
 * Finishing a task saves a log entry (what was done, and the time it took if given) and marks the row done.
 * The log entry is written first and recognised by `ref`, so a retry after a lost answer never logs it twice.
 */
function completeTodayTask(a) {
  a = a || {};
  const i = _todayIndex(a.id);
  const r = rows('Today')[i];
  if (String(r[9]) === 'done') {
    return { task: _todayItem(r), entry: null, streak: getStreak(), weekMinutes: weekMinutes() };
  }
  const item = _todayItem(r);
  const mins = _cleanMinutes(a.minutes);
  let tags = item.source === 'focus' ? (item.tags.length ? item.tags.slice() : ['FOCUS']) : ['TASK'];
  if (item.goalId) {
    const g = rows('Goals').find(x => String(x[0]) === item.goalId);
    if (g) { const gt = _parseTags(g[5]); if (gt.length) tags = gt.slice(0, 4); }
  }
  const text = item.source === 'focus' ? 'Focus time' + (item.tags.length ? ' (' + item.tags.join(', ') + ')' : '')
    : 'Completed: ' + item.title + (item.source === 'planner' && item.sourceId ? ' [#' + item.sourceId + ']' : '');   // only work items have a number worth keeping
  const entry = addJournalEntry(text, tags, mins, a.ref, a.replay === true);
  _writeSpan('Today', i, 10, ['done', _today(), mins, entry.id]);   // Status, StatusDate, Minutes, LogID
  maybePurge();
  return { task: _todayItem(rows('Today')[i]), entry: entry, streak: getStreak(), weekMinutes: weekMinutes() };
}

// ---- Today's Look: placing things on the day -------------------

/** Where the day is already taken: booked windows from both calendars, and everything the person has placed. */
function _takenToday(exceptId) {
  const v = getTodayView();
  const taken = [];
  (v.busy || []).forEach(w => { const s = _toMin(w.start), e = _toMin(w.end); if (s != null && e != null && e > s) taken.push({ s: s, e: e, what: 'something already booked (' + w.start + '\u2013' + w.end + ')' }); });
  v.items.forEach(t => {
    if (String(t.id) === String(exceptId) || !t.start || !t.dur || t.status === 'skipped' || t.status === 'closed') return;
    const s = _toMin(t.start);
    taken.push({ s: s, e: s + t.dur, what: t.source === 'focus' ? 'a focus block' : '\u201c' + t.title + '\u201d', block: t });
  });
  return taken;
}

function _cleanTagList(v) {
  const raw = Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
  return _parseTags(raw).map(t => t.replace(/[^A-Z0-9 _&\/-]/g, '').trim().slice(0, 20)).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 4);
}

/** A start time and length that fit the day (8am to 8pm). Returns minutes since midnight for both ends. */
function _cleanSlot(start, minutes) {
  const s = _toMin(_cleanHm(start));
  const d = Math.round(Number(minutes));
  if (s == null) throw _err('bad_request', 'Choose a start time.');
  if (!Number.isFinite(d) || d < LOOK_MIN || d > LOOK_MAX) throw _err('bad_request', 'A block is between ' + LOOK_MIN + ' minutes and ' + _fmtMinutes(LOOK_MAX) + ' long.');
  if (s < LOOK_START || s + d > LOOK_END) throw _err('bad_request', 'Today\'s Look runs from 8:00 AM to 8:00 PM, so that does not fit.');
  return { s: s, e: s + d, start: _hm(s), dur: d };
}

/** A clash is an error, except two focus blocks with exactly the same start and end, which become one. */
function _clash(slot, taken, mergeable) {
  let merge = null;
  for (let k = 0; k < taken.length; k++) {
    const x = taken[k];
    if (slot.s < x.e && x.s < slot.e) {
      if (mergeable && x.block && x.block.source === 'focus' && x.s === slot.s && x.e === slot.e) { merge = x.block; continue; }
      throw _err('conflict', 'That overlaps ' + x.what + '.');
    }
  }
  return merge;
}

function _blockOut(id) {
  const i = rows('Today').findIndex(r => String(r[0]) === String(id));
  return i < 0 ? null : _todayItem(rows('Today')[i]);
}

function _lookResult(id) { return { task: id == null ? null : _blockOut(id), view: getTodayView() }; }

/** Adds tags onto an existing focus block (merging two blocks that cover the same time). */
function _mergeTags(i, tags) {
  const r = rows('Today')[i];
  const all = _cleanTagList(_parseTags(r[18]).concat(tags));
  _writeSpan('Today', i, 19, [all.join(',')]);
  return String(r[0]);
}

/** A loose 'focus' block: work or learning that is not a listed item. Same start and end as another focus block merges into it. */
function addFocusBlock(a) {
  a = a || {};
  const rf = _ref(a.ref);
  if (rf && a.replay === true) { const hit = _todayRows().find(r => String(r[13]) === rf); if (hit) return _lookResult(hit[0]); }
  const slot = _cleanSlot(a.start, a.minutes == null ? 30 : a.minutes);
  const tags = _cleanTagList(a.tags);
  return withLock(() => {
    const merge = _clash(slot, _takenToday(), true);
    if (merge) { const i = _todayIndex(merge.id); return _lookResult(_mergeTags(i, tags)); }
    const id = String(_nextId('Today'));
    _appendRows('Today', [[id, _today(), 'Focus', 'focus', '', '', '', '', '', 'open', '', '', '', rf, '', '', slot.start, slot.dur, tags.join(',')]]);
    return _lookResult(id);
  });
}

/** A bullet from the daily focus, placed on the day. It becomes its own row so it can be moved, finished and logged. */
function addScheduledAction(a) {
  a = a || {};
  const rf = _ref(a.ref);
  if (rf && a.replay === true) { const hit = _todayRows().find(r => String(r[13]) === rf); if (hit) return _lookResult(hit[0]); }
  const title = _clip(a.title, TODAY_TITLE_MAX);
  if (!title) throw _err('bad_request', 'That needs a title.');
  const slot = _cleanSlot(a.start, a.minutes == null ? 30 : a.minutes);
  return withLock(() => {
    _clash(slot, _takenToday(), false);
    const id = String(_nextId('Today'));
    _appendRows('Today', [[id, _today(), title, 'focus-action', title, '', '', '', '', 'open', '', '', '', rf, '', '', slot.start, slot.dur, '']]);
    return _lookResult(id);
  });
}

/** Puts an item that is already on the to-do list onto the day, or takes it off again (empty start). */
function scheduleTodayItem(a) {
  a = a || {};
  return withLock(() => {
    const i = _todayIndex(a.id);
    const r = rows('Today')[i];
    const item = _todayItem(r);
    if (_isBlockSource(item.source)) throw _err('bad_request', 'Use updateScheduledBlock for that.');
    if (item.status === 'done' || item.status === 'closed') throw _err('bad_request', 'That one is finished, so it cannot be placed.');
    if (a.start === '' || a.start == null) {
      _writeSpan('Today', i, 17, ['', '']);
      return _lookResult(item.id);
    }
    const guess = item.dur || (item.points != null ? Math.max(LOOK_MIN, Math.min(120, Math.round(item.points * 2) * 15)) : 30);
    const slot = _cleanSlot(a.start, a.minutes == null ? guess : a.minutes);
    _clash(slot, _takenToday(item.id), false);
    if (item.date !== _today()) _writeSpan('Today', i, 2, [_today()]);   // a carried-over item moves to today when it is placed
    _writeSpan('Today', i, 17, [slot.start, slot.dur]);
    return _lookResult(item.id);
  });
}

/** Moves, resizes or retags a placed block. A focus block that now covers exactly the same time as another one merges into it. */
function updateScheduledBlock(a) {
  a = a || {};
  return withLock(() => {
    const i = _todayIndex(a.id);
    const item = _todayItem(rows('Today')[i]);
    if (!item.start) throw _err('bad_request', 'That is not placed on the day.');
    const start = a.start == null ? item.start : a.start;
    const minutes = a.minutes == null ? item.dur : a.minutes;
    const slot = _cleanSlot(start, minutes);
    const tags = item.source === 'focus' && a.tags != null ? _cleanTagList(a.tags) : item.tags;
    const merge = _clash(slot, _takenToday(item.id), item.source === 'focus');
    if (merge) {
      const j = _todayIndex(merge.id);
      const keep = _mergeTags(j, tags);
      _deleteRowNumbers('Today', [i + 2]);
      return _lookResult(keep);
    }
    _writeSpan('Today', i, 17, [slot.start, slot.dur, tags.join(',')]);
    return _lookResult(item.id);
  });
}

/** Takes a block off the day. A focus block or a placed bullet is removed; a to-do item only loses its time and stays on the list. */
function removeScheduledBlock(a) {
  a = a || {};
  return withLock(() => {
    const i = _todayIndex(a.id);
    const item = _todayItem(rows('Today')[i]);
    if (_isBlockSource(item.source)) {
      if (item.status === 'done') throw _err('bad_request', 'That one is finished and logged, so it stays.');
      _deleteRowNumbers('Today', [i + 2]);
      return { task: null, view: getTodayView() };
    }
    _writeSpan('Today', i, 17, ['', '']);
    return _lookResult(item.id);
  });
}

// ---- what the coach reads -------------------------------------

/**
 * Added to the 7am context. It says plainly when no fresh plan arrived, so the coach never plans from yesterday's work.
 * The to-do list is listed either way (the person's own items and Google Tasks do not depend on the planner), each with a key the
 * coach hands back in `covered` to say which ones its actions already take care of.
 */
function buildTodayContext() {
  const v = getTodayView();
  const lines = ['TODAY\'S WORK PLAN (sent by the user\'s planner; titles are shortened; refer to work items by their ID):'];
  const f = v.feed;
  const scheduleLines = () => {
    if (f.sources && f.sources.outlook === 'missing') lines.push('(Outlook calendar did not arrive today, so booked time may be understated)');
    if (f.focus && f.focus.length) lines.push('Open focus time: ' + f.focus.map(w => w.start + '-' + w.end + ' (' + _fmtMinutes(w.minutes) + ')').join(', '));
    if (f.busy && f.busy.length) lines.push('Booked: ' + f.busy.map(w => w.start + '-' + w.end + (w.src ? ' (' + w.src + ')' : '')).join(', '));
    if (f.budget !== '' && f.budget != null) lines.push('Realistic budget today: about ' + f.budget + ' story points of work');
  };
  const goalName = {};
  getActiveGoals().forEach(g => { goalName[g.id] = g.title; });
  const open = v.items.concat(v.carried).filter(t => t.status === 'open' && !_isBlockSource(t.source) && (v.fresh || t.source !== 'planner')).slice(0, TODAY_COACH_ITEMS);
  const todoLines = () => {
    lines.push('');
    lines.push(open.length ? 'TO-DO LIST (open items; each starts with its key, which you give back in "covered" when your actions take care of it):' : 'TO-DO LIST: (nothing open)');
    open.forEach(t => {
      const bits = [t.state, t.points != null ? t.points + ' pts' : '', t.flags.join('/'), t.note, t.date < v.date ? 'carried over from ' + t.date : '',
        t.goalId && goalName[t.goalId] ? 'linked to goal "' + goalName[t.goalId] + '"' : ''].filter(Boolean);
      lines.push('- [t' + t.id + '] ' + (t.source === 'google-task' ? 'Google Task: ' : (t.sourceId ? '#' + t.sourceId + ' ' : '')) + t.title + (bits.length ? ' (' + bits.join(', ') + ')' : ''));
    });
  };
  if (!v.fresh) {
    lines.push('(no fresh plan arrived today, so do not assume any work items)' + (f && f.date ? ' Last plan was for ' + f.date + '.' : ''));
    if (f && f.sources && f.sources.google === 'ok') scheduleLines();   // open time is still known from the Google calendar
    todoLines();
    return lines.join('\n');
  }
  scheduleLines();
  todoLines();
  const done = v.items.filter(t => t.status === 'done' && !_isBlockSource(t.source)).length;
  if (done) lines.push(done + ' item' + (done === 1 ? ' is' : 's are') + ' already done today.');
  if (f.objectives && f.objectives.length) {
    lines.push('Team objectives this quarter:');
    f.objectives.forEach(o => lines.push('- ' + o.name + ': ' + o.progress + '%' + (o.due ? ', due ' + o.due : '')));
  }
  return lines.join('\n');
}

/** Added to the weekly context: how many of the week's planned tasks got finished, and the time recorded on them. */
function buildTodayWeekContext() {
  const cutoff = _daysAgo(6);
  const week = _todayRows().map(_todayItem).filter(t => t.date >= cutoff && !_isBlockSource(t.source));
  if (!week.length) return '';
  const done = week.filter(t => t.status === 'done');
  const mins = done.reduce((s, t) => s + t.minutes, 0);
  return 'TASKS FROM THE TODAY PAGE THIS WEEK: ' + done.length + ' of ' + week.length + ' finished' +
    (mins ? ', ' + _fmtMinutes(mins) + ' recorded on them' : '') + '. Skipped: ' + week.filter(t => t.status === 'skipped').length + '.';
}
