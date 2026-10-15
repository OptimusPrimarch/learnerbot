'use strict';
// app.js — LearnerBot UI.
// Rendering is ported from the original Apps Script page. Clicks use data-act
// attributes handled in one place (no inline handlers), so goal titles and model
// output are never spliced into JavaScript, only escaped into HTML text.

// ---- state ---------------------------------------------------
let STATE = null;
let VIEW = 'dash';
let TAG_FILTER = null;
const CHILD_FORMS_OPEN = new Set();
const OPEN_DETAILS = new Set();
let pending = 0;        // requests in flight
let aiBusy = false;
let chatReady = false;

// ---- tiny helpers --------------------------------------------
const $ = id => document.getElementById(id);
const arr = x => (Array.isArray(x) ? x : []);
const PRIORITIES = ['high', 'medium', 'low'];
const pri = p => (PRIORITIES.includes(p) ? p : 'medium');
const statusClass = s => (['completed', 'postponed', 'archived'].includes(s) ? s : '');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
function fmtDate(d) {
  if (!d) return '';
  try {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return String(d); }
}
function tagColor(tag) {
  let h = 0;
  for (const c of String(tag)) h = ((h * 31) + c.charCodeAt(0)) & 0xffff;
  const hue = h % 360;
  return { bg: `hsl(${hue},45%,12%)`, fg: `hsl(${hue},70%,65%)`, border: `hsl(${hue},40%,28%)` };
}
function tagChip(tag) {
  const { bg, fg, border } = tagColor(tag);
  return `<span class="tag" style="background:${bg};color:${fg};border:1px solid ${border}">${esc(tag)}</span>`;
}

// ---- status, toast -------------------------------------------
function setStatus(msg, kind) {
  const c = $('statusChip');
  c.className = 'chip' + (kind ? ' ' + kind : '');
  c.textContent = '';
  if (kind === 'busy') { const sp = document.createElement('span'); sp.className = 'spinner'; c.appendChild(sp); }
  c.appendChild(document.createTextNode(msg));
}
let toastTimer;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'error' ? 6000 : 2500);
}
function updateStreak(n) {
  const chip = $('streakChip');
  chip.hidden = !(n > 0);
  if (n > 0) { chip.textContent = n + 'd streak'; chip.title = n + ' consecutive days with activity logged'; }
}
function updateModeUi() { $('demoChip').hidden = !Api.isDemo(); }

// ---- talking to the backend ----------------------------------
const isAuthError = e => ['unauthorized', 'not_configured', 'bad_url'].includes(e && e.code);

function request(label, action, args) {
  pending++;
  setStatus(label + ' …', 'busy');
  return Api.call(action, args).then(
    res => { pending--; return { res, latest: pending === 0 }; },
    err => { pending--; throw err; }
  );
}

function fail(err) {
  console.error(err);
  if (isAuthError(err)) { setStatus('Not connected', 'err'); openSettings(err.message, 'err'); return; }
  toast(err.message, 'error');
  if (pending === 0) { setStatus('Error', 'err'); load(); }   // resync: optimistic changes may not have stuck
}

function load() {
  return request('Loading', 'getState')
    .then(({ res, latest }) => { if (latest || !STATE) applyState(res); })
    .catch(err => {
      if (isAuthError(err)) return fail(err);
      setStatus('Could not load — ' + err.message, 'err');
    });
}

function applyState(s) {
  if (!s || !s.goals) return load();
  STATE = s;
  if (!chatReady) { initChat(arr(s.chatHistory)); chatReady = true; }
  try { render(); }
  catch (e) { setStatus('Render error: ' + e.message, 'err'); console.error(e); return; }
  if (arr(s._errors).length) setStatus('Partial error: ' + s._errors.join(' | '), 'err');
  else setStatus('Ready', 'ok');
}

