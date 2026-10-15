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
let unsaved = 0;         // changes made here that the server has not confirmed yet
let needsResync = false; // a full-state answer was skipped because newer local edits are in flight
let lastLoadAt = 0;
let tmpCounter = 0;
const ID_MAP = new Map(); // temporary id -> real id, once the server has answered

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

function request(label, action, args, onResult) {
  pending++;
  setStatus(label + ' …', 'busy');
  return Api.call(action, args, onResult).then(
    res => { pending--; return { res, latest: pending === 0 }; },
    err => { pending--; throw err; }
  );
}

/** `what` names the thing being saved, so a failed add can say which one was lost. */
function fail(err, what) {
  console.error(err);
  if (isAuthError(err)) { setStatus('Not connected', 'err'); openSettings(err.message, 'err'); return; }
  toast(what ? `Could not save "${what}": ${err.message}` : err.message, 'error');
  // Resync so an optimistic change that did not stick disappears; wait until the queue is idle.
  if (pending === 0) { needsResync = false; setStatus('Error', 'err'); load(); }
  else needsResync = true;
}

function load() {
  const label = STATE ? 'Refreshing' : 'Loading';
  return request(label, 'getState')
    .then(({ res, latest }) => {
      if (latest || !STATE) applyState(res);
      else needsResync = true;   // newer local edits are in flight; fetch again once they settle
    })
    .catch(err => {
      if (isAuthError(err)) return fail(err);
      if (STATE) {   // keep showing what we have
        setStatus('Offline — showing saved data', 'err');
        $('statusChip').title = err.message;
      } else {
        setStatus('Could not load — ' + err.message, 'err');
      }
    });
}

function applyState(s, opts) {
  if (!s || !s.goals) return load();
  const cached = !!(opts && opts.cached);
  STATE = s;
  if (!chatReady) { initChat(arr(s.chatHistory)); chatReady = true; }
  try { render(); }
  catch (e) { setStatus('Render error: ' + e.message, 'err'); console.error(e); return; }
  if (cached) return;   // instant paint from the saved copy; the refresh sets the status
  lastLoadAt = Date.now();
  $('statusChip').title = '';
  if (arr(s._errors).length) setStatus('Partial error: ' + s._errors.join(' | '), 'err');
  else setStatus('Ready', 'ok');
  saveCache();
}

/** Everything the server answered is now reflected locally; refresh the chrome and fetch again if we skipped a state. */
function settle() {
  render();
  if (pending > 0) return;
  setStatus('Ready', 'ok');
  saveCache();
  if (needsResync) { needsResync = false; load(); }
}

/**
 * One change: optional instant local edit, then the real request.
 * Small changes come back as small answers (a new item, a streak), which `onOk` folds into STATE.
 * A full state (AI actions, or an older backend) replaces STATE only if it is the newest answer.
 */
function fire(label, action, args, opts) {
  const o = opts || {};
  unsaved++;
  if (o.optimistic && STATE) { o.optimistic(); render(); }
  return request(label, action, args, o.onResult)
    .then(({ res, latest }) => {
      if (res && res.goals) {
        if (o.onOk) o.onOk(res, true);
        if (latest) applyState(res); else needsResync = true;
        return;
      }
      if (o.onOk) o.onOk(res, false);
      settle();
    })
    .catch(err => { if (o.onFail) o.onFail(err); fail(err, o.what); })
    .finally(() => { unsaved--; });
}

