// ============================================================
// Tidy.js \u2014 keeping the sheet light, and the weekly plan editable
//
//  * Removed things (log entries, goals, tasks) are hidden first and deleted for good after a keep-for
//    period of 14 or 30 days. The deletion runs on an ordinary request (the first log entry or removal of
//    the day), never from a timer.
//  * Completed goals get a review about every quarter: keep as a record, or remove entirely. Small, quick
//    goals are suggested for removal; big ones are suggested for keeping.
//  * The proposed plan in the latest weekly report can be edited.
// ============================================================

const PURGE_CHOICES = [14, 30];
const PURGE_DEFAULT = 30;
const REVIEW_EVERY_DAYS = 90;      // how often the review is offered
const REVIEW_MIN_AGE_DAYS = 30;    // a completed goal is ready for review once it has been done this long
const SMALL_GOAL_DAYS = 14;        // "small": finished within this many days of being added...
const SMALL_GOAL_TASKS = 2;        // ...with at most this many tasks, no sub-goals, and not high priority
const PURGE_MAX_ROWS = 300;        // most rows deleted from one tab in one run

// ---- the two settings -----------------------------------------

function getPurgeDays() {
  const n = parseInt(getSetting('purge_days'), 10);
  return PURGE_CHOICES.indexOf(n) >= 0 ? n : PURGE_DEFAULT;
}

function setPurgeDays(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  if (PURGE_CHOICES.indexOf(n) < 0) throw _err('bad_request', 'Removed items can be kept for ' + PURGE_CHOICES.join(' or ') + ' days.');
  setSetting('purge_days', String(n));
  return n;
}

/** When the last review happened. The first time it is asked, it starts from today, so nothing nags at once. */
function getLastReview() {
  let v = getSetting('last_review');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { v = _today(); setSetting('last_review', v); }
  return v;
}

function _daysBetween(a, b) {
  const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(a), y = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!x || !y) return null;
  return Math.round((Date.UTC(+y[1], +y[2] - 1, +y[3]) - Date.UTC(+x[1], +x[2] - 1, +x[3])) / 864e5);
}

/** What Settings and History need to know: the keep-for period and whether a review is due. */
function getHousekeeping() {
  const last = getLastReview();
  const count = reviewCandidates().length;
  return { purgeDays: getPurgeDays(), lastReview: last, reviewCount: count, reviewDue: count > 0 && _daysBetween(last, _today()) >= REVIEW_EVERY_DAYS };
}

function saveHousekeeping(a) {
  a = a || {};
  if (a.purgeDays != null) setPurgeDays(a.purgeDays);
  return getHousekeeping();
}

// ---- status dates: how long ago a goal or task changed status ------

/** Goals and tasks that were completed, postponed or removed before dates were kept start counting from today. */
function backfillStatusDates() {
  const today = _today();
  const fill = (name, col, isSet) => {
    const data = rows(name);
    let changed = false;
    const out = data.map(r => {
      const cur = r[col - 1];
      if (r[0] !== '' && isSet(r) && (cur === '' || cur == null)) { changed = true; return [today]; }
      return [cur === undefined || cur === null ? '' : _cell(cur)];
    });
    if (!changed) return;
    withLock(() => _timeIt('write', () => {
      const rng = getSheet(name).getRange(2, col, out.length, 1);
      rng.setNumberFormat('@');
      rng.setValues(out);
    }));
    _invalidate(name);
  };
  fill('Goals', 9, r => r[3] !== 'active');
  fill('Tasks', 6, r => r[3] === 'removed' || r[3] === 'done');
}

// ---- deleting removed things for good --------------------------