/** Optional instant local change, then the real request. Only the newest response is applied. */
function mutate(label, optimistic, action, args, after) {
  if (optimistic && STATE) { optimistic(); render(); }
  request(label, action, args)
    .then(({ res, latest }) => { if (after) after(); if (latest) applyState(res); })
    .catch(fail);
}

// ---- optimistic local edits ----------------------------------
function placeGoal(list, next, keep) {
  const i = list.findIndex(x => x.id === next.id);
  if (!keep) return i < 0 ? list : list.filter(x => x.id !== next.id);
  if (i < 0) return [...list, next];
  const copy = list.slice();
  copy[i] = next;
  return copy;
}
function setGoalLocal(id, status) {
  const g = [...STATE.goals, ...STATE.historyGoals].find(x => x.id === String(id));
  if (!g) return;
  const next = { ...g, status };
  STATE.goals = placeGoal(STATE.goals, next, status !== 'archived');
  STATE.historyGoals = placeGoal(STATE.historyGoals, next, status !== 'active');
}
function setTaskLocal(id, status) {
  STATE.tasks = status === 'removed'
    ? STATE.tasks.filter(t => t.id !== String(id))
    : STATE.tasks.map(t => (t.id === String(id) ? { ...t, status } : t));
}
const setGoal = (id, status, label) => mutate(label, () => setGoalLocal(id, status), 'setGoalStatus', { id, status });
const setTask = (id, status, label) => mutate(label, () => setTaskLocal(id, status), 'setTaskStatus', { id, status });

// ---- views ---------------------------------------------------
function switchView(v) {
  VIEW = v;
  $('navDash').classList.toggle('active', v === 'dash');
  $('navHist').classList.toggle('active', v === 'history');
  $('mainGrid').hidden = v !== 'dash';
  $('histView').hidden = v !== 'history';
  if (STATE) render();
}

function snapshotInputs() {
  const snap = { values: {}, focus: null };
  document.querySelectorAll('#mainGrid input[id], #mainGrid textarea[id], #mainGrid select[id]').forEach(el => { snap.values[el.id] = el.value; });
  const a = document.activeElement;
  if (a && a.id && a.closest('#mainGrid')) snap.focus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
  return snap;
}
function restoreInputs(snap) {
  Object.entries(snap.values).forEach(([id, v]) => { const el = $(id); if (el && el.value !== v) el.value = v; });
  if (snap.focus) {
    const el = $(snap.focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch (_) { /* not a text field */ } }
  }
}

function render() {
  updateStreak(STATE.streak || 0);
  const snap = snapshotInputs();
  if (VIEW === 'history') renderHistory(); else renderDash();
  restoreInputs(snap);
  syncAiButtons();
}

// The Run buttons live inside their cards, so a re-render must keep them disabled mid-run.
function syncAiButtons() {
  document.querySelectorAll('[data-act="runDaily"], [data-act="runWeekly"]').forEach(b => { b.disabled = aiBusy; });
}

function renderDash() {
  const s = STATE;
  const g = $('mainGrid');
  g.innerHTML = '';
  g.appendChild(focusCard(s.dailyReport));
  g.appendChild(goalsCard(arr(s.goals), arr(s.tasks)));
  g.appendChild(weeklyCard(s.weeklyReport));
  g.appendChild(planCard(s.weeklyReport));
  g.appendChild(logCard());
  g.appendChild(feedbackCard(arr(s.recentFeedback), arr(s.history)));
}

function showConnect() {
  $('mainGrid').innerHTML = `<div class="card wide connect">
    <h3>Welcome to LearnerBot</h3>
    <p class="muted">Set goals, log what you did, and get a coach that notices patterns.<br>Your data stays in your own Google Sheet.</p>
    <div class="row">
      <button data-act="settings">Connect your sheet</button>
      <button class="ghost" data-act="useDemo">Try demo data</button>
      <a class="nav-btn" href="setup.html" style="text-decoration:none;padding:8px 14px">Setup guide</a>
    </div></div>`;
  setStatus('Not connected', '');
  updateModeUi();
  updateStreak(0);
}

