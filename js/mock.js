'use strict';
// mock.js — an in-browser stand-in for the Apps Script backend ("demo data").
// Same actions and response shapes as backend/Api.js, stored in localStorage.
// The AI replies are canned: it exists to try the interface, not to coach you.

const Mock = (() => {
  const KEY = 'learnerbot.demo.v1';
  const VERSION = '2026.10.14';
  const RELEASE = '1.7';   // the backend version this demo mirrors (a test keeps it equal to backend/Code.js)
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

  function state() {
    return {
      goals: db.goals.filter(g => g.status !== 'archived'),
      tasks: db.tasks.filter(t => t.status !== 'removed'),
      historyGoals: db.goals.filter(g => g.status !== 'active'),
      dailyReport: db.reports.daily,
      weeklyReport: db.reports.weekly,
      recentFeedback: db.feedback.slice(-3),
      history: db.history.slice(-5),
      chatHistory: db.chat.slice(-30),
      streak: streak(),
      weekMinutes: weekMinutes(),
      coachVoice: db.coachVoice || '',
      myVoices: db.myVoices || [],
      appearance: db.appearance || null,
      housekeeping: housekeeping(),
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
          reason: 'This is your highest-priority active goal. (Demo mode: canned coaching.)' }
      : { focus: 'Add a goal', actions: ['Write down one thing you want to learn'], reason: 'Nothing is active yet.' } };
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