/** Deletes whole goals (and their tasks) by id; sub-goals of a deleted goal become top-level goals. */
function _deleteGoals(ids) {
  const set = new Set(ids.map(String));
  const goalRows = rows('Goals'), taskRows = rows('Tasks');
  const goalNums = [], taskNums = [], orphans = [];
  goalRows.forEach((r, i) => {
    if (set.has(String(r[0]))) goalNums.push(i + 2);
    else if (r[6] !== '' && r[6] != null && set.has(String(r[6]))) orphans.push(i);
  });
  taskRows.forEach((r, i) => { if (set.has(String(r[1]))) taskNums.push(i + 2); });
  orphans.forEach(i => {
    _timeIt('write', () => { const c = getSheet('Goals').getRange(i + 2, 7); c.setNumberFormat('@'); c.setValue(''); });
  });
  if (orphans.length) _invalidate('Goals');
  if (taskNums.length) _deleteRowNumbers('Tasks', taskNums);
  if (goalNums.length) _deleteRowNumbers('Goals', goalNums);
  return { goals: goalNums.length, tasks: taskNums.length };
}

/** Deletes hidden items older than the keep-for period. */
function purgeRemoved() {
  const cutoff = _daysAgo(getPurgeDays());
  const old = d => { const s = _day(d).slice(0, 10); return /^\d{4}-/.test(s) && s <= cutoff; };
  return withLock(() => {
    const out = { journal: 0, goals: 0, tasks: 0 };

    // log entries
    const sh = getSheet('Journal'), last = sh.getLastRow();
    if (last >= 2 && sh.getLastColumn() >= 7) {
      const flags = _timeIt('read', () => sh.getRange(2, 6, last - 1, 2).getValues());
      const nums = [];
      flags.forEach((r, i) => { if (r[0] === 'removed' && r[1] !== '' && old(r[1]) && nums.length < PURGE_MAX_ROWS) nums.push(i + 2); });
      if (nums.length) { _deleteRowNumbers('Journal', nums); out.journal = nums.length; }
    }

    // removed goals (with their tasks), then removed tasks
    const goalIds = rows('Goals').filter(r => r[0] !== '' && r[3] === 'archived' && r[8] !== '' && r[8] != null && old(r[8])).map(r => r[0]).slice(0, PURGE_MAX_ROWS);
    if (goalIds.length) { const d = _deleteGoals(goalIds); out.goals = d.goals; out.tasks += d.tasks; }
    const taskNums = [];
    rows('Tasks').forEach((r, i) => { if (r[0] !== '' && r[3] === 'removed' && r[5] !== '' && r[5] != null && old(r[5]) && taskNums.length < PURGE_MAX_ROWS) taskNums.push(i + 2); });
    if (taskNums.length) { _deleteRowNumbers('Tasks', taskNums); out.tasks += taskNums.length; }
    return out;
  });
}

/** Runs the deletion at most once a day, and never lets a problem there get in the way of what was asked. */
function maybePurge() {
  try {
    const cache = CacheService.getScriptCache(), key = 'purge_' + _today();
    if (cache.get(key)) return null;
    const out = purgeRemoved();
    cache.put(key, '1', 21600);
    return out;
  } catch (e) {
    Logger.log('Purge skipped: ' + (e && e.message ? e.message : e));
    return null;
  }
}

// ---- the quarterly review of completed goals -------------------

/** Completed goals that have been done long enough and have not been kept in an earlier review. */
function reviewCandidates() {
  const cutoff = _daysAgo(REVIEW_MIN_AGE_DAYS);
  return rows('Goals').filter(r => r[0] !== '' && r[3] === 'completed').map(_goal)
    .filter(g => !g.kept && g.since && g.since <= cutoff);
}

function getReview() {
  const kids = {}, taskCount = {};
  rows('Goals').forEach(r => { if (r[6] !== '' && r[6] != null) kids[String(r[6])] = (kids[String(r[6])] || 0) + 1; });
  rows('Tasks').forEach(r => { if (r[0] !== '' && r[3] !== 'removed') taskCount[String(r[1])] = (taskCount[String(r[1])] || 0) + 1; });
  const goals = reviewCandidates().map(g => {
    const days = _daysBetween(g.created, g.since);
    const tasks = taskCount[g.id] || 0, children = kids[g.id] || 0;
    const small = g.priority !== 'high' && days != null && days <= SMALL_GOAL_DAYS && children === 0 && tasks <= SMALL_GOAL_TASKS;
    return { id: g.id, title: g.title, priority: g.priority, tags: g.tags, created: g.created, completed: g.since, days: days, tasks: tasks, children: children, suggest: small ? 'remove' : 'keep' };
  });
  const last = getLastReview();
  return { goals: goals, lastReview: last, due: goals.length > 0 && _daysBetween(last, _today()) >= REVIEW_EVERY_DAYS };
}