// ---- history view --------------------------------------------
function renderHistory() {
  const all = arr(STATE.historyGoals);
  const groups = [
    ['Completed', '✓', all.filter(g => g.status === 'completed')],
    ['Postponed / On Hold', '⏸', all.filter(g => g.status === 'postponed')],
    ['Removed', '✕', all.filter(g => g.status === 'archived')]
  ];
  let html = groups.filter(([, , list]) => list.length).map(([t, i, list]) => histSection(t, i, list)).join('');
  if (!all.length) html = `<div class="card wide"><p class="empty">No goal history yet. Complete or postpone goals to see them here.</p></div>`;
  $('histView').innerHTML = html;
}

function histSection(title, icon, goals) {
  const rows = goals.map(g => `
    <div class="hist-row">
      <span class="pill ${statusClass(g.status)}">${icon} ${esc(g.status)}</span>
      <span style="flex:1;min-width:0">${esc(g.title)}</span>
      ${arr(g.tags).length ? `<span class="tags">${g.tags.map(tagChip).join('')}</span>` : ''}
      <span class="hist-meta">added ${esc(fmtDate(g.created))}</span>
      <button class="icon ghost" data-act="reactivate" data-id="${esc(g.id)}" title="Reactivate" aria-label="Reactivate">↺</button>
    </div>`).join('');
  return `<div class="card wide hist-section"><label class="head">${esc(title)}</label>${rows}</div>`;
}

// ---- cards ---------------------------------------------------
function focusCard(rep) {
  const d = div('card focus wide');
  let html = `<div class="card-head"><label class="head">Today's Focus</label><button class="ghost run" data-act="runDaily">Run daily</button></div>`;
  if (rep && rep.data) {
    const r = rep.data;
    html += `<h3>${esc(r.focus)}</h3>
      <ul class="plain">${arr(r.actions).map(a => `<li>${esc(a)}</li>`).join('')}</ul>
      ${r.reason ? `<p class="muted" style="margin-top:10px;font-size:14px">${esc(r.reason)}</p>` : ''}
      <p class="ts">Generated ${esc(fmtDate(rep.date))}</p>`;
  } else {
    html += `<p class="empty">No daily focus yet — hit <em>Run daily</em> or ask the assistant.</p>`;
  }
  d.innerHTML = html;
  return d;
}

