'use strict';
// mock.js — an in-browser stand-in for the Apps Script backend ("demo data").
// Same actions and response shapes as backend/Api.js, stored in localStorage.
// The AI replies are canned: it exists to try the interface, not to coach you.

const Mock = (() => {
  const KEY = 'learnerbot.demo.v1';
  const DAY = 864e5;
  const iso = n => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const tags = t => (Array.isArray(t) ? t.join(',') : String(t || '')).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const PRI = { high: 0, medium: 1, low: 2 };

  let db = load();

  function seed() {
    return {
      goals: [
        { id: '1', title: 'Learn Python fundamentals', priority: 'high', status: 'active', created: iso(20), tags: ['PYTHON', 'LEARNING'], parentId: '' },
        { id: '2', title: 'Finish the data structures course', priority: 'medium', status: 'active', created: iso(18), tags: ['LEARNING'], parentId: '1' },
        { id: '3', title: 'Read one technical book a month', priority: 'low', status: 'active', created: iso(30), tags: ['READING'], parentId: '' },
        { id: '4', title: 'Set up a home lab', priority: 'medium', status: 'postponed', created: iso(40), tags: ['HOMELAB'], parentId: '' },
        { id: '5', title: 'Ship a first small project', priority: 'high', status: 'completed', created: iso(50), tags: ['PYTHON'], parentId: '' }
      ],
      tasks: [
        { id: '1', goalId: '1', title: 'Work through chapters 1–3', status: 'done', created: iso(15) },
        { id: '2', goalId: '1', title: 'Write a CLI that renames files', status: 'active', created: iso(10) },
        { id: '3', goalId: '2', title: 'Implement a linked list', status: 'active', created: iso(7) }
      ],
      journal: [
        { date: iso(0), text: 'Read two chapters on dictionaries and sets.', tags: ['PYTHON'] },
        { date: iso(1), text: 'Solved three practice problems.', tags: ['LEARNING'] },
        { date: iso(2), text: 'Started the linked list exercise.', tags: ['LEARNING'] }
      ],
      feedback: [{ date: iso(3), text: 'Be more concrete about next steps.' }],
      history: [
        { week: iso(21), score: 4, summary: 'Slow start, mostly planning.' },
        { week: iso(14), score: 6, summary: 'Found a routine.' },
        { week: iso(7), score: 7, summary: 'Steady progress on Python.' }
      ],
      chat: [],
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
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.goals) return s; } catch (_) { /* fall through */ }
    return seed();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) { /* memory only */ } }
  function nextId(list) { return String(list.reduce((m, x) => Math.max(m, parseInt(x.id, 10) || 0), 0) + 1); }

  function streak() {
    const days = new Set(db.journal.map(j => j.date));
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
      hasKey: true,
      _errors: []
    };
  }

  const need = (cond, msg) => { if (!cond) { const e = new Error(msg); e.code = 'bad_request'; throw e; } };

  function addGoal(a) {
    const title = clip(a.title, 200);
    need(title, 'A goal needs a title.');
    const parent = a.parentId ? String(a.parentId) : '';
    if (parent && !db.goals.some(g => g.id === parent)) { const e = new Error('The parent goal does not exist.'); e.code = 'not_found'; throw e; }
    const goal = { id: nextId(db.goals), title, priority: PRI[a.priority] != null ? a.priority : 'medium', status: 'active',
      created: iso(0), tags: tags(a.tags), parentId: parent };
    db.goals.push(goal);
    return { ...goal };
  }
  function setStatus(list, a, allowed) {
    need(allowed.includes(a.status), 'Unknown status.');
    const item = list.find(x => x.id === String(a.id));
    if (!item) { const e = new Error('Not found.'); e.code = 'not_found'; throw e; }
    item.status = a.status;
  }
  function logActivity(a) {
    const text = clip(a.text, 2000);
    need(text, 'Nothing to log.');
    db.journal.push({ date: iso(0), text, tags: tags(a.tags) });
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
      case 'ping':           return { version: 'demo', hasKey: true, tz: 'local' };
      case 'getState':       return state();
      case 'addGoal':        { const goal = addGoal(a); save(); return { goal }; }
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
      case 'logActivity':    logActivity(a); save(); return { streak: streak() };
      case 'submitFeedback': need(clip(a.text, 2000), 'Nothing to send.'); db.feedback.push({ date: iso(0), text: clip(a.text, 2000) }); save(); return { ok: true };
      case 'runDaily':       runDaily(); save(); return state();
      case 'runWeekly':      runWeekly(); save(); return state();
      case 'chat':           { const reply = chat(a); save(); return { reply, state: state() }; }
      default: { const e = new Error('Unknown action.'); e.code = 'bad_action'; throw e; }
    }
  }

  const reset = () => { db = seed(); save(); };
  return { call, reset };
})();