/**
 * Applies the person's choices: `keep` goals stay as a record and are not asked about again; `remove` goals
 * are deleted for good with their tasks. Every id must be a completed goal. The review date is reset.
 */
function applyReview(a) {
  a = a || {};
  const ids = v => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 500) throw _err('bad_request', 'The review choices were not understood.');
    return v.map(x => { if (typeof x !== 'string' && typeof x !== 'number') throw _err('bad_request', 'The review choices were not understood.'); return String(x); });
  };
  const keep = ids(a.keep), remove = ids(a.remove);
  if (keep.some(k => remove.indexOf(k) >= 0)) throw _err('bad_request', 'A goal cannot be both kept and removed.');
  const completed = new Set(rows('Goals').filter(r => r[0] !== '' && r[3] === 'completed').map(r => String(r[0])));
  const stray = keep.concat(remove).find(x => !completed.has(x));
  if (stray !== undefined) throw _err('not_found', 'One of those goals is no longer in the completed list. Reload and try again.');
  return withLock(() => {
    const today = _today();
    const keepSet = new Set(keep);
    rows('Goals').forEach((r, i) => {
      if (keepSet.has(String(r[0]))) _timeIt('write', () => { const c = getSheet('Goals').getRange(i + 2, 10); c.setNumberFormat('@'); c.setValue(today); });
    });
    _invalidate('Goals');
    const removed = remove.length ? _deleteGoals(remove) : { goals: 0, tasks: 0 };
    setSetting('last_review', today);
    return { kept: keep.length, removed: removed.goals, tasksDeleted: removed.tasks, lastReview: today };
  });
}

// ---- editing the proposed plan ---------------------------------

function _cleanPlan(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw _err('bad_request', 'That plan is not valid.');
  const list = (v, max, what) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > max) throw _err('bad_request', 'A plan can have up to ' + max + ' ' + what + '.');
    return v;
  };
  const goals = list(p.goals, 10, 'suggested goals').map(g => {
    if (!g || typeof g !== 'object') throw _err('bad_request', 'A suggested goal was not understood.');
    const title = _clip(g.title, LIMITS.title);
    if (!title) throw _err('bad_request', 'A suggested goal needs a title.');
    return { title: title, priority: _priority(g.priority), rationale: _clip(g.rationale, 300) };
  });
  const text = (max) => x => { if (typeof x !== 'string') throw _err('bad_request', 'A plan line was not understood.'); return _clip(x, max); };
  const priorities = list(p.priorities, 10, 'priorities').map(text(LIMITS.title)).filter(Boolean);
  const focus = list(p.focus_areas, 10, 'focus areas').map(text(100)).filter(Boolean);
  return { goals: goals, priorities: priorities, focus_areas: focus };
}

/** Replaces the plan in the latest weekly review. The review's own text and score are untouched. */
function updatePlan(a) {
  const plan = _cleanPlan(a && a.plan);
  return withLock(() => {
    const sh = getSheet('Reports'), last = sh.getLastRow();
    if (last >= 2) {
      const types = _timeIt('read', () => sh.getRange(2, 2, last - 1, 1).getValues());
      for (let i = types.length - 1; i >= 0; i--) {
        if (types[i][0] !== 'weekly') continue;
        const row = _timeIt('read', () => sh.getRange(i + 2, 1, 1, 4).getValues()[0]);
        let data;
        try { data = JSON.parse(row[2]); } catch (_) { continue; }
        if (!data || typeof data !== 'object') continue;
        plan.edited = _today();
        data.plan = plan;
        _timeIt('write', () => { const c = sh.getRange(i + 2, 3); c.setNumberFormat('@'); c.setValue(JSON.stringify(data)); });
        _invalidate('Reports');
        return { report: { date: _ts(row[0]), type: 'weekly', data: data, score: row[3] } };
      }
    }
    throw _err('not_found', 'There is no weekly review to edit yet. Run a weekly review first.');
  });
}