function goalsCard(goals, tasks) {
  const active = goals.filter(g => g.status === 'active');
  const tasksMap = {};
  tasks.forEach(t => { (tasksMap[t.goalId] = tasksMap[t.goalId] || []).push(t); });

  const tagFreq = {};
  active.forEach(g => arr(g.tags).forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; }));
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);

  // Tag filter keeps matching goals plus their ancestors and descendants.
  let visible = active;
  if (TAG_FILTER) {
    const matched = new Set(active.filter(g => arr(g.tags).includes(TAG_FILTER)).map(g => g.id));
    let changed = true;
    while (changed) {
      changed = false;
      active.forEach(g => {
        if (matched.has(g.id) && g.parentId && !matched.has(g.parentId)) { matched.add(g.parentId); changed = true; }
        if (g.parentId && matched.has(g.parentId) && !matched.has(g.id)) { matched.add(g.id); changed = true; }
      });
    }
    visible = active.filter(g => matched.has(g.id));
  }

  const nodeMap = {};
  visible.forEach(g => { nodeMap[g.id] = { ...g, children: [] }; });
  const roots = [];
  visible.forEach(g => {
    if (g.parentId && nodeMap[g.parentId]) nodeMap[g.parentId].children.push(nodeMap[g.id]);
    else roots.push(nodeMap[g.id]);
  });

  const d = div('card');
  let html = `<label class="head">Active Goals</label>`;

  if (topTags.length) {
    const chips = topTags.map(t => {
      const { bg, fg, border } = tagColor(t);
      const outline = TAG_FILTER === t ? `;outline:2px solid ${fg};outline-offset:1px` : '';
      return `<span class="tag" role="button" tabindex="0" style="background:${bg};color:${fg};border:1px solid ${border};cursor:pointer${outline}" data-act="filterTag" data-tag="${esc(t)}">${esc(t)}</span>`;
    }).join('');
    html += `<div class="tags" style="margin-bottom:10px">${chips}${TAG_FILTER ? `&nbsp;<button class="ghost icon" data-act="filterTag" data-tag="" style="font-size:11px;padding:2px 8px">✕ clear</button>` : ''}</div>`;
  }

  if (roots.length) html += `<ul class="plain">${roots.map(n => renderGoalNode(n, tasksMap)).join('')}</ul>`;
  else if (active.length && TAG_FILTER) html += `<p class="empty">No goals match <strong>${esc(TAG_FILTER)}</strong>.</p>`;
  else html += `<p class="empty">No active goals yet.</p>`;

  html += `
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <label class="head" style="margin-bottom:6px" for="goalTitle">Add Goal</label>
      <input id="goalTitle" type="text" placeholder="Goal title…" style="margin-bottom:6px" data-enter="addGoal" maxlength="200">
      <div class="row">
        <select id="goalPri" style="width:auto" aria-label="Priority">
          <option value="high">High</option>
          <option value="medium" selected>Med</option>
          <option value="low">Low</option>
        </select>
        <input id="goalTags" type="text" placeholder="Tags: WORK, AI (optional)" data-enter="addGoal" aria-label="Tags">
        <button data-act="addGoal">Add</button>
      </div>
    </div>`;
  d.innerHTML = html;
  return d;
}

function renderGoalNode(node, tasksMap) {
  const id = esc(node.id);
  const gTasks = tasksMap[node.id] || [];
  const activeTasks = gTasks.filter(t => t.status === 'active');
  const doneTasks = gTasks.filter(t => t.status === 'done');
  const pct = gTasks.length ? Math.round(doneTasks.length / gTasks.length * 100) : null;

  const taskItems = gTasks.map(t => t.status === 'done'
    ? `<li><span class="task-done">${esc(t.title)}</span><button class="icon ghost" data-act="reopenTask" data-id="${esc(t.id)}" title="Reopen" aria-label="Reopen task">↺</button></li>`
    : `<li>${esc(t.title)}<span class="actions"><button class="icon ghost" data-act="completeTask" data-id="${esc(t.id)}" title="Done" aria-label="Mark task done">✓</button><button class="icon ghost" data-act="removeTask" data-id="${esc(t.id)}" title="Remove" aria-label="Remove task">✕</button></span></li>`
  ).join('');

  const taskLabel = gTasks.length === 0 ? 'no tasks' : `${activeTasks.length} active${doneTasks.length ? ', ' + doneTasks.length + ' done' : ''}`;
  const childLabel = node.children.length ? `${node.children.length} sub-goal${node.children.length > 1 ? 's' : ''}` : '';
  const open = key => (OPEN_DETAILS.has(key) ? ' open' : '');

  const childForm = CHILD_FORMS_OPEN.has(node.id) ? `
    <div class="child-form">
      <input type="text" id="cgt_${id}" data-id="${id}" data-enter="addChild" placeholder="Sub-goal title…" style="flex:2;min-width:120px" maxlength="200" aria-label="Sub-goal title">
      <select id="cgp_${id}" style="width:auto" aria-label="Priority"><option value="high">High</option><option value="medium" selected>Med</option><option value="low">Low</option></select>
      <input type="text" id="cgtags_${id}" data-id="${id}" data-enter="addChild" placeholder="Tags…" style="flex:1;min-width:70px" aria-label="Tags">
      <button data-act="addChild" data-id="${id}">+ Add</button>
      <button class="ghost" data-act="toggleChildForm" data-id="${id}" aria-label="Cancel">✕</button>
    </div>` : '';

  const children = node.children.length
    ? `<details class="subgoals" data-key="s:${id}"${open('s:' + node.id)}><summary>${childLabel}</summary><div class="goal-indent"><ul class="plain">${node.children.map(c => renderGoalNode(c, tasksMap)).join('')}</ul></div></details>`
    : '';

  return `<li>
    <div class="goal-row">
      <span class="goal-left">
        <span class="pill ${pri(node.priority)}">${pri(node.priority)}</span>
        <span class="goal-title" title="${esc(node.title)}">${esc(node.title)}</span>
        ${arr(node.tags).length ? `<span class="tags">${node.tags.map(tagChip).join('')}</span>` : ''}
      </span>
      <span class="actions">
        <button class="icon ghost" data-act="toggleChildForm" data-id="${id}" title="Add sub-goal" aria-label="Add sub-goal">⊕</button>
        <button class="icon ghost" data-act="complete" data-id="${id}" title="Complete" aria-label="Complete goal">✓</button>
        <button class="icon ghost" data-act="postpone" data-id="${id}" title="Postpone" aria-label="Postpone goal">⏸</button>
        <button class="icon ghost" data-act="remove" data-id="${id}" title="Remove" aria-label="Remove goal">✕</button>
      </span>
    </div>
    ${pct !== null ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
    <details class="tasks" data-key="t:${id}"${open('t:' + node.id)}>
      <summary>${taskLabel}</summary>
      ${gTasks.length ? `<ul class="task-list">${taskItems}</ul>` : ''}
      <div class="task-add"><input type="text" id="ti_${id}" data-id="${id}" data-enter="addTask" placeholder="Add a task…" maxlength="200" aria-label="New task"><button data-act="addTask" data-id="${id}" aria-label="Add task">+</button></div>
    </details>
    ${childForm}
    ${children}
  </li>`;
}