// ---- offline copy of the last dashboard ----------------------
// Kept in this browser only, so opening the app paints instantly. Removed on Disconnect.
const CACHE_PREFIX = 'learnerbot.state.v1:';
function cacheKey() {
  const c = Api.getConfig();
  return CACHE_PREFIX + (c.mode === 'demo' ? 'demo' : String(c.url || '').slice(-48));
}
const isTmp = id => String(id).startsWith('tmp_');
function saveCache() {
  if (!STATE || pending > 0) return;
  try {
    const s = { ...STATE,
      goals: STATE.goals.filter(g => !isTmp(g.id)),
      historyGoals: STATE.historyGoals.filter(g => !isTmp(g.id)),
      tasks: STATE.tasks.filter(t => !isTmp(t.id) && !isTmp(t.goalId)) };
    localStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), state: s }));
  } catch (_) { /* storage full or blocked: the app still works, it just opens a little slower */ }
}
function loadCache() {
  try {
    const o = JSON.parse(localStorage.getItem(cacheKey()));
    return o && o.state && Array.isArray(o.state.goals) ? o : null;
  } catch (_) { return null; }
}
function clearCaches() {
  try { Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k)); } catch (_) { /* nothing to clear */ }
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
// ---- instant adds ---------------------------------------------
// A new goal or task appears at once under a temporary id (shown dimmed). The request is
// queued behind earlier ones, and anything that refers to the temporary id (a task on a brand
// new goal, completing it, a sub-goal) looks the real id up when it is actually sent.
const resolveId = id => ID_MAP.get(String(id)) || String(id);
const newTmpId = () => 'tmp_' + (++tmpCounter);
const parseTags = s => String(s || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function swapGoal(tmp, real) {
  if (!real || !real.id) return;
  ID_MAP.set(tmp, String(real.id));
  const swap = x => (x.id === tmp ? { ...real, status: x.status }            // keep edits made while it was pending
    : x.parentId === tmp ? { ...x, parentId: String(real.id) } : x);
  STATE.goals = STATE.goals.map(swap);
  STATE.historyGoals = STATE.historyGoals.map(swap);
  STATE.tasks = STATE.tasks.map(t => (t.goalId === tmp ? { ...t, goalId: String(real.id) } : t));
  ['t:', 's:'].forEach(p => { if (OPEN_DETAILS.delete(p + tmp)) OPEN_DETAILS.add(p + real.id); });
  if (CHILD_FORMS_OPEN.delete(tmp)) CHILD_FORMS_OPEN.add(String(real.id));
}

function swapTask(tmp, real) {
  if (!real || !real.id) return;
  ID_MAP.set(tmp, String(real.id));
  STATE.tasks = STATE.tasks.map(t => (t.id === tmp ? { ...real, status: t.status } : t));
}

function addGoalNow({ title, priority, tags, parentId }) {
  if (!STATE) return;
  const tmp = newTmpId();
  const item = { id: tmp, title: title.slice(0, 200), priority: pri(priority), status: 'active', created: todayStr(),
    tags: parseTags(tags), parentId: parentId ? String(parentId) : '' };
  fire('Saving', 'addGoal',
    () => ({ title, priority: item.priority, tags, parentId: item.parentId ? resolveId(item.parentId) : '' }),
    { optimistic: () => { STATE.goals = [...STATE.goals, item]; },
      onResult: res => { if (res && res.goal && res.goal.id) ID_MAP.set(tmp, String(res.goal.id)); },
      onOk: res => swapGoal(tmp, res && res.goal),
      what: item.title });
}

function addTaskNow(goalId, title) {
  if (!STATE) return;
  const tmp = newTmpId();
  const item = { id: tmp, goalId: String(goalId), title: title.slice(0, 200), status: 'active', created: todayStr() };
  fire('Saving', 'addTask',
    () => ({ goalId: resolveId(goalId), title }),
    { optimistic: () => { STATE.tasks = [...STATE.tasks, item]; },
      onResult: res => { if (res && res.task && res.task.id) ID_MAP.set(tmp, String(res.task.id)); },
      onOk: res => swapTask(tmp, res && res.task),
      what: item.title });
}

const setGoal = (id, status, label) => fire(label, 'setGoalStatus',
  () => ({ id: resolveId(id), status }), { optimistic: () => setGoalLocal(id, status) });
const setTask = (id, status, label) => fire(label, 'setTaskStatus',
  () => ({ id: resolveId(id), status }), { optimistic: () => setTaskLocal(id, status) });

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
    : `<li${isTmp(t.id) ? ' class="pending"' : ''}>${esc(t.title)}<span class="actions"><button class="icon ghost" data-act="completeTask" data-id="${esc(t.id)}" title="Done" aria-label="Mark task done">✓</button><button class="icon ghost" data-act="removeTask" data-id="${esc(t.id)}" title="Remove" aria-label="Remove task">✕</button></span></li>`
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

  return `<li${isTmp(node.id) ? ' class="pending" aria-busy="true"' : ''}>
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
    .then(({ res, latest }) => {
      if (latest) applyState(res); else needsResync = true;   // newer local edits are in flight
      toast(kind === 'weekly' ? 'Weekly review ready.' : 'Daily focus ready.');
    })
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
  toggleToken: () => setTokenVisible($('cfgToken').type === 'password'),
  saveNotify,
  testEmail,
  copyTimings: () => {
    const rows = timingSummary();
    const text = rows.length ? rows.map(timingLine).join('\n') : 'no requests yet';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
      .then(() => toast('Timings copied.'), () => toast('Could not copy. Select the text instead.', 'error'));
  },
  useDemo:    () => { Api.setConfig({ mode: 'demo' }); resetSession(); $('settings').close(); boot(); },
  disconnect: () => { Api.setConfig({}); clearCaches(); resetSession(); $('settings').close(); showConnect(); },
  refresh:    () => { if (Api.isConfigured()) { needsResync = false; load(); } },
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

  // Fields are cleared before the optimistic render, so the re-render does not put the typed text back.
  addGoal: () => {
    const title = val('goalTitle');
    if (!title) return;
    const priority = val('goalPri'), tags = val('goalTags');
    clearFields('goalTitle', 'goalTags');
    addGoalNow({ title, priority, tags });
  },
  addChild: d => {
    const title = val('cgt_' + d.id);
    if (!title) return;
    const priority = val('cgp_' + d.id), tags = val('cgtags_' + d.id);
    CHILD_FORMS_OPEN.delete(d.id);
    OPEN_DETAILS.add('s:' + d.id);
    addGoalNow({ title, priority, tags, parentId: d.id });
  },
  acceptGoal: d => {
    const g = arr(STATE && STATE.weeklyReport && STATE.weeklyReport.data && STATE.weeklyReport.data.plan && STATE.weeklyReport.data.plan.goals)[Number(d.idx)];
    if (g) addGoalNow({ title: String(g.title || ''), priority: g.priority, tags: '' });
  },

  addTask: d => {
    const title = val('ti_' + d.id);
    if (!title) return;
    clearFields('ti_' + d.id);
    OPEN_DETAILS.add('t:' + d.id);
    addTaskNow(d.id, title);
  },
  completeTask: d => setTask(d.id, 'done', 'Saving'),
  reopenTask:   d => setTask(d.id, 'active', 'Saving'),
  removeTask:   d => setTask(d.id, 'removed', 'Saving'),

  logActivity: () => {
    const text = val('logText'), tags = val('logTags');
    if (!text) return;
    clearFields('logText', 'logTags');
    fire('Saving', 'logActivity', { text, tags }, {
      onOk: res => {
        if (res && res.streak != null && STATE) { STATE.streak = res.streak; updateStreak(res.streak); }
        toast('Logged.');
      },
      onFail: () => {   // put the text back so nothing typed is lost
        if ($('logText') && !$('logText').value) $('logText').value = text;
        if ($('logTags') && !$('logTags').value) $('logTags').value = tags;
      },
      what: text.length > 40 ? text.slice(0, 40) + '…' : text
    });
  },
  sendFeedback: () => {
    const text = val('fbText');
    if (!text) return;
    clearFields('fbText');
    fire('Saving', 'submitFeedback', { text }, {
      optimistic: () => { STATE.recentFeedback = [...arr(STATE.recentFeedback), { date: todayStr(), text }].slice(-3); },
      onOk: () => toast('Feedback saved.'),
      onFail: () => { if ($('fbText') && !$('fbText').value) $('fbText').value = text; },
      what: text.length > 40 ? text.slice(0, 40) + '…' : text
    });
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
// "total" is what you wait; "server" is how long the script itself ran (the rest is network and Google's
// hand-off), and the breakdown shows where the script spent it: open (spreadsheet), tab, read, write, lock.
function timingSummary() {
  const by = {};
  Api.timings().forEach(r => { (by[r.action] = by[r.action] || []).push(r); });
  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  return Object.entries(by).map(([action, list]) => {
    const servers = list.filter(r => r.server && typeof r.server.total === 'number').map(r => r.server.total);
    const last = list[list.length - 1];
    return { action, median: median(list.map(r => r.ms)), last: last.ms, count: list.length,
      serverMedian: servers.length ? median(servers) : null, detail: last.server || null };
  });
}

function timingLine(r) {
  const detail = r.detail
    ? ' (' + Object.entries(r.detail).filter(([k]) => k !== 'total').map(([k, v]) => `${k} ${v}`).join(', ') + ')'
    : '';
  return `${r.action}: total median ${r.median} ms, last ${r.last} ms; server median ${r.serverMedian == null ? '–' : r.serverMedian + ' ms'}${detail}; ${r.count}x`;
}

function renderTimings() {
  const rows = timingSummary();
  $('timingsList').innerHTML = rows.length
    ? rows.map(r => `<div>${esc(timingLine(r))}</div>`).join('')
    : 'Nothing yet. Use the app, then look again.';
}

// ---- email updates -------------------------------------------
const NOTIFY_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NOTIFY_OFF = { daily: { enabled: false, hour: 7 }, weekly: { enabled: false, day: 0, hour: 18 }, nudge: { enabled: false, hour: 20 } };
const hourLabel = h => (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM');

function notifyMsg(text, kind) {
  const p = $('notifyMsg');
  p.textContent = text || '';
  p.className = 'cfg-msg' + (kind ? ' ' + kind : '');
}

function fillSelect(id, labels, value) {
  const el = $(id);
  if (!el.options.length) labels.forEach((t, i) => el.add(new Option(t, String(i))));
  el.value = String(value);
}

function renderNotifyForm() {
  const n = (STATE && STATE.notify) || NOTIFY_OFF;
  const hours = Array.from({ length: 24 }, (_, h) => hourLabel(h));
  $('nDailyOn').checked = !!n.daily.enabled;   fillSelect('nDailyHour', hours, n.daily.hour);
  $('nWeeklyOn').checked = !!n.weekly.enabled; fillSelect('nWeeklyDay', NOTIFY_DAYS, n.weekly.day); fillSelect('nWeeklyHour', hours, n.weekly.hour);
  $('nNudgeOn').checked = !!n.nudge.enabled;   fillSelect('nNudgeHour', hours, n.nudge.hour);
  $('notifyIntro').textContent = Api.isDemo()
    ? 'Demo mode never sends email. Try the screen; nothing is scheduled.'
    : (STATE && STATE.notify && STATE.notify.email)
      ? `Sent to ${n.email}, in time zone ${n.tz}, within about 15 minutes of the hour you pick. Nothing is sent unless you switch it on.`
      : 'Connect first, then you can choose when to get updates.';
  notifyMsg('');
}

function readNotifyForm() {
  return {
    daily:  { enabled: $('nDailyOn').checked,  hour: Number($('nDailyHour').value) },
    weekly: { enabled: $('nWeeklyOn').checked, day: Number($('nWeeklyDay').value), hour: Number($('nWeeklyHour').value) },
    nudge:  { enabled: $('nNudgeOn').checked,  hour: Number($('nNudgeHour').value) },
    siteUrl: location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '')   // lets the emails link back here
  };
}

function describeNotify(n) {
  const parts = [];
  if (n.daily.enabled) parts.push(`daily focus around ${hourLabel(n.daily.hour)}`);
  if (n.weekly.enabled) parts.push(`weekly review on ${NOTIFY_DAYS[n.weekly.day]}s around ${hourLabel(n.weekly.hour)}`);
  if (n.nudge.enabled) parts.push(`an evening nudge around ${hourLabel(n.nudge.hour)} if nothing is logged`);
  return parts.length ? 'Saved. You will get: ' + parts.join('; ') + '.' : 'Saved. No emails will be sent.';
}

/** Settings go through the same one-at-a-time queue as everything else. */
function notifyRequest(label, action, args, onDone) {
  if (!Api.isConfigured()) return notifyMsg('Connect first (the fields above).', 'err');
  notifyMsg(label + '…');
  request(label, action, args)
    .then(({ res }) => { onDone(res); if (pending === 0) setStatus('Ready', 'ok'); })
    .catch(err => {
      notifyMsg(err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok');
    });
}

function saveNotify() {
  notifyRequest('Saving', 'saveNotifications', readNotifyForm(), res => {
    if (STATE && res && res.notify) { STATE.notify = res.notify; saveCache(); }
    notifyMsg(describeNotify((res && res.notify) || readNotifyForm()), 'good');
  });
}

function testEmail() {
  notifyRequest('Sending', 'sendTestEmail', {}, res => {
    notifyMsg(res && res.demo ? 'Demo mode: no email is really sent.' : `Sent to ${res.to}. Check your inbox (and the spam folder).`, 'good');
  });
}

function openSettings(message, kind) {
  renderNotifyForm();
  renderTimings();
  const cfg = Api.getConfig();
  $('cfgUrl').value = cfg.url || '';
  $('cfgToken').value = '';
  setTokenVisible(false);
  $('cfgToken').placeholder = cfg.token ? 'Saved for this URL. Leave blank to keep it, or paste a new one' : 'Paste the access token';
  cfgMsg(typeof message === 'string' ? message : '', kind);
  const dlg = $('settings');
  if (!dlg.open) dlg.showModal();
  $('cfgUrl').focus();
}

async function saveSettings() {
  // The deployment dialog shows both a Deployment ID and a Web app URL; accept either.
  const rawUrl = $('cfgUrl').value.trim();
  const url = /^AKfycb[A-Za-z0-9_-]{40,}$/.test(rawUrl) ? 'https://script.google.com/macros/s/' + rawUrl + '/exec' : rawUrl;
  $('cfgUrl').value = url;
  const prev = Api.getConfig();
  const typed = $('cfgToken').value.trim();
  // A saved token belongs to the URL it was saved with; never carry it over to a different backend.
  const sameBackend = prev.mode !== 'demo' && !!prev.url && prev.url === url;
  const token = typed || (sameBackend ? prev.token : '') || '';
  if (!Api.validateUrl(url)) return cfgMsg('That is not a Google Apps Script web app URL. It should start with https://script.google.com/macros/s/ and end with /exec.', 'err');
  if (!token) {
    return cfgMsg(prev.url && !sameBackend
      ? 'This is a different backend from the one saved here, so it needs its own access token. Paste the token from that same sheet\'s LearnerBot → Show connection info window.'
      : 'Paste the access token from the sheet\'s LearnerBot → Show connection info window.', 'err');
  }
  if (typed && !/^[A-Za-z0-9]{32,}$/.test(typed)) {
    return cfgMsg('That doesn\'t look like an access token. It is one long run of letters and numbers (64 of them), shown as the second box in the sheet\'s window, not the URL. If Copy did nothing, click the token box there and press Ctrl+C.', 'err');
  }

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
    let text = e.code === 'unauthorized'
      ? 'That backend answered, but rejected the token. A token only works with its own sheet, so use the token from the same sheet as this URL (LearnerBot → Show connection info). Use Show to check what was pasted.'
      : e.message;
    // Deployed web apps have ids of about 70 characters; a short one usually means the address came from the wrong place.
    const idLen = (url.split('/')[5] || '').length;
    if ((e.code === 'network' || e.code === 'not_json') && idLen > 0 && idLen < 60) {
      text += ` Also, the id in this address is only ${idLen} characters, where a deployed web app normally has about 70, so it is probably the wrong address. Copy the Web app URL from Deploy → Manage deployments in the script editor.`;
    }
    cfgMsg(text, 'err');
  }
}

function setTokenVisible(show) {
  $('cfgToken').type = show ? 'text' : 'password';
  $('tokenToggle').textContent = show ? 'Hide' : 'Show';
}

function resetSession() {
  STATE = null;
  chatReady = false;
  needsResync = false;
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
      if (latest) applyState(res.state); else needsResync = true;   // newer local edits are in flight
    })
    .catch(err => {
      thinking.textContent = 'Error: ' + err.message;
      if (isAuthError(err)) fail(err); else if (pending === 0) { setStatus('Error', 'err'); load(); }
    });
}

// ---- boot ----------------------------------------------------
function boot() {
  updateModeUi();
  const cached = loadCache();
  if (cached) applyState(cached.state, { cached: true });   // paint the last dashboard at once...
  load();                                                   // ...and bring it up to date in the background
}

// Closing the page while a save is still in flight can lose that change: ask first.
window.addEventListener('beforeunload', e => {
  if (unsaved > 0) { e.preventDefault(); e.returnValue = ''; }
});

// Coming back to the tab after a while: quietly refresh (no timers, only on return).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && STATE && Api.isConfigured() && pending === 0 && Date.now() - lastLoadAt > 60000) load();
});

document.addEventListener('DOMContentLoaded', () => {
  $('chatForm').addEventListener('submit', sendChat);
  switchView('dash');
  if (Api.isConfigured()) boot(); else showConnect();
});
