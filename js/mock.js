'use strict';
// mock.js — an in-browser stand-in for the Apps Script backend ("demo data").
// Same actions and response shapes as backend/Api.js, stored in localStorage.
// The AI replies are canned: it exists to try the interface, not to coach you.

const Mock = (() => {
  const KEY = 'learnerbot.demo.v1';
  const VERSION = '2026.11.30';
  const RELEASE = '1.16';   // the backend version this demo mirrors (a test keeps it equal to backend/Code.js)
  const DAY = 864e5;
  // Local calendar day, n days ago (negative = in the future), formatted yyyy-mm-dd.
  const iso = n => { const d = new Date(Date.now() - n * DAY), p = x => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const tags = t => (Array.isArray(t) ? t.join(',') : String(t || '')).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const PRI = { high: 0, medium: 1, low: 2 };

  let db = load();

  function seed() {
    return {
      goals: [
        { id: '1', title: 'Learn Python fundamentals', priority: 'high', status: 'active', created: iso(20), tags: ['PYTHON', 'LEARNING'], parentId: '', due: iso(-9), since: '', kept: false },
        { id: '2', title: 'Finish the data structures course', priority: 'medium', status: 'active', created: iso(18), tags: ['LEARNING'], parentId: '1', due: iso(-2), since: '', kept: false },
        { id: '3', title: 'Read one technical book a month', priority: 'low', status: 'active', created: iso(30), tags: ['READING'], parentId: '', due: iso(1), since: '', kept: false },
        { id: '4', title: 'Set up a home lab', priority: 'medium', status: 'postponed', created: iso(40), tags: ['HOMELAB'], parentId: '', due: '', since: iso(30), kept: false },
        { id: '5', title: 'Ship a first small project', priority: 'high', status: 'completed', created: iso(50), tags: ['PYTHON'], parentId: '', due: '', since: iso(40), kept: false },
        { id: '6', title: 'Tidy the desk', priority: 'low', status: 'completed', created: iso(70), tags: ['HOME'], parentId: '', due: '', since: iso(66), kept: false },
        { id: '7', title: 'Plan the summer trip', priority: 'low', status: 'completed', created: iso(95), tags: ['HOME'], parentId: '', due: '', since: iso(92), kept: false }
      ],
      tasks: [
        { id: '1', goalId: '1', title: 'Work through chapters 1–3', status: 'done', created: iso(15) },
        { id: '2', goalId: '1', title: 'Write a CLI that renames files', status: 'active', created: iso(10) },
        { id: '3', goalId: '2', title: 'Implement a linked list', status: 'active', created: iso(7) }
      ],
      journal: [
        { id: '1', date: iso(0), text: 'Read two chapters on dictionaries and sets.', tags: ['PYTHON'], minutes: 45, removed: '' },
        { id: '2', date: iso(1), text: 'Solved three practice problems.', tags: ['LEARNING'], minutes: 30, removed: '' },
        { id: '3', date: iso(2), text: 'Started the linked list exercise.', tags: ['LEARNING'], minutes: 0, removed: '' },
        { id: '4', date: iso(9), text: 'Watched a talk about testing.', tags: ['LEARNING'], minutes: 60, removed: '' },
        { id: '5', date: iso(20), text: 'Tried a first script with files.', tags: ['PYTHON'], minutes: 90, removed: '' },
        { id: '6', date: iso(45), text: 'Set up a learning plan and picked a first course.', tags: ['PLANNING'], minutes: 30, removed: '' }
      ],
      housekeeping: { purgeDays: 30, lastReview: iso(95) },
      coachVoice: '',
      myVoices: [],
      feedback: [{ date: iso(3), text: 'Be more concrete about next steps.' }],
      history: [
        { week: iso(21), score: 4, summary: 'Slow start, mostly planning.' },
        { week: iso(14), score: 6, summary: 'Found a routine.' },
        { week: iso(7), score: 7, summary: 'Steady progress on Python.' }
      ],
      chat: [],
      notify: { daily: { enabled: false, hour: 7 }, weekly: { enabled: false, day: 0, hour: 18 }, nudge: { enabled: false, hour: 20 } },
      today: [],
      todayMeta: null,
      reports: {
        daily: { date: new Date().toISOString(), type: 'daily', score: '', data: {
          focus: 'Build the file-renaming CLI',
          actions: ['Write the argument parsing', 'Handle name collisions', 'Run it on a scratch folder'],
          reason: 'It turns last week\'s chapters into something that works, which is the fastest way to make them stick.' } },
        weekly: null
      }
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.goals) {   // older saved demos predate the email settings, deadlines, time and the coach voice
        s.notify = s.notify || seed().notify;
        s.coachVoice = s.coachVoice || '';
        s.myVoices = Array.isArray(s.myVoices) ? s.myVoices : [];
        s.goals.forEach(g => { if (g.due == null) g.due = ''; if (g.since == null) g.since = g.status === 'active' ? '' : iso(0); if (g.kept == null) g.kept = false; });
        s.journal.forEach((j, i) => { if (!j.id) j.id = String(i + 1); if (j.removed == null) j.removed = ''; });
        s.housekeeping = s.housekeeping || { purgeDays: 30, lastReview: iso(0) };
        s.today = Array.isArray(s.today) ? s.today : [];
        s.todayMeta = s.todayMeta || null;
        return s;
      }
    } catch (_) { /* fall through */ }
    return seed();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) { /* memory only */ } }
  function nextId(list) { return String(list.reduce((m, x) => Math.max(m, parseInt(x.id, 10) || 0), 0) + 1); }

  const visible = () => db.journal.filter(j => !j.removed);

  function streak() {
    const days = new Set(visible().map(j => j.date));
    let n = 0, off = days.has(iso(0)) ? 0 : 1;
    while (n < 365 && days.has(iso(off + n))) n++;
    return n;
  }

  // ---- Today tab (mirrors backend/Today.js; the demo makes up a plan for today so the page has something to show) ----
  const T_STATUS = ['open', 'done', 'skipped'];
  function demoFeed() {
    const d = iso(0);
    db.today = db.today.filter(t => t.date !== d || t.source === 'me');
    let n = parseInt(nextId(db.today), 10);
    const mk = (sourceId, title, points, state, flags, note) => ({ id: String(n++), date: d, title, source: 'planner', sourceId, points, state, goalId: '', flags, status: 'open', doneOn: '', minutes: 0, logId: '', note, links: [] });
    const gt = (sourceId, title, flags, links) => ({ id: String(n++), date: d, title, source: 'google-task', sourceId, points: null, state: 'To do', goalId: '', flags, status: 'open', doneOn: '', minutes: 0, logId: '', note: 'My Tasks', links });
    db.today = db.today.concat([
      mk('2041', 'Review the sorting exercise PR', 1, 'PR Ready', [], ''),
      mk('2057', 'Write the data structures summary', 5, 'Active', ['DUE-IN-2d'], 'Finish the data structures course'),
      mk('2063', 'Set up the practice repo', 3, 'New', ['CARRIED-OVER'], ''),
      gt('gt-lib', 'Renew the library card', ['DUE-TODAY'], [{ u: 'https://tasks.google.com/task/gt-lib', d: 'Open in Google Tasks' }, { u: 'https://mail.google.com/mail/u/0/#inbox/demo', d: 'Library reminder email' }]),
      gt('gt-book', 'Return the borrowed book', ['OVERDUE'], [{ u: 'https://tasks.google.com/task/gt-book', d: 'Open in Google Tasks' }])
    ]);
    const rep = db.reports.daily;
    if (rep && rep.data && rep.data.covered === undefined) {   // the first demo focus gets an assessment and says which to-do items it covers
      const sum = db.today.find(t => t.date === d && t.sourceId === '2057');
      rep.data.assessment = 'Nothing is overdue except one small Google Task, so the CLI project can lead. The data structures summary is due in two days and needs a block today.';
      rep.data.covered = sum ? ['t' + sum.id] : [];
    }
    db.todayMeta = { date: d, at: new Date().toISOString(), budget: 1.8,
      focus: [{ start: '09:30', end: '12:00', minutes: 150 }, { start: '13:00', end: '15:00', minutes: 120 }, { start: '15:30', end: '17:00', minutes: 90 }], busy: [{ start: '09:00', end: '09:30', src: 'Outlook' }, { start: '12:00', end: '13:00', src: 'Google' }, { start: '15:00', end: '15:30', src: 'Outlook' }], allDay: 1,
      sources: { outlook: 'ok', google: 'ok' },
      objectives: [{ key: '1', name: 'Learn Python fundamentals', progress: 40, due: '12/31' }, { key: '2', name: 'Finish the data structures course', progress: 15, due: '1/31' }] };
    save();
  }
  const tasksStatus = () => ({ enabled: true, at: new Date().toISOString(), count: db.today.filter(t => t.source === 'google-task' && t.date === iso(0) && t.status === 'open').length, error: '' });
  // The assistant's display starts after the last "new conversation" divider; earlier messages stay stored.
  function chatNow() {
    let from = 0;
    db.chat.forEach((m, i) => { if (m.role === 'divider') from = i + 1; });
    return db.chat.slice(from).slice(-30);
  }
  function todayView() {
    if (!db.todayMeta || db.todayMeta.date !== iso(0)) demoFeed();
    const d = iso(0);
    const hints = {};
    db.today.filter(t => t.source === 'focus').forEach(t => (t.tags || []).forEach(g => { hints[g] = (hints[g] || 0) + 1; }));
    return { date: d, fresh: true, feed: db.todayMeta, items: db.today.filter(t => t.date === d).map(t => ({ start: '', dur: 0, tags: [], ...t })), carried: [], busy: db.todayMeta.busy.slice(), tagHints: Object.keys(hints).sort((a, b) => hints[b] - hints[a]).slice(0, 8), tasks: tasksStatus(), calendar: { enabled: true, at: new Date().toISOString(), error: '', busy: [], allDay: 1, calendars: 2 }, schedule: { enabled: !!(db.workday && db.workday.enabled), hours: (db.workday && db.workday.hours) || [6, 15], loader: 2, canSchedule: true, tz: 'your time zone' } };
  }
  // ---- placing things on Today's Look (mirrors the Today.js functions of the same names) ----
  const LOOK_S = 480, LOOK_E = 1200;
  const hmToMin = hm => { const m = /^(\d{2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const minToHm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const cleanTagList = v => Array.from(new Set((Array.isArray(v) ? v.join(',') : String(v || '')).split(',').map(s => s.trim().toUpperCase().replace(/[^A-Z0-9 _&\/-]/g, '').slice(0, 20)).filter(Boolean))).slice(0, 4);
  function lookSlot(start, minutes) {
    const s = hmToMin(start), d = Math.round(Number(minutes));
    need(s != null, 'Choose a start time.');
    need(Number.isFinite(d) && d >= 15 && d <= 240, 'A block is between 15 minutes and 4h long.');
    need(s >= LOOK_S && s + d <= LOOK_E, 'Today\'s Look runs from 8:00 AM to 8:00 PM, so that does not fit.');
    return { s, e: s + d, start: minToHm(s), dur: d };
  }
  function lookTaken(exceptId) {
    const out = db.todayMeta.busy.map(w => ({ s: hmToMin(w.start), e: hmToMin(w.end), what: 'something already booked (' + w.start + '\u2013' + w.end + ')' }));
    db.today.forEach(t => { if (t.date === iso(0) && t.start && t.dur && t.id !== String(exceptId) && t.status !== 'skipped') out.push({ s: hmToMin(t.start), e: hmToMin(t.start) + t.dur, what: t.source === 'focus' ? 'a focus block' : '\u201c' + t.title + '\u201d', block: t }); });
    return out;
  }
  function lookClash(slot, taken, mergeable) {
    let merge = null;
    taken.forEach(x => {
      if (slot.s < x.e && x.s < slot.e) {
        if (mergeable && x.block && x.block.source === 'focus' && x.s === slot.s && x.e === slot.e) { merge = x.block; return; }
        const e = new Error('That overlaps ' + x.what + '.'); e.code = 'conflict'; throw e;
      }
    });
    return merge;
  }
  function lookAction(action, a) {
    todayView();
    const out = t => { save(); return { task: t ? { start: '', dur: 0, tags: [], ...t } : null, view: todayView() }; };
    if (action === 'addFocusBlock') {
      const slot = lookSlot(a.start, a.minutes == null ? 30 : a.minutes), tags = cleanTagList(a.tags);
      const merge = lookClash(slot, lookTaken(), true);
      if (merge) { merge.tags = cleanTagList((merge.tags || []).concat(tags)); return out(merge); }
      const t = { id: nextId(db.today), date: iso(0), title: 'Focus', source: 'focus', sourceId: '', points: null, state: '', goalId: '', flags: [], status: 'open', doneOn: '', minutes: 0, logId: '', note: '', links: [], start: slot.start, dur: slot.dur, tags };
      db.today.push(t); return out(t);
    }
    if (action === 'addScheduledAction') {
      const title = clip(a.title, 80);
      need(title, 'That needs a title.');
      const slot = lookSlot(a.start, a.minutes == null ? 30 : a.minutes);
      lookClash(slot, lookTaken(), false);
      const t = { id: nextId(db.today), date: iso(0), title, source: 'focus-action', sourceId: title, points: null, state: '', goalId: '', flags: [], status: 'open', doneOn: '', minutes: 0, logId: '', note: '', links: [], start: slot.start, dur: slot.dur, tags: [] };
      db.today.push(t); return out(t);
    }
    const t = todayItem(a.id);
    const block = t.source === 'focus' || t.source === 'focus-action';
    if (action === 'scheduleTodayItem') {
      need(!block, 'Use updateScheduledBlock for that.');
      if (a.start === '' || a.start == null) { t.start = ''; t.dur = 0; return out(t); }
      const slot = lookSlot(a.start, a.minutes == null ? (t.points != null ? Math.max(15, Math.min(120, Math.round(t.points * 2) * 15)) : 30) : a.minutes);
      lookClash(slot, lookTaken(t.id), false);
      t.start = slot.start; t.dur = slot.dur; return out(t);
    }
    if (action === 'updateScheduledBlock') {
      need(t.start, 'That is not placed on the day.');
      const slot = lookSlot(a.start == null ? t.start : a.start, a.minutes == null ? t.dur : a.minutes);
      const tags = t.source === 'focus' && a.tags != null ? cleanTagList(a.tags) : (t.tags || []);
      const merge = lookClash(slot, lookTaken(t.id), t.source === 'focus');
      if (merge) { merge.tags = cleanTagList((merge.tags || []).concat(tags)); db.today = db.today.filter(x => x !== t); return out(merge); }
      t.start = slot.start; t.dur = slot.dur; t.tags = tags; return out(t);
    }
    if (block) { need(t.status !== 'done', 'That one is finished and logged, so it stays.'); db.today = db.today.filter(x => x !== t); return out(null); }
    t.start = ''; t.dur = 0; return out(t);
  }

  function todayItem(id) {
    const t = db.today.find(x => x.id === String(id));
    if (!t) throw notFound('That task was not found.');
    return t;
  }
  function tGoal(goalId) {
    const g = goalId === '' || goalId == null ? '' : String(goalId);
    need(!g || db.goals.some(x => x.id === g), 'That goal does not exist.');
    return g;
  }


  function state() {
    return {
      goals: db.goals.filter(g => g.status !== 'archived'),
      tasks: db.tasks.filter(t => t.status !== 'removed'),
      historyGoals: db.goals.filter(g => g.status !== 'active'),
      dailyReport: db.reports.daily,
      weeklyReport: db.reports.weekly,
      recentFeedback: db.feedback.slice(-3),
      history: db.history.slice(-5),
      chatHistory: chatNow(),
      streak: streak(),
      weekMinutes: weekMinutes(),
      coachVoice: db.coachVoice || '',
      myVoices: db.myVoices || [],
      appearance: db.appearance || null,
      housekeeping: housekeeping(),
      today: todayView(),
      notify: notifyView(),
      role: 'master',
      hasKey: true,
      release: RELEASE,
      version: VERSION,
      _errors: []
    };
  }

  // Last seven days including today, like the backend.
  function weekMinutes() {
    return visible().filter(j => j.date >= iso(6)).reduce((s, j) => s + (Number(j.minutes) || 0), 0);
  }

  // Same checks as backend/Sheets.js, so the demo refuses what the real thing refuses.
  function cleanDue(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    need(d && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100, 'The due date must be a real date, year-month-day.');
    return s;
  }
  function cleanMinutes(v) {
    if (v === '' || v == null) return 0;
    const n = (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v))) ? Number(v) : NaN;
    need(Number.isInteger(n) && n >= 0 && n <= 1440, 'Time must be a whole number of minutes, up to 1440.');
    return n;
  }

  function notifyView() {
    return { ...db.notify, siteUrl: '', email: 'you@example.com (demo: nothing is sent)', tz: 'local' };
  }

  // Same checks as backend/Notify.js, so the demo refuses what the real thing refuses.
  function cleanNotify(a) {
    const int = (v, min, max, label) => {
      const n = Number(v);
      if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) need(false, label + ' must be a whole number from ' + min + ' to ' + max + '.');
      return n;
    };
    const d = a.daily || {}, w = a.weekly || {}, n = a.nudge || {};
    return {
      daily: { enabled: d.enabled === true, hour: int(d.hour, 0, 23, 'The daily hour') },
      weekly: { enabled: w.enabled === true, day: int(w.day, 0, 6, 'The weekly day'), hour: int(w.hour, 0, 23, 'The weekly hour') },
      nudge: { enabled: n.enabled === true, hour: int(n.hour, 0, 23, 'The nudge hour') }
    };
  }

  const need = (cond, msg) => { if (!cond) { const e = new Error(msg); e.code = 'bad_request'; throw e; } };

  function addGoal(a) {
    const title = clip(a.title, 200);
    need(title, 'A goal needs a title.');
    const parent = a.parentId ? String(a.parentId) : '';
    if (parent && !db.goals.some(g => g.id === parent)) { const e = new Error('The parent goal does not exist.'); e.code = 'not_found'; throw e; }
    const goal = { id: nextId(db.goals), title, priority: PRI[a.priority] != null ? a.priority : 'medium', status: 'active',
      created: iso(0), tags: tags(a.tags), parentId: parent, due: cleanDue(a.due), since: '', kept: false };
    db.goals.push(goal);
    return { ...goal };
  }
  function updateGoal(a) {
    const g = db.goals.find(x => x.id === String(a.id));
    if (!g) { const e = new Error('Goal not found.'); e.code = 'not_found'; throw e; }
    const f = a.fields || {}, has = k => Object.prototype.hasOwnProperty.call(f, k);
    const next = {};
    if (has('title')) { next.title = clip(f.title, 200); need(next.title, 'A goal needs a title.'); }
    if (has('priority')) next.priority = PRI[f.priority] != null ? f.priority : 'medium';
    if (has('tags')) next.tags = tags(f.tags);
    if (has('due')) next.due = cleanDue(f.due);
    Object.assign(g, next);
    return { ...g };
  }
  function setStatus(list, a, allowed) {
    need(allowed.includes(a.status), 'Unknown status.');
    const item = list.find(x => x.id === String(a.id));
    if (!item) { const e = new Error('Not found.'); e.code = 'not_found'; throw e; }
    item.status = a.status;
    if ('since' in item || list === db.goals) { item.since = a.status === 'active' ? '' : iso(0); item.kept = false; }
  }
  function logActivity(a) {
    const text = clip(a.text, 2000);
    need(text, 'Nothing to log.');
    const entry = { id: nextId(db.journal), date: iso(0), text, tags: tags(a.tags), minutes: cleanMinutes(a.minutes), removed: '' };
    db.journal.push(entry);
    return { id: entry.id, date: entry.date, text: entry.text, tags: entry.tags, minutes: entry.minutes };
  }

  // ---- the log, hiding, the tidy-up and the plan: same checks as backend/Log.js and backend/Tidy.js ----
  const notFound = msg => { const e = new Error(msg); e.code = 'not_found'; return e; };
  const entryView = j => ({ id: j.id, date: j.date, text: j.text, tags: j.tags, minutes: Number(j.minutes) || 0 });
  const cleanSteps = { 14: 1, 30: 1 };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

  function getLog(a) {
    const days = Math.max(1, Math.min(Number(a && a.days) || 30, 3650));
    const cutoff = iso(days);
    const vis = visible();
    const inWin = vis.filter(j => j.date >= cutoff).map(entryView).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : Number(y.id) - Number(x.id)));
    return { entries: inWin.slice(0, 500), days, more: vis.length > inWin.length || inWin.length > 500 };
  }
  function updateLog(a) {
    const j = db.journal.find(x => x.id === String(a.id));
    if (!j || j.removed) throw notFound(j ? 'That entry was removed.' : 'That entry was not found.');
    const f = a.fields || {}, has = k => Object.prototype.hasOwnProperty.call(f, k);
    const next = {};
    if (has('text')) { next.text = clip(f.text, 2000); need(next.text, 'An entry needs some text.'); }
    if (has('tags')) next.tags = tags(f.tags);
    if (has('minutes')) next.minutes = cleanMinutes(f.minutes);
    Object.assign(j, next);
    return { entry: entryView(j), streak: streak(), weekMinutes: weekMinutes() };
  }
  function removeLog(a) {
    const j = db.journal.find(x => x.id === String(a.id));
    if (!j) throw notFound('That entry was not found.');
    j.removed = iso(0);
    return { id: j.id, streak: streak(), weekMinutes: weekMinutes() };
  }
  function restoreLog(a) {
    const j = db.journal.find(x => x.id === String(a.id));
    if (!j) throw notFound('That entry is gone for good, so it cannot be brought back.');
    j.removed = '';
    return { entry: entryView(j), streak: streak(), weekMinutes: weekMinutes() };
  }

  function candidates() {
    const cutoff = iso(30);
    return db.goals.filter(g => g.status === 'completed' && !g.kept && g.since && g.since <= cutoff);
  }
  function housekeeping() {
    const hk = db.housekeeping, n = candidates().length;
    return { purgeDays: hk.purgeDays, lastReview: hk.lastReview, reviewCount: n, reviewDue: n > 0 && daysBetween(hk.lastReview, iso(0)) >= 90 };
  }
  function getReview() {
    const goals = candidates().map(g => {
      const days = daysBetween(g.created, g.since);
      const tasks = db.tasks.filter(t => t.goalId === g.id && t.status !== 'removed').length, children = db.goals.filter(x => x.parentId === g.id).length;
      const small = g.priority !== 'high' && days <= 14 && children === 0 && tasks <= 2;
      return { id: g.id, title: g.title, priority: g.priority, tags: g.tags, created: g.created, completed: g.since, days, tasks, children, suggest: small ? 'remove' : 'keep' };
    });
    return { goals, lastReview: db.housekeeping.lastReview, due: housekeeping().reviewDue };
  }
  function applyReview(a) {
    const ids = v => { if (v == null) return []; need(Array.isArray(v) && v.length <= 500 && v.every(x => typeof x === 'string' || typeof x === 'number'), 'The review choices were not understood.'); return v.map(String); };
    const keep = ids(a.keep), remove = ids(a.remove);
    need(!keep.some(k => remove.includes(k)), 'A goal cannot be both kept and removed.');
    const done = new Set(db.goals.filter(g => g.status === 'completed').map(g => g.id));
    if (keep.concat(remove).some(x => !done.has(x))) throw notFound('One of those goals is no longer in the completed list. Reload and try again.');
    db.goals.forEach(g => { if (keep.includes(g.id)) g.kept = true; });
    const gone = new Set(remove);
    const tasksDeleted = db.tasks.filter(t => gone.has(t.goalId)).length;
    db.tasks = db.tasks.filter(t => !gone.has(t.goalId));
    db.goals.forEach(g => { if (gone.has(g.parentId)) g.parentId = ''; });
    db.goals = db.goals.filter(g => !gone.has(g.id));
    db.housekeeping.lastReview = iso(0);
    return { result: { kept: keep.length, removed: remove.length, tasksDeleted, lastReview: iso(0) }, housekeeping: housekeeping() };
  }
  function updatePlan(a) {
    need(db.reports.weekly, 'There is no weekly review to edit yet. Run a weekly review first.');
    const p = a && a.plan;
    need(p && typeof p === 'object' && !Array.isArray(p), 'That plan is not valid.');
    const list = (v, max, what) => { if (v == null) return []; need(Array.isArray(v) && v.length <= max, 'A plan can have up to ' + max + ' ' + what + '.'); return v; };
    const goals = list(p.goals, 10, 'suggested goals').map(g => { need(g && typeof g === 'object', 'A suggested goal was not understood.'); const title = clip(g.title, 200); need(title, 'A suggested goal needs a title.'); return { title, priority: PRI[g.priority] != null ? g.priority : 'medium', rationale: clip(g.rationale, 300) }; });
    const text = max => x => { need(typeof x === 'string', 'A plan line was not understood.'); return clip(x, max); };
    const plan = { goals, priorities: list(p.priorities, 10, 'priorities').map(text(200)).filter(Boolean), focus_areas: list(p.focus_areas, 10, 'focus areas').map(text(100)).filter(Boolean), edited: iso(0) };
    db.reports.weekly.data.plan = plan;
    return { report: db.reports.weekly };
  }

  function runDaily() {
    const top = db.goals.filter(g => g.status === 'active').sort((x, y) => PRI[x.priority] - PRI[y.priority])[0];
    db.reports.daily = { date: new Date().toISOString(), type: 'daily', score: '', data: top
      ? { focus: top.title, actions: ['Spend 25 focused minutes on it', 'Write down one thing you got stuck on', 'Pick the very next step for tomorrow'],
          reason: 'This is your highest-priority active goal. (Demo mode: canned coaching.)',
          assessment: 'Your highest-priority goal and your to-do list pull the same way today, so start with the goal and fit the small tasks around it. (Demo mode: canned coaching.)', covered: [] }
      : { focus: 'Add a goal', actions: ['Write down one thing you want to learn'], reason: 'Nothing is active yet.', assessment: '', covered: [] } };
  }

  function runWeekly() {
    const done = db.goals.filter(g => g.status === 'completed').length;
    const score = db.goals.length ? Math.round(done / db.goals.length * 10) : 0;
    const recent = db.journal.filter(j => j.date >= iso(7));
    db.reports.weekly = { date: new Date().toISOString(), type: 'weekly', score, data: { score,
      dashboard: {
        summary: 'You logged ' + recent.length + ' ' + (recent.length === 1 ? 'entry' : 'entries') + ' this week. (Demo mode: canned review.)',
        wins: recent.slice(0, 2).map(j => j.text),
        misses: ['Nothing was logged on some days.'],
        suggestions: ['Log one line every day, even a short one.', 'Break the biggest goal into two tasks.']
      },
      plan: {
        goals: db.goals.filter(g => g.status === 'active').slice(0, 2).map(g => ({ title: 'Next step: ' + g.title, priority: g.priority, rationale: 'Keeps momentum on an active goal.' })),
        priorities: ['Protect a daily 25-minute block', 'Finish one task per active goal'],
        focus_areas: ['Consistency']
      } } };
    db.history.push({ week: iso(0), score, summary: db.reports.weekly.data.dashboard.summary });
  }

  function chat(a) {
    const msg = clip(a.message, 1000);
    need(msg, 'Say something first.');
    db.chat.push({ ts: new Date().toISOString(), role: 'user', text: msg });
    let reply;
    let m;
    if ((m = msg.match(/^add (?:a )?goal[:\s]+(.+)/i))) { addGoal({ title: m[1] }); reply = 'Added "' + clip(m[1], 200) + '".'; }
    else if ((m = msg.match(/^log[:\s]+(.+)/i)))        { logActivity({ text: m[1] }); reply = 'Logged it.'; }
    else if ((m = msg.match(/^(?:done|complete)[:\s]+(.+)/i))) {
      const g = db.goals.find(x => x.status === 'active' && x.title.toLowerCase().includes(m[1].toLowerCase()));
      if (g) { g.status = 'completed'; reply = 'Marked "' + g.title + '" complete.'; } else reply = 'I could not match that to an active goal.';
    }
    else if (/daily|focus/i.test(msg)) { runDaily(); reply = 'Fresh focus is on your dashboard.'; }
    else reply = 'Demo mode understands "add goal …", "log …", "done …" and "daily". Connect your own sheet for the real AI.';
    db.chat.push({ ts: new Date().toISOString(), role: 'bot', text: reply });
    return reply;
  }

  async function call(action, a) {
    const ai = ['runDaily', 'runWeekly', 'chat'].includes(action);
    await wait(ai ? 900 : 250);
    // Same contract as backend/Api.js: small changes answer with just what the page needs,
    // AI actions answer with the full state.
    switch (action) {
      case 'ping':           return { release: RELEASE, version: VERSION, hasKey: true, tz: 'local' };
      case 'getState':       return state();
      case 'addGoal':        { const goal = addGoal(a); save(); return { goal }; }
      case 'updateGoal':     { const goal = updateGoal(a); save(); return { goal }; }
      case 'saveAppearance': {
        // Same checks as backend/Sheets.js, using the lists in look.js.
        const t = a.theme == null || a.theme === '' ? 'dark' : a.theme, f = a.font == null || a.font === '' ? 'system' : a.font;
        need(typeof t === 'string' && Object.prototype.hasOwnProperty.call(Look.THEMES, t), 'Unknown theme.');
        need(typeof f === 'string' && Object.prototype.hasOwnProperty.call(Look.FONTS, f), 'Unknown font.');
        const hex = v => v == null || v === '' || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v));
        need(hex(a.primary), 'The primary color must look like #6ea8fe.');
        need(hex(a.accent), 'The accent color must look like #6ea8fe.');
        db.appearance = { theme: t, primary: a.primary ? a.primary.toLowerCase() : '', accent: a.accent ? a.accent.toLowerCase() : '', font: f };
        save();
        return { appearance: db.appearance };
      }
      case 'saveCoachVoice': {
        let v = String(a.text == null ? '' : a.text).replace(/\r\n?/g, '\n').slice(0, 800);
        if (!v.trim()) v = '';
        db.coachVoice = v; save();
        return { coachVoice: v };
      }
      case 'saveMyVoice': {
        const name = String(a.name == null ? '' : a.name).replace(/\s+/g, ' ').trim().slice(0, 30);
        const text = String(a.text == null ? '' : a.text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 800);
        need(name, 'Give this voice a name.');
        need(text.trim(), 'Write the voice first, then save it.');
        db.myVoices = db.myVoices || [];
        const same = db.myVoices.findIndex(v => v.name.toLowerCase() === name.toLowerCase());
        if (same >= 0) db.myVoices[same] = { id: db.myVoices[same].id, name, text };
        else {
          need(db.myVoices.length < 12, 'You can keep 12 voices of your own. Remove one first.');
          db.myVoices.push({ id: 'v' + (db.myVoices.reduce((m, v) => Math.max(m, Number(v.id.slice(1))), 0) + 1), name, text });
        }
        save();
        return { myVoices: db.myVoices };
      }
      case 'removeMyVoice': db.myVoices = (db.myVoices || []).filter(v => v.id !== String(a.id)); save(); return { myVoices: db.myVoices };
      case 'setGoalStatus':  setStatus(db.goals, a, ['active', 'completed', 'postponed', 'archived']); save(); return { ok: true };
      case 'addTask': {
        need(db.goals.some(g => g.id === String(a.goalId)), 'That goal does not exist.');
        const title = clip(a.title, 200);
        need(title, 'A task needs a title.');
        const task = { id: nextId(db.tasks), goalId: String(a.goalId), title, status: 'active', created: iso(0) };
        db.tasks.push(task);
        save();
        return { task: { ...task } };
      }
      case 'setTaskStatus':  setStatus(db.tasks, a, ['active', 'done', 'removed']); save(); return { ok: true };
      case 'logActivity':    { const entry = logActivity(a); save(); return { entry, streak: streak(), weekMinutes: weekMinutes() }; }
      case 'getToday':       return todayView();
      case 'saveWorkdaySchedule': {
        need(Array.isArray(a.hours) && a.hours.length >= 1 && a.hours.length <= 4 && a.hours.every(h => Number.isInteger(h) && h >= 0 && h <= 23), 'Choose between one and four times.');
        db.workday = { enabled: a.enabled === true, hours: a.hours.slice().sort((x, y) => x - y) }; save();
        return { schedule: todayView().schedule };
      }
      case 'refreshTasks':
      case 'refreshGoogle':  { const v = todayView(); return { tasks: tasksStatus(), calendar: v.calendar, view: v }; }
      case 'newChat':        db.chat.push({ ts: new Date().toISOString(), role: 'divider', text: 'new conversation' }); save(); return { chatHistory: [] };
      case 'setTodayFeed':   return { added: 0, updated: 0, purged: 0, count: 0, view: todayView() };
      case 'addTodayTask': {
        const title = clip(a.title, 80);
        need(title, 'A task needs a title.');
        const t = { id: nextId(db.today), date: iso(0), title, source: 'me', sourceId: '', points: null, state: '', goalId: tGoal(a.goalId), flags: [], status: 'open', doneOn: '', minutes: 0, logId: '', note: '' };
        db.today.push(t); save();
        return { task: { ...t } };
      }
      case 'setTodayGoal':   { const t = todayItem(a.id); t.goalId = tGoal(a.goalId); save(); return { task: { ...t } }; }
      case 'setTodayStatus': {
        need(a.status === 'open' || a.status === 'skipped', 'Use completeTodayTask to finish a task.');
        const t = todayItem(a.id);
        let out = {};
        if (t.status === 'done' && t.logId) { const r = removeLog({ id: t.logId }); out = { streak: r.streak, weekMinutes: r.weekMinutes }; }
        t.status = a.status; t.doneOn = a.status === 'open' ? '' : iso(0); t.minutes = 0; t.logId = '';
        save();
        return { task: { ...t }, ...out };
      }
      case 'addFocusBlock':
      case 'addScheduledAction':
      case 'scheduleTodayItem':
      case 'updateScheduledBlock':
      case 'removeScheduledBlock': return lookAction(action, a);
      case 'completeTodayTask': {
        const t = todayItem(a.id);
        if (t.status === 'done') return { task: { ...t }, entry: null, streak: streak(), weekMinutes: weekMinutes() };
        const mins = cleanMinutes(a.minutes);
        const g = t.goalId ? db.goals.find(x => x.id === t.goalId) : null;
        const isFocus = t.source === 'focus';
        const entry = logActivity({ text: isFocus ? 'Focus time' + ((t.tags || []).length ? ' (' + t.tags.join(', ') + ')' : '') : 'Completed: ' + t.title + (t.source === 'planner' && t.sourceId ? ' [#' + t.sourceId + ']' : ''), tags: isFocus ? ((t.tags || []).length ? t.tags.slice() : ['FOCUS']) : (g && g.tags.length ? g.tags.slice(0, 4) : ['TASK']), minutes: mins });
        t.status = 'done'; t.doneOn = iso(0); t.minutes = mins; t.logId = entry.id;
        save();
        return { task: { ...t }, entry, streak: streak(), weekMinutes: weekMinutes() };
      }
      case 'getLog':         return getLog(a);
      case 'updateLog':      { const r = updateLog(a); save(); return r; }
      case 'removeLog':      { const r = removeLog(a); save(); return r; }
      case 'restoreLog':     { const r = restoreLog(a); save(); return r; }
      case 'saveHousekeeping': {
        if (a.purgeDays != null) { need(typeof a.purgeDays === 'number' || (typeof a.purgeDays === 'string' && /^\s*\d+\s*$/.test(a.purgeDays)), 'Removed items can be kept for 14 or 30 days.'); need(cleanSteps[Number(a.purgeDays)], 'Removed items can be kept for 14 or 30 days.'); db.housekeeping.purgeDays = Number(a.purgeDays); save(); }
        return { housekeeping: housekeeping() };
      }
      case 'getReview':      return getReview();
      case 'applyReview':    { const r = applyReview(a); save(); return r; }
      case 'updatePlan':     { const r = updatePlan(a); save(); return r; }
      case 'submitFeedback': need(clip(a.text, 2000), 'Nothing to send.'); db.feedback.push({ date: iso(0), text: clip(a.text, 2000) }); save(); return { ok: true };
      case 'saveNotifications': db.notify = cleanNotify(a); save(); return { notify: notifyView() };
      case 'sendTestEmail':  return { sent: true, to: 'you@example.com', demo: true };
      case 'runDaily':       runDaily(); save(); return state();
      case 'runWeekly':      runWeekly(); save(); return state();
      case 'chat':           { const reply = chat(a); save(); return { reply, state: state() }; }
      default: { const e = new Error('Unknown action.'); e.code = 'bad_action'; throw e; }
    }
  }

  const reset = () => { db = seed(); save(); };
  return { call, reset };
})();