function weeklyCard(rep) {
  const d = div('card');
  let html = `<div class="card-head"><label class="head">Weekly Review</label><button class="ghost run" data-act="runWeekly">Run weekly</button></div>`;
  if (rep && rep.data && rep.data.dashboard) {
    const r = rep.data.dashboard;
    html += `<p style="margin-bottom:10px">${esc(r.summary)}</p>`;
    if (arr(r.wins).length)
      html += `<label class="head" style="margin-top:10px">Wins</label><ul class="plain wins">${r.wins.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
    if (arr(r.misses).length)
      html += `<label class="head" style="margin-top:10px">Misses</label><ul class="plain misses">${r.misses.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`;
    if (arr(r.suggestions).length)
      html += `<label class="head" style="margin-top:10px">Suggestions</label><ul class="plain sugg">${r.suggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
    html += `<p class="ts">Score ${esc(rep.data.score || '–')}/10 · ${esc(fmtDate(rep.date))}</p>`;
  } else {
    html += `<p class="empty">No weekly review yet — log some activity first, then hit <em>Run weekly</em>.</p>`;
  }
  d.innerHTML = html;
  return d;
}

function planCard(rep) {
  const d = div('card');
  let html = `<label class="head">Proposed Plan</label>`;
  if (rep && rep.data && rep.data.plan) {
    const p = rep.data.plan;
    if (arr(p.focus_areas).length)
      html += `<p class="muted" style="margin-bottom:10px;font-size:13px">Focus: ${p.focus_areas.map(esc).join(' · ')}</p>`;
    if (arr(p.goals).length) {
      html += `<ul class="plain">` + p.goals.map((g, i) => `
        <li class="goal-row">
          <span class="goal-left">
            <span class="pill ${pri(g.priority)}">${pri(g.priority)}</span>
            <span class="goal-title" title="${esc(g.rationale || '')}">${esc(g.title)}</span>
          </span>
          <button class="icon ghost" data-act="acceptGoal" data-idx="${i}" title="Add this as a goal">+ add</button>
        </li>`).join('') + `</ul>`;
    }
    if (arr(p.priorities).length)
      html += `<label class="head" style="margin-top:12px">Priorities</label><ul class="plain sugg">${p.priorities.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  } else {
    html += `<p class="empty">Run a weekly review to get a proposed plan.</p>`;
  }
  d.innerHTML = html;
  return d;
}

function logCard() {
  const d = div('card');
  d.innerHTML = `
    <label class="head" for="logText">Log Activity</label>
    <p class="muted" style="font-size:13px;margin-bottom:8px">What happened this week? Feeds your next weekly review.</p>
    <textarea id="logText" placeholder="e.g. Shipped the auth refactor; studied system design 30min." maxlength="2000"></textarea>
    <input id="logTags" type="text" placeholder="Tags: WORK, AI (optional)" style="margin-top:6px" aria-label="Tags">
    <div class="row"><button data-act="logActivity">Log it</button></div>`;
  return d;
}

function feedbackCard(feedback, history) {
  const d = div('card');
  let html = `
    <label class="head" for="fbText">Steer the Assistant</label>
    <p class="muted" style="font-size:13px;margin-bottom:8px">Tell it how to behave — tone, focus, what's not working.</p>
    <textarea id="fbText" placeholder="e.g. Push me harder on learning goals. Be more concrete." maxlength="2000"></textarea>
    <div class="row"><button data-act="sendFeedback">Send</button></div>`;
  if (feedback.length) {
    html += `<label class="head" style="margin-top:14px">Recent feedback</label>
      <ul class="plain">${feedback.map(f => `<li class="muted" style="font-size:13px">${esc(f.text)}</li>`).join('')}</ul>`;
  }
  if (history.length) {
    const bars = history.map(h => {
      const score = Number(h.score) || 0;
      return `<div class="bar" style="height:${Math.max(0, Math.min(10, score)) * 8 + 4}px" title="Week of ${esc(h.week)}: ${esc(h.score)}/10"><span>${h.score == null ? '–' : esc(h.score)}</span></div>`;
    }).join('');
    html += `<label class="head" style="margin-top:14px">Weekly scores</label><div class="bars">${bars}</div>`;
  }
  d.innerHTML = html;
  return d;
}

// ---- actions -------------------------------------------------
function val(id) { const el = $(id); return el ? el.value.trim() : ''; }
function clearFields(...ids) { ids.forEach(i => { const el = $(i); if (el) el.value = ''; }); }

function runAi(kind) {
  if (aiBusy) return;
  aiBusy = true;
  syncAiButtons();
  request('Running ' + kind + ' (10–20 s)', kind === 'weekly' ? 'runWeekly' : 'runDaily')
    .then(({ res, latest }) => { if (latest) applyState(res); toast(kind === 'weekly' ? 'Weekly review ready.' : 'Daily focus ready.'); })
    .catch(fail)
    .finally(() => { aiBusy = false; syncAiButtons(); });
}

const HANDLERS = {
  view:       d => switchView(d.view),
  runDaily:   () => runAi('daily'),
  runWeekly:  () => runAi('weekly'),
  settings:   () => openSettings(),
  closeSettings: () => $('settings').close(),
  saveSettings,
  copyTimings: () => {
    const rows = timingSummary();
    const text = rows.length ? rows.map(r => `${r.action}: median ${r.median} ms, last ${r.last} ms, ${r.count}x`).join('\n') : 'no requests yet';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
      .then(() => toast('Timings copied.'), () => toast('Could not copy. Select the text instead.', 'error'));
  },
  useDemo:    () => { Api.setConfig({ mode: 'demo' }); resetSession(); $('settings').close(); boot(); },
  disconnect: () => { Api.setConfig({}); resetSession(); $('settings').close(); showConnect(); },
  chatToggle: (_, el) => {
    const dock = $('chat');
    dock.classList.toggle('collapsed');
    el.setAttribute('aria-expanded', String(!dock.classList.contains('collapsed')));
  },

  filterTag:  d => { TAG_FILTER = d.tag && TAG_FILTER !== d.tag ? d.tag : null; if (STATE) render(); },
  toggleChildForm: d => {
    if (CHILD_FORMS_OPEN.has(d.id)) CHILD_FORMS_OPEN.delete(d.id); else CHILD_FORMS_OPEN.add(d.id);
    if (STATE) render();
  },

  complete:   d => setGoal(d.id, 'completed', 'Completing'),
  postpone:   d => setGoal(d.id, 'postponed', 'Postponing'),
  reactivate: d => setGoal(d.id, 'active', 'Reactivating'),
  remove:     d => { if (confirm('Remove this goal?')) setGoal(d.id, 'archived', 'Removing'); },

  addGoal: () => {
    const title = val('goalTitle');
    if (!title) return;
    mutate('Adding goal', null, 'addGoal', { title, priority: val('goalPri'), tags: val('goalTags') },
      () => clearFields('goalTitle', 'goalTags'));
  },
  addChild: d => {
    const title = val('cgt_' + d.id);
    if (!title) return;
    CHILD_FORMS_OPEN.delete(d.id);
    OPEN_DETAILS.add('s:' + d.id);
    mutate('Adding sub-goal', null, 'addGoal', { title, priority: val('cgp_' + d.id), tags: val('cgtags_' + d.id), parentId: d.id });
  },
  acceptGoal: d => {
    const g = arr(STATE && STATE.weeklyReport && STATE.weeklyReport.data && STATE.weeklyReport.data.plan && STATE.weeklyReport.data.plan.goals)[Number(d.idx)];
    if (g) mutate('Adding goal', null, 'addGoal', { title: g.title, priority: g.priority, tags: '' });
  },

  addTask: d => {
    const title = val('ti_' + d.id);
    if (!title) return;
    OPEN_DETAILS.add('t:' + d.id);
    mutate('Adding task', null, 'addTask', { goalId: d.id, title }, () => clearFields('ti_' + d.id));
  },
  completeTask: d => setTask(d.id, 'done', 'Completing task'),
  reopenTask:   d => setTask(d.id, 'active', 'Reopening task'),
  removeTask:   d => setTask(d.id, 'removed', 'Removing task'),

  logActivity: () => {
    const text = val('logText');
    if (!text) return;
    mutate('Logging', null, 'logActivity', { text, tags: val('logTags') }, () => clearFields('logText', 'logTags'));
  },
  sendFeedback: () => {
    const text = val('fbText');
    if (!text) return;
    mutate('Saving feedback', null, 'submitFeedback', { text }, () => clearFields('fbText'));
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = HANDLERS[el.dataset.act];
  if (fn) fn(el.dataset, el);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches('input[data-enter]')) {
    e.preventDefault();
    const fn = HANDLERS[e.target.dataset.enter];
    if (fn) fn(e.target.dataset, e.target);
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-act]')) {
    e.preventDefault();
    e.target.click();
  }
});

// Remember which panels are open across re-renders.
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return;
  if (d.open) OPEN_DETAILS.add(d.dataset.key); else OPEN_DETAILS.delete(d.dataset.key);
}, true);

// ---- settings ------------------------------------------------
function cfgMsg(text, kind) {
  const p = $('cfgMsg');
  p.textContent = text || '';
  p.className = 'cfg-msg' + (kind ? ' ' + kind : '');
}

// Median / last duration per action, so real-world speed is visible without dev tools.
function timingSummary() {
  const by = {};
  Api.timings().forEach(r => { (by[r.action] = by[r.action] || []).push(r.ms); });
  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  return Object.entries(by).map(([action, ms]) => ({ action, median: median(ms), last: ms[ms.length - 1], count: ms.length }));
}

function renderTimings() {
  const rows = timingSummary();
  $('timingsList').innerHTML = rows.length
    ? rows.map(r => `<div>${esc(r.action)}: median ${r.median} ms · last ${r.last} ms · ${r.count}×</div>`).join('')
    : 'Nothing yet. Use the app, then look again.';
}

function openSettings(message, kind) {
  renderTimings();
  const cfg = Api.getConfig();
  $('cfgUrl').value = cfg.url || '';
  $('cfgToken').value = '';
  $('cfgToken').placeholder = cfg.token ? 'Saved — leave blank to keep it' : 'Paste the access token';
  cfgMsg(typeof message === 'string' ? message : '', kind);
  const dlg = $('settings');
  if (!dlg.open) dlg.showModal();
  $('cfgUrl').focus();
}

async function saveSettings() {
  const url = $('cfgUrl').value.trim();
  const prev = Api.getConfig();
  const token = $('cfgToken').value.trim() || (prev.mode === 'demo' ? '' : prev.token) || '';
  if (!Api.validateUrl(url)) return cfgMsg('That is not a Google Apps Script web app URL. It should start with https://script.google.com/macros/s/ and end with /exec.', 'err');
  if (!token) return cfgMsg('Paste the access token from the sheet\'s LearnerBot menu.', 'err');

  Api.setConfig({ url, token });
  cfgMsg('Testing the connection…');
  try {
    const info = await Api.call('ping');
    cfgMsg('Connected' + (info.version ? ' (backend ' + info.version + ')' : '') + '.' +
      (info.hasKey ? '' : ' No Groq key is saved yet, so the AI features will not work until you add one.'), 'good');
    resetSession();
    $('settings').close();
    boot();
  } catch (e) {
    Api.setConfig(prev);
    cfgMsg(e.message, 'err');
  }
}

function resetSession() {
  STATE = null;
  chatReady = false;
  pending = 0;
  $('chatLog').innerHTML = '';
  TAG_FILTER = null;
  CHILD_FORMS_OPEN.clear();
  OPEN_DETAILS.clear();
}

// ---- chat ----------------------------------------------------
const CHAT_GREETING = 'Hey! Tell me what you did, add a goal or task, give feedback, or ask for today\'s focus.';

function addMsg(text, who) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function initChat(history) {
  $('chatLog').innerHTML = '';
  if (!history.length) { addMsg(CHAT_GREETING, 'bot'); return; }
  history.slice(-20).forEach(m => addMsg(m.text, m.role === 'user' ? 'you' : 'bot'));
}

function sendChat(e) {
  e.preventDefault();
  const inp = $('chatInput');
  const msg = inp.value.trim();
  if (!msg) return;
  addMsg(msg, 'you');
  inp.value = '';
  const thinking = addMsg('…', 'bot');
  request('Thinking', 'chat', { message: msg })
    .then(({ res, latest }) => {
      thinking.textContent = res.reply || 'Done.';
      if (latest) applyState(res.state);
    })
    .catch(err => {
      thinking.textContent = 'Error: ' + err.message;
      if (isAuthError(err)) fail(err); else if (pending === 0) { setStatus('Error', 'err'); load(); }
    });
}

// ---- boot ----------------------------------------------------
function boot() {
  updateModeUi();
  load();
}

document.addEventListener('DOMContentLoaded', () => {
  $('chatForm').addEventListener('submit', sendChat);
  if (window.matchMedia('(max-width: 680px)').matches) {   // start the chat dock collapsed on phones
    $('chat').classList.add('collapsed');
    document.querySelector('.chat-head').setAttribute('aria-expanded', 'false');
  }
  switchView('dash');
  if (Api.isConfigured()) boot(); else showConnect();
});
