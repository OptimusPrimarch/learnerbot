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
let needsResync = false; // a full-state answer was skipped because newer local edits are in flight
let lastLoadAt = 0;
const ID_MAP = new Map(); // temporary id -> real id, once the server has answered
let EDITING = null;       // id of the goal whose inline editor is open
let forceUpdateNotice = false;   // an action the sheet's script did not recognise: show the update notice even if dismissed
let keyNoticeDismissed = false;  // "no Groq key" reminder hidden for this visit
let fromCache = false;           // STATE is the saved copy, not yet confirmed by the backend
let updating = false;            // "Update now" or "go back" is running
let updateError = '';            // why the last update attempt failed, shown in the banner

// The backend version this copy of the site was written for. A sheet script older than this keeps working for
// everything it already did, but lacks the newer features, so the site says so and points to update.html.
// (tests/backend.test.js fails if this and backend/Code.js drift apart.)
const EXPECTED_BACKEND = '2026.10.14';
const SITE_RELEASE = '1.7';   // the name people see for this version of the site (web/CHANGELOG.md); the script has its own build
const DISMISS_KEY = 'learnerbot.dismissedUpdate';
const CUSTOM_LOOK_BUILD = '2026.10.11';   // the first script build that can save the Custom theme
const VERSION_KEY = 'learnerbot.backendVersion';

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
function tagHue(tag) {
  let h = 0;
  for (const c of String(tag)) h = ((h * 31) + c.charCodeAt(0)) & 0xffff;
  return h % 360;
}
// The colors come from the theme (see .tag in style.css); only the hue is chosen here.
function tagChip(tag) {
  return `<span class="tag" style="--h:${tagHue(tag)}">${esc(tag)}</span>`;
}

/** Dotted versions like 2026.10.7: negative when a is older than b. */
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
// A saved copy from before the version field existed has no version, which must not read as "old backend".
const backendOutdated = () => !!STATE && !fromCache && !Api.isDemo() && cmpVer(STATE.version, EXPECTED_BACKEND) < 0;

/** Whole days from today (this device's calendar) to a yyyy-mm-dd date; negative once it has passed. */
function daysUntil(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const t = new Date();
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
}

/** A small deadline chip: red once overdue, amber in the last few days, quiet otherwise. */
function dueChip(due) {
  const n = daysUntil(due);
  if (n == null) return '';
  const d = new Date(+due.slice(0, 4), +due.slice(5, 7) - 1, +due.slice(8, 10));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const on = d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  let text, cls = '';
  if (n < 0) { text = (-n === 1 ? '1 day' : (-n) + ' days') + ' overdue'; cls = ' over'; }
  else if (n === 0) { text = 'Due today'; cls = ' soon'; }
  else if (n === 1) { text = 'Due tomorrow'; cls = ' soon'; }
  else if (n <= 6) { text = 'Due ' + d.toLocaleDateString([], { weekday: 'short' }); cls = n <= 3 ? ' soon' : ''; }
  else text = 'Due ' + on;
  return `<span class="due${cls}" title="Due ${esc(d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}">${esc(text)}</span>`;
}

function fmtMinutes(m) {
  const n = Math.round(Number(m) || 0);
  if (n <= 0) return '';
  const h = Math.floor(n / 60), r = n % 60;
  return (h ? h + 'h' : '') + (h && r ? ' ' : '') + (r ? r + 'm' : '');
}

// ---- status, toast, undo -------------------------------------
function setStatus(msg, kind) {
  const c = $('statusChip');
  c.className = 'chip' + (kind ? ' ' + kind : '');
  // While changes are waiting to be sent the chip is a button: pressing it tries again now.
  if (kind === 'wait') { c.setAttribute('role', 'button'); c.tabIndex = 0; c.dataset.act = 'sendNow'; }
  else { c.setAttribute('role', 'status'); c.removeAttribute('tabindex'); delete c.dataset.act; }
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

// Complete / postpone / remove can be taken back for a few seconds. Only the latest action is offered,
// and the bar goes away on its own, so it never lingers or stacks up.
const UNDO_MS = 5000;
let undoTimer = null, undoFn = null;
function offerUndo(text, fn) {
  undoFn = fn;
  $('undoText').textContent = text;
  $('undo').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}
function hideUndo() {
  clearTimeout(undoTimer);
  undoFn = null;
  $('undo').hidden = true;
}
const snippet = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function updateStreak(n) {
  const chip = $('streakChip');
  chip.hidden = !(n > 0);
  if (n > 0) { chip.textContent = n + 'd streak'; chip.title = n + ' consecutive days with activity logged'; }
}
function updateWeekChip(mins) {
  const chip = $('weekChip');
  const text = fmtMinutes(mins);
  chip.hidden = !text;
  if (text) { chip.textContent = text + ' this week'; chip.title = 'Time you recorded on log entries over the last 7 days'; }
}
function updateModeUi() { $('demoChip').hidden = !Api.isDemo(); }

// ---- talking to the backend ----------------------------------
const isAuthError = e => ['unauthorized', 'not_configured', 'bad_url'].includes(e && e.code);

function request(label, action, args, onResult, timeoutMs) {
  pending++;
  setStatus(label + ' …', 'busy');
  return Api.call(action, args, onResult, timeoutMs).then(
    res => { pending--; return { res, latest: pending === 0 && !Queue.size() }; },
    err => { pending--; throw err; }
  );
}

/** `what` names the thing being saved, so a failed add can say which one was lost. */
function fail(err, what) {
  console.error(err);
  if (isAuthError(err)) { setStatus('Not connected', 'err'); openSettings(err.message, 'err'); return; }
  if (err && err.code === 'bad_action') { forceUpdateNotice = true; if (STATE) renderNotices(); }   // the sheet's script predates this feature
  toast(what ? `Could not save "${what}": ${err.message}` : err.message, 'error');
  // Resync so an optimistic change that did not stick disappears; wait until the queue is idle.
  if (pending === 0 && !Queue.size()) { needsResync = false; setStatus('Error', 'err'); load(); }
  else needsResync = true;
}

function load() {
  const label = STATE ? 'Refreshing' : 'Loading';
  return request(label, 'getState')
    .then(({ res, latest }) => {
      if (latest || !STATE) applyState(res);
      else needsResync = true;   // newer local edits are in flight or waiting; fetch again once they are sent
      if (Queue.size()) pumpQueue();   // the sheet answered, so anything waiting can go now
    })
    .catch(err => {
      if (isAuthError(err)) return fail(err);
      if (STATE) {   // keep showing what we have
        if (Queue.size()) showWaiting(err);
        else {
          setStatus('Offline — showing saved data', 'err');
          $('statusChip').title = err.message;
        }
      } else {
        setStatus('Could not load — ' + err.message, 'err');
      }
    });
}

function applyState(s, opts) {
  if (!s || !s.goals) return load();
  const cached = !!(opts && opts.cached);
  STATE = s;
  fromCache = cached;
  if (!chatReady) { initChat(arr(s.chatHistory)); chatReady = true; }
  try { render(); }
  catch (e) { setStatus('Render error: ' + e.message, 'err'); console.error(e); return; }
  if (cached) return;   // instant paint from the saved copy; the refresh sets the status
  syncLook(s.appearance);
  if (!Api.isDemo()) { try { localStorage.setItem(VERSION_KEY, String(s.version || '')); } catch (_) { /* informational only */ } }
  lastLoadAt = Date.now();
  $('statusChip').title = '';
  if (arr(s._errors).length) setStatus('Partial error: ' + s._errors.join(' | '), 'err');
  else idleStatus();
  saveCache();
}

/** Everything the server answered is now reflected locally; refresh the chrome and fetch again if we skipped a state. */
function settle() {
  render();
  if (pending > 0) return;
  idleStatus();
  saveCache();
  if (needsResync && !Queue.size()) { needsResync = false; load(); }
}

// ---- changes waiting to be sent -------------------------------
// A change is applied here at once, written to the queue (queue.js) and sent from there in order. Reaching the sheet
// can fail for a while (no signal, a busy sheet); the change then stays queued, shown as "N changes waiting", and is
// sent again when the connection is back. The sheet only ever sees them one at a time, oldest first.
const HOOKS = new Map();                            // ref -> what to do when that change is done (this page only)
const CREATES = new Set(['addGoal', 'addTask', 'logActivity', 'submitFeedback']);   // changes the script can recognise by their ref
const RETRY_CODES = ['network', 'busy', 'not_json'];   // not the change's fault: keep it and try again
const RETRY_MS = [4000, 10000, 30000, 60000, 120000];
const WRITE_TIMEOUT_MS = 45000;
let pumping = false, retryTimer = 0, retryStep = 0, toldOffline = false, waitNote = '';

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** The status chip when nothing is being sent: "Ready", or how many changes are waiting. */
function idleStatus() {
  if (!Queue.size()) setStatus('Ready', 'ok');
  else if (pumping && !offline()) setStatus('Saving …', 'busy');   // the next one is on its way
  else showWaiting();
}
function showWaiting(err) {
  const n = Queue.size();
  if (!n) return;
  if (err) waitNote = err.code === 'network' ? 'Your sheet could not be reached.' : err.message;   // the usual network message talks about setup, which is not the problem here
  setStatus(n + (n === 1 ? ' change' : ' changes') + ' waiting', 'wait');
  $('statusChip').title = 'Kept in this browser and sent in order as soon as your sheet can be reached. Press to try now.' + (waitNote ? ' (' + waitNote + ')' : '');
}

/**
 * One change: optional instant local edit, then it joins the queue and is sent.
 * Small changes come back as small answers (a new item, a streak), which `onOk` folds into STATE.
 * `tmp` is the temporary id of a new goal or task; once the sheet answers, the real one replaces it.
 */
function fire(label, action, args, opts) {
  const o = opts || {};
  if (Queue.size() >= Queue.MAX) {
    toast('Too many changes are waiting to be sent. Reconnect first, then try again.', 'error');
    if (o.onFail) o.onFail(new Error('queue full'));
    return;
  }
  const rec = Queue.add({ ref: o.ref, action, args, what: o.what, label, tmp: o.tmp });
  HOOKS.set(rec.ref, o);
  if (o.optimistic && STATE) { o.optimistic(); render(); }
  saveCache();
  pumpQueue();   // does nothing when it is already sending; a new change is also a good moment to try again
}

/** What is sent for a waiting change: ids that were still temporary when it was made are real by now. */
function queuedArgs(rec) {
  const now = Queue.touch(rec.ref, { tries: (rec.tries || 0) + 1 }) || rec;
  const a = { ...rec.args };
  ['id', 'goalId', 'parentId'].forEach(k => { if (a[k]) a[k] = resolveId(a[k]); });
  if (CREATES.has(rec.action)) {
    a.ref = rec.ref;
    if (now.tries > 1) a.replay = true;   // it may have got there already: the script looks for it before adding it again
  }
  return a;
}

/** Sends waiting changes, oldest first, until one cannot be sent right now. Safe to call at any time. */
async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  clearTimeout(retryTimer);
  retryTimer = 0;
  try {
    for (;;) {
      const rec = Queue.all()[0];
      if (!rec) break;
      if (offline()) { holdOn(new Error('No connection.')); break; }
      if (!(await sendOne(rec))) break;
    }
  } finally { pumping = false; }
  if (!Queue.size()) { retryStep = 0; toldOffline = false; waitNote = ''; }
}

/** The next change cannot be sent right now: keep everything, say so (once), and try again later. */
function holdOn(err) {
  showWaiting(err);
  if (!toldOffline) { toldOffline = true; toast('Not sent yet. It is kept on this device and goes out as soon as your sheet can be reached.'); }
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = 0; pumpQueue(); }, RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)]);
}

/** Sends one change. Answers true when the next one can go, false when sending should stop for now. */
async function sendOne(rec) {
  const hooks = HOOKS.get(rec.ref) || {};
  let out;
  try {
    out = await request(rec.label || 'Saving', rec.action, () => queuedArgs(rec), null, WRITE_TIMEOUT_MS);
  } catch (err) {
    return queuedFailed(rec, hooks, err);
  }
  Queue.remove(rec.ref);
  HOOKS.delete(rec.ref);
  retryStep = 0;
  toldOffline = false;
  const res = out.res;
  if (rec.action === 'addGoal' && rec.tmp) swapGoal(rec.tmp, res && res.goal);
  if (rec.action === 'addTask' && rec.tmp) swapTask(rec.tmp, res && res.task);
  if (hooks.onOk) hooks.onOk(res, !!(res && res.goals));
  if (res && res.goals) {   // a sheet script from before small answers sends the whole state back
    if (!Queue.size() && pending === 0) applyState(res); else needsResync = true;
  } else settle();
  return true;
}

function queuedFailed(rec, hooks, err) {
  if (isAuthError(err)) { showWaiting(err); fail(err); return false; }   // keep everything; the person reconnects, then it goes
  let keep = RETRY_CODES.includes(err && err.code);
  if (!keep && err && err.code === 'error') {   // the sheet failed in a way that may pass (a Google hiccup): a few more tries
    const now = Queue.touch(rec.ref, { fails: (rec.fails || 0) + 1 });
    keep = !!now && now.fails < 3;
  }
  if (keep) { holdOn(err); return false; }
  // The sheet refused this change for good. It goes, with any later change that depended on it.
  Queue.remove(rec.ref);
  HOOKS.delete(rec.ref);
  if (rec.tmp) Queue.dropDependents(rec.tmp).forEach(d => HOOKS.delete(d.ref));
  if (hooks.onFail) hooks.onFail(err);
  fail(err, rec.what);
  return true;
}

// ---- offline copy of the last dashboard ----------------------
// Kept in this browser only, so opening the app paints instantly. Removed on Disconnect.
const CACHE_PREFIX = 'learnerbot.state.v1:';
function cacheKey() {
  const c = Api.getConfig();
  return CACHE_PREFIX + Api.connectionKey();
}
const isTmp = id => String(id).startsWith('tmp_');
function saveCache() {
  if (!STATE) return;
  try {
    // With changes waiting, the dashboard as the person left it (new items included) is what a reload should show.
    const s = Queue.size() ? STATE : { ...STATE,
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
// The sheet lists goals oldest first, which is id order; a goal coming back (undo, reactivate) goes back to its place.
const idOrder = id => { const n = parseInt(id, 10); return isTmp(id) || Number.isNaN(n) ? Infinity : n; };
function placeGoal(list, next, keep) {
  const i = list.findIndex(x => x.id === next.id);
  if (!keep) return i < 0 ? list : list.filter(x => x.id !== next.id);
  if (i < 0) {
    const at = list.findIndex(x => idOrder(x.id) > idOrder(next.id));
    return at < 0 ? [...list, next] : [...list.slice(0, at), next, ...list.slice(at)];
  }
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
const parseTags = s => String(s || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A temporary id becomes the real one: remembered for later changes, and changed in the waiting ones too.
function bindId(tmp, realId) {
  ID_MAP.set(tmp, String(realId));
  Queue.rewrite(tmp, realId);
}

function swapGoal(tmp, real) {
  if (!real || !real.id) return;
  bindId(tmp, real.id);
  if (!STATE) return;
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
  bindId(tmp, real.id);
  if (!STATE) return;
  STATE.tasks = STATE.tasks.map(t => (t.id === tmp ? { ...real, status: t.status } : t));
}

function addGoalNow({ title, priority, tags, parentId, due }) {
  if (!STATE) return;
  const ref = Queue.newRef(), tmp = 'tmp_' + ref;
  const item = { id: tmp, title: title.slice(0, 200), priority: pri(priority), status: 'active', created: todayStr(),
    tags: parseTags(tags), parentId: parentId ? String(parentId) : '', due: due || '' };
  fire('Saving', 'addGoal',
    { title, priority: item.priority, tags, parentId: item.parentId, due: item.due },
    { ref, tmp, optimistic: () => { STATE.goals = [...STATE.goals, item]; }, what: item.title });
}

function addTaskNow(goalId, title) {
  if (!STATE) return;
  const ref = Queue.newRef(), tmp = 'tmp_' + ref;
  const item = { id: tmp, goalId: String(goalId), title: title.slice(0, 200), status: 'active', created: todayStr() };
  fire('Saving', 'addTask',
    { goalId: String(goalId), title },
    { ref, tmp, optimistic: () => { STATE.tasks = [...STATE.tasks, item]; }, what: item.title });
}

const setGoal = (id, status, label) => fire(label, 'setGoalStatus',
  { id: String(id), status }, { optimistic: () => setGoalLocal(id, status) });
const setTask = (id, status, label) => fire(label, 'setTaskStatus',
  { id: String(id), status }, { optimistic: () => setTaskLocal(id, status) });

const findGoal = id => STATE && [...STATE.goals, ...STATE.historyGoals].find(x => x.id === String(id));

/** Change a goal's status and, for a few seconds, offer to take it back. */
function changeGoal(id, status, label, verb) {
  const g = findGoal(id);
  if (!g) return;
  const before = g.status, title = g.title;
  setGoal(id, status, label);
  offerUndo(`${verb} “${snippet(title, 36)}”`, () => setGoal(id, before, 'Undoing'));
}

/** Same for a task; a removed task is put back where it was. */
function changeTask(id, status, label, verb) {
  const i = STATE ? STATE.tasks.findIndex(x => x.id === String(id)) : -1;
  if (i < 0) return;
  const task = { ...STATE.tasks[i] };
  setTask(id, status, label);
  offerUndo(`${verb} “${snippet(task.title, 36)}”`, () => {
    if (!STATE) return;
    if (status === 'removed') {
      const back = { ...task, id: resolveId(task.id) };
      if (!STATE.tasks.some(x => x.id === back.id)) { const at = Math.min(i, STATE.tasks.length); STATE.tasks = [...STATE.tasks.slice(0, at), back, ...STATE.tasks.slice(at)]; }
    }
    setTask(task.id, task.status, 'Undoing');
  });
}

// ---- editing a goal --------------------------------------------
function editGoalLocal(id, f) {
  const patch = x => (x.id === String(id) ? { ...x, ...f } : x);
  STATE.goals = STATE.goals.map(patch);
  STATE.historyGoals = STATE.historyGoals.map(patch);
}

function saveGoalEdit(id) {
  const g = findGoal(id);
  if (!g) { EDITING = null; return render(); }
  const title = $('egt_' + id) ? $('egt_' + id).value.trim() : g.title;
  if (!title) { toast('A goal needs a title.', 'error'); return; }
  const priority = pri($('egp_' + id).value);
  const tags = parseTags($('egtags_' + id).value);
  const due = $('egd_' + id) ? $('egd_' + id).value : g.due;
  const fields = {};
  if (title !== g.title) fields.title = title.slice(0, 200);
  if (priority !== g.priority) fields.priority = priority;
  if (tags.join(',') !== arr(g.tags).join(',')) fields.tags = tags.join(',');
  if ((due || '') !== (g.due || '')) fields.due = due || '';
  EDITING = null;
  if (!Object.keys(fields).length) return render();
  const local = { ...fields };
  if ('tags' in local) local.tags = tags;
  fire('Saving', 'updateGoal', { id: String(id), fields }, {
    optimistic: () => editGoalLocal(id, local),
    onOk: res => {
      // The server normalises (trim, upper-case tags); adopt its text once nothing newer is queued behind this.
      const s = res && res.goal;
      if (s && pending === 0) editGoalLocal(id, { title: s.title, priority: s.priority, tags: s.tags, due: s.due });
    },
    what: snippet(title, 40)
  });
}

// ---- views ---------------------------------------------------
// Each tab is a button and the box it shows.
const VIEWS = { dash: ['navDash', 'mainGrid'], review: ['navReview', 'reviewView'], asst: ['navAsst', 'asstView'], history: ['navHist', 'histView'] };
const VIEW_BOXES = '#mainGrid, #reviewView, #asstView, #histView';

function switchView(v) {
  if (!Object.prototype.hasOwnProperty.call(VIEWS, v)) v = 'dash';
  VIEW = v;
  Object.keys(VIEWS).forEach(k => {
    const [btn, box] = VIEWS[k];
    $(btn).classList.toggle('active', k === v);
    $(btn).setAttribute('aria-current', k === v ? 'page' : 'false');
    $(box).hidden = k !== v;
  });
  if (STATE) render();
  if (v === 'asst') { const log = $('chatLog'); log.scrollTop = log.scrollHeight; }
  window.scrollTo(0, 0);
}

function snapshotInputs() {
  const snap = { values: {}, focus: null };
  document.querySelectorAll(VIEW_BOXES.split(', ').map(b => b + ' input[id], ' + b + ' textarea[id], ' + b + ' select[id]').join(', ')).forEach(el => { snap.values[el.id] = el.value; });
  const a = document.activeElement;
  if (a && a.id && a.closest(VIEW_BOXES)) snap.focus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
  return snap;
}
function restoreInputs(snap) {
  Object.entries(snap.values).forEach(([id, v]) => { const el = $(id); if (el && el.value !== v) el.value = v; });
  if (snap.focus) {
    const el = $(snap.focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch (_) { /* not a text field */ } }
  }
}

/**
 * Banners above the dashboard: an update for the sheet's script (dismissed per site version), and a
 * reminder when no Groq key is saved yet (dismissed for this visit). Both only ever add a nudge.
 */
function renderNotices() {
  const box = $('notices');
  if (!STATE) { box.innerHTML = ''; return; }
  const out = [];
  let dismissed = '';
  try { dismissed = localStorage.getItem(DISMISS_KEY) || ''; } catch (_) { /* no storage: it just shows every visit */ }
  if (backendOutdated() && (forceUpdateNotice || dismissed !== EXPECTED_BACKEND || updating || updateError)) {
    const canUpdate = !!STATE.appInfo && STATE.role !== 'device';   // the loader in the sheet can install it from here
    const action = canUpdate
      ? `<button data-act="updateApp"${updating ? ' disabled' : ''}>${updating ? 'Updating…' : 'Update now'}</button>`
      : `<a class="btn" href="update.html">Update now</a>`;
    out.push(`<div class="notice warn" role="status"><div>
      <b>A newer version of LearnerBot is available for your sheet.</b>
      <div class="muted">${forceUpdateNotice ? 'What you just tried needs it. ' : ''}Your goals, key and settings stay exactly as they are. ${canUpdate ? 'It takes a few seconds.' : STATE.role === 'device' ? 'Update it from your computer.' : 'It takes about two minutes.'}</div>
      ${updateError ? `<div class="cfg-msg err" role="alert">That did not work: ${esc(updateError)} You can also <a href="update.html">update by hand</a>.</div>` : ''}
      <div class="notice-actions">${STATE.role === 'device' ? '' : action}${updating ? '' : '<button class="ghost" data-act="dismissNotice" data-kind="update">Not now</button>'}</div>
    </div></div>`);
  }
  const hk = STATE.housekeeping;
  // On the Dashboard only: the History tab shows its own tidy-up note, so it is not repeated there.
  if (hk && VIEW === 'dash' && hk.reviewDue && hk.reviewCount > 0 && !backendOutdated() && !(typeof reviewNoticeDismissed !== 'undefined' && reviewNoticeDismissed)) {
    out.push(`<div class="notice warn" role="status"><div>
      <b>Time to tidy up.</b>
      <div class="muted">${hk.reviewCount} completed ${hk.reviewCount === 1 ? 'goal is' : 'goals are'} ready to review. Keep the important ones as a record and remove the rest, so your sheet stays light.</div>
      <div class="notice-actions"><button data-act="reviewStart">Review now</button><button class="ghost" data-act="dismissNotice" data-kind="review">Not now</button></div>
    </div></div>`);
  }
  if (STATE.hasKey === false && !Api.isDemo() && !keyNoticeDismissed) {
    out.push(`<div class="notice" role="status"><div>
      <b>Add your Groq key to switch the coach on.</b>
      <div class="muted">The daily focus, weekly review and chat need a free Groq key. On a computer, open your sheet and choose <b>LearnerBot → Set Groq API key</b> (step 3 of the <a href="setup.html">setup guide</a>).</div>
      <div class="notice-actions"><button class="ghost" data-act="dismissNotice" data-kind="key">Not now</button></div>
    </div></div>`);
  }
  box.innerHTML = out.join('');
}

function render() {
  updateStreak(STATE.streak || 0);
  updateWeekChip(STATE.weekMinutes || 0);
  document.body.classList.toggle('legacy', backendOutdated());   // hides controls an older script would silently ignore
  renderNotices();
  const snap = snapshotInputs();
  if (VIEW === 'history') renderHistory(); else if (VIEW === 'review') renderReview(); else if (VIEW === 'asst') renderAsst(); else renderDash();
  restoreInputs(snap);
  syncAiButtons();
}

// The Run buttons live inside their cards, so a re-render must keep them disabled mid-run.
function syncAiButtons() {
  document.querySelectorAll('[data-act="runDaily"], [data-act="runWeekly"]').forEach(b => { b.disabled = aiBusy; });
}

// Dashboard: today's focus, then the log (so adding an entry never means scrolling past every goal), then the goals.
function renderDash() {
  const s = STATE;
  const g = $('mainGrid');
  g.innerHTML = '';
  g.appendChild(focusCard(s.dailyReport));
  g.appendChild(logCard());
  g.appendChild(goalsCard(arr(s.goals), arr(s.tasks)));
}

// Review: the weekly review, the proposed plan and the score history.
function renderReview() {
  const s = STATE;
  const g = $('reviewView');
  g.innerHTML = '';
  g.appendChild(weeklyCard(s.weeklyReport));
  g.appendChild(planCard(s.weeklyReport));
  g.appendChild(scoresCard(arr(s.history)));
}

// Assistant: the chat is fixed markup in the page (so it keeps its text); the Steer card beside it is redrawn.
function renderAsst() {
  const host = $('steerHost');
  host.innerHTML = '';
  host.appendChild(steerCard(arr(STATE.recentFeedback)));
}

function showConnect() {
  switchView('dash');
  $('mainGrid').innerHTML = `<div class="card wide connect">
    <img class="logo-lg" src="logo-128.png" width="88" height="88" alt="">
    <h3>Welcome to LearnerBot</h3>
    <p class="muted">Set goals, log what you did, and get a coach that notices patterns.<br>Your data stays in your own Google Sheet.</p>
    <div class="row">
      <button data-act="settings">Connect your sheet</button>
      <button class="ghost" data-act="useDemo">Try demo data</button>
      <a class="nav-btn" href="setup.html" style="text-decoration:none;padding:8px 14px">Setup guide</a>
    </div>
    <p class="muted" style="margin-top:14px;font-size:13px">On a phone? On your computer open <b>⚙ → Add your phone</b>. It emails you a link: open that email on your phone.</p></div>`;
  setStatus('Not connected', '');
  updateModeUi();
  updateStreak(0);
  updateWeekChip(0);
  $('notices').innerHTML = '';
  hideUndo();
}

// ---- history: goal rows (the History tab itself, with its Goals and Log sections, is in js/history.js) ----
function histSection(title, icon, goals, note) {
  const rows = goals.map(g => `
    <div class="hist-row">
      <span class="pill ${statusClass(g.status)}">${icon} ${esc(g.status)}</span>
      <span class="hist-title">${esc(g.title)}</span>
      ${arr(g.tags).length ? `<span class="tags">${g.tags.map(tagChip).join('')}</span>` : ''}
      <span class="hist-meta">${g.status === 'completed' && g.since ? 'done ' + esc(fmtDate(g.since)) + (g.kept ? ' \u00b7 kept' : '') : 'added ' + esc(fmtDate(g.created))}</span>
      <button class="icon ghost" data-act="reactivate" data-id="${esc(g.id)}" title="Reactivate" aria-label="Reactivate">\u21ba</button>
    </div>`).join('');
  return `<div class="card wide hist-section"><label class="head">${esc(title)}</label>${rows}${note ? `<p class="muted" style="font-size:12px;margin-top:8px">${esc(note)}</p>` : ''}</div>`;
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

  const d = div('card wide goals-card');
  let html = `<label class="head">Active Goals</label>`;

  if (topTags.length) {
    const chips = topTags.map(t => {
      const outline = TAG_FILTER === t ? ';outline:2px solid hsl(var(--h),70%,var(--tag-fg-l));outline-offset:1px' : '';
      return `<span class="tag" role="button" tabindex="0" style="--h:${tagHue(t)};cursor:pointer${outline}" data-act="filterTag" data-tag="${esc(t)}">${esc(t)}</span>`;
    }).join('');
    html += `<div class="tags" style="margin-bottom:10px">${chips}${TAG_FILTER ? `&nbsp;<button class="ghost icon" data-act="filterTag" data-tag="" style="font-size:11px;padding:2px 8px">✕ clear</button>` : ''}</div>`;
  }

  if (roots.length) html += `<ul class="plain">${roots.map(n => renderGoalNode(n, tasksMap)).join('')}</ul>`;
  else if (active.length && TAG_FILTER) html += `<p class="empty">No goals match <strong>${esc(TAG_FILTER)}</strong>.</p>`;
  else html += `<p class="empty">No active goals yet.</p>`;

  html += `
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <label class="head" style="margin-bottom:6px" for="goalTitle">Add Goal</label>
      <div class="add-goal">
        <input id="goalTitle" class="g-title" type="text" placeholder="Goal title…" data-enter="addGoal" maxlength="200">
        <select id="goalPri" aria-label="Priority">
          <option value="high">High</option>
          <option value="medium" selected>Med</option>
          <option value="low">Low</option>
        </select>
        <input id="goalTags" class="g-tags" type="text" placeholder="Tags: WORK, AI (optional)" data-enter="addGoal" aria-label="Tags">
        <label class="due-field needs-new">Due <input id="goalDue" type="date" aria-label="Due date (optional)" data-enter="addGoal"></label>
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

  // The deadline chip rides with the tags, so on a phone it sits on the tags line under the title.
  const meta = [dueChip(node.due), ...arr(node.tags).map(tagChip)].join('');
  const isNew = isTmp(node.id);

  const editor = EDITING === node.id && !isNew ? `
    <div class="edit-form">
      <input id="egt_${id}" type="text" value="${esc(node.title)}" maxlength="200" data-enter="saveGoal" data-id="${id}" aria-label="Goal title">
      <div class="row">
        <select id="egp_${id}" style="width:auto" aria-label="Priority">${PRIORITIES.map(p => `<option value="${p}"${pri(node.priority) === p ? ' selected' : ''}>${p === 'medium' ? 'Med' : p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>
        <input id="egtags_${id}" type="text" value="${esc(arr(node.tags).join(', '))}" placeholder="Tags: WORK, AI (optional)" data-enter="saveGoal" data-id="${id}" aria-label="Tags">
      </div>
      <div class="row">
        <label class="due-field needs-new">Due <input id="egd_${id}" type="date" value="${esc(node.due || '')}" aria-label="Due date (optional)" data-enter="saveGoal" data-id="${id}"></label>
        <button type="button" class="ghost needs-new" data-act="clearDue" data-id="${id}">No deadline</button>
      </div>
      <div class="row"><button data-act="saveGoal" data-id="${id}">Save</button><button class="ghost" data-act="cancelEdit">Cancel</button></div>
    </div>` : '';

  const goalRow = editor || `
    <div class="goal-row">
      <span class="goal-left">
        <span class="pill ${pri(node.priority)}">${pri(node.priority)}</span>
        <span class="goal-title" title="${esc(node.title)}">${esc(node.title)}</span>
        ${meta ? `<span class="tags">${meta}</span>` : ''}
      </span>
      <span class="actions">
        <button class="icon ghost" data-act="toggleChildForm" data-id="${id}" title="Add sub-goal" aria-label="Add sub-goal">⊕</button>
        ${isNew ? '' : `<button class="icon ghost needs-new" data-act="editGoal" data-id="${id}" title="Edit" aria-label="Edit goal">✎</button>`}
        <button class="icon ghost" data-act="complete" data-id="${id}" title="Complete" aria-label="Complete goal">✓</button>
        <button class="icon ghost" data-act="postpone" data-id="${id}" title="Postpone" aria-label="Postpone goal">⏸</button>
        <button class="icon ghost" data-act="remove" data-id="${id}" title="Remove" aria-label="Remove goal">✕</button>
      </span>
    </div>`;

  return `<li${isNew ? ' class="pending" aria-busy="true"' : ''}>
    ${goalRow}
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

// The proposed plan can be edited in place; PLAN_EDIT is the draft while the editor is open.
let PLAN_EDIT = null;
let planKey = 0;
const planDraftGoal = g => ({ key: ++planKey, title: g.title || '', priority: pri(g.priority), rationale: g.rationale || '' });

function planCard(rep) {
  const d = div('card');
  let html = `<div class="card-head"><label class="head">Proposed Plan</label>${rep && rep.data && rep.data.plan && !PLAN_EDIT ? '<button class="ghost run needs-new" data-act="planEdit">Edit</button>' : ''}</div>`;
  if (PLAN_EDIT) {
    const e = PLAN_EDIT;
    html += `<div class="plan-edit">
      <label class="head">Suggested goals</label>
      ${e.goals.map(g => `<div class="pe-goal">
        <input id="pgt_${g.key}" type="text" value="${esc(g.title)}" maxlength="200" placeholder="Goal title" aria-label="Goal title">
        <div class="row">
          <select id="pgp_${g.key}" style="width:auto" aria-label="Priority">${PRIORITIES.map(p => `<option value="${p}"${pri(g.priority) === p ? ' selected' : ''}>${p === 'medium' ? 'Med' : p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>
          <input id="pgr_${g.key}" type="text" value="${esc(g.rationale || '')}" maxlength="300" placeholder="Why (optional)" aria-label="Why">
          <button type="button" class="icon ghost" data-act="planDrop" data-key="${g.key}" title="Remove this suggestion" aria-label="Remove this suggestion">\u2715</button>
        </div></div>`).join('')}
      ${e.goals.length < 10 ? '<div class="row"><button type="button" class="ghost" data-act="planAddGoal">+ Add a goal</button></div>' : ''}
      <label class="head" for="ppText" style="margin-top:12px">Priorities (one per line)</label>
      <textarea id="ppText" rows="4" placeholder="One priority per line">${esc(e.priorities)}</textarea>
      <label class="head" for="pfText" style="margin-top:12px">Focus areas (separated by commas)</label>
      <input id="pfText" type="text" value="${esc(e.focus)}" placeholder="e.g. Consistency, Deep work">
      <div class="row"><button data-act="planSave">Save plan</button><button class="ghost" data-act="planCancel">Cancel</button></div>
    </div>`;
  } else if (rep && rep.data && rep.data.plan) {
    const p = rep.data.plan;
    if (arr(p.focus_areas).length)
      html += `<p class="muted" style="margin-bottom:10px;font-size:13px">Focus: ${p.focus_areas.map(esc).join(' \u00b7 ')}</p>`;
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
    if (p.edited) html += `<p class="ts">Edited ${esc(fmtDate(p.edited))}</p>`;
  } else {
    html += `<p class="empty">Run a weekly review to get a proposed plan.</p>`;
  }
  d.innerHTML = html;
  return d;
}

/** Copies what is typed in the plan editor into the draft, so adding or removing a line never loses text. */
function readPlanDraft() {
  if (!PLAN_EDIT || !$('ppText')) return;
  PLAN_EDIT.goals = PLAN_EDIT.goals.map(g => ({
    key: g.key,
    title: $('pgt_' + g.key) ? $('pgt_' + g.key).value : g.title,
    priority: $('pgp_' + g.key) ? $('pgp_' + g.key).value : g.priority,
    rationale: $('pgr_' + g.key) ? $('pgr_' + g.key).value : g.rationale
  }));
  PLAN_EDIT.priorities = $('ppText').value;
  PLAN_EDIT.focus = $('pfText').value;
}

function planSaveNow() {
  readPlanDraft();
  const e = PLAN_EDIT;
  if (!e) return;
  if (e.goals.some(g => !g.title.trim())) { toast('Every suggested goal needs a title (or remove it).', 'error'); return; }
  const plan = {
    goals: e.goals.map(g => ({ title: g.title.trim(), priority: pri(g.priority), rationale: g.rationale.trim() })),
    priorities: e.priorities.split('\n').map(x => x.trim()).filter(Boolean),
    focus_areas: e.focus.split(',').map(x => x.trim()).filter(Boolean)
  };
  request('Saving the plan', 'updatePlan', { plan })
    .then(({ res }) => {
      if (STATE && res && res.report) { STATE.weeklyReport = res.report; saveCache(); }
      PLAN_EDIT = null;
      toast('Plan saved.');
      if (STATE) render();
    })
    .catch(err => { toast(err.message, 'error'); if (isAuthError(err)) fail(err); })
    .finally(() => { if (pending === 0) setStatus('Ready', 'ok'); });
}

// Time on a log entry is optional and in quarter-hours (blank = not recorded), up to eight hours.
const MINUTE_STEPS = Array.from({ length: 32 }, (_, i) => (i + 1) * 15);

function logCard() {
  const d = div('card wide');
  d.innerHTML = `
    <label class="head" for="logText">Log Activity</label>
    <p class="muted" style="font-size:13px;margin-bottom:8px">What happened this week? Feeds your next weekly review.</p>
    <div class="log-form">
      <textarea id="logText" placeholder="e.g. Shipped the auth refactor; studied system design." maxlength="2000"></textarea>
      <div class="log-side">
        <input id="logTags" type="text" placeholder="Tags: WORK, AI (optional)" aria-label="Tags">
        <div class="row">
          <select id="logMins" class="needs-new" aria-label="Time spent (optional)">
            <option value="">Time (optional)</option>${MINUTE_STEPS.map(m => `<option value="${m}">${fmtMinutes(m)}</option>`).join('')}
          </select>
          <button data-act="logActivity">Log it</button>
        </div>
      </div>
    </div>`;
  return d;
}

function steerCard(feedback) {
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
  d.innerHTML = html;
  return d;
}

function scoresCard(history) {
  const d = div('card wide');
  let html = '<label class="head">Weekly scores</label>';
  if (history.length) {
    const bars = history.map(h => {
      const score = Number(h.score) || 0;
      return `<div class="bar" style="height:${Math.max(0, Math.min(10, score)) * 8 + 4}px" title="Week of ${esc(h.week)}: ${esc(h.score)}/10"><span>${h.score == null ? '–' : esc(h.score)}</span></div>`;
    }).join('');
    html += `<div class="bars">${bars}</div>`;
  } else {
    html += '<p class="empty">Scores appear here after your first weekly review.</p>';
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
  lookTheme:  d => setLook({ theme: d.v }),
  lookAccent: d => setLook({ accent: d.v }),
  lookSize:   d => setLook({ size: d.v }),
  lookPrimary: d => setLook({ theme: 'custom', primary: d.v }),
  lookScheme: d => { const x = Look.SCHEMES[Number(d.v)]; if (x) setLook({ theme: 'custom', primary: x.primary, accent: x.accent }); },
  lookReset:  () => setLook({ theme: 'dark', primary: '', accent: '', font: 'system', size: 'medium' }),
  myVoice: d => {
    const v = arr(STATE && STATE.myVoices).find(x => x.id === d.id);
    if (v) { $('voiceText').value = v.text; $('voiceName').value = v.name; updateVoiceCount(); voiceMsg('Filled in. Edit it if you like, then press Save voice to use it.'); }
  },
  saveMyVoice: () => saveMyVoice(),
  removeMyVoice: d => {
    const v = arr(STATE && STATE.myVoices).find(x => x.id === d.id);
    if (v && confirm('Remove “' + v.name + '” from your saved voices? Your coach keeps using the voice it has now.')) removeMyVoice(v.id);
  },
  voicePreset: d => { const v = Voices.byId[d.preset]; if (v) { $('voiceText').value = v.text; updateVoiceCount(); voiceMsg('Filled in. Edit it if you like, then press Save voice.'); } },
  saveVoice:   () => saveVoice($('voiceText').value),
  clearVoice:  () => { $('voiceText').value = ''; saveVoice(''); },
  sendPhoneLink,
  loadDevices,
  revokeDevice: d => { if (confirm('Disconnect this phone? It stops working immediately.')) revokeDevice(d.id); },
  revokeAll: () => { if (confirm('Disconnect every phone? They all stop working immediately.')) revokeAll(); },
  copyTimings: () => {
    const rows = timingSummary();
    const text = rows.length ? rows.map(timingLine).join('\n') : 'no requests yet';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
      .then(() => toast('Timings copied.'), () => toast('Could not copy. Select the text instead.', 'error'));
  },
  useDemo:    () => { Api.setConfig({ mode: 'demo' }); resetSession(); $('settings').close(); boot(); },
  sendNow:    () => { retryStep = 0; if (offline()) toast('Still offline. Your changes are kept on this device.'); pumpQueue(); },
  disconnect: () => {
    const n = Queue.size();
    if (n && !confirm(n + (n === 1 ? ' change has' : ' changes have') + ' not reached your sheet yet. If you disconnect now ' + (n === 1 ? 'it is' : 'they are') + ' thrown away. Disconnect anyway?')) return;
    Queue.clear(); HOOKS.clear();
    Api.setConfig({}); clearCaches(); resetSession(); $('settings').close(); showConnect();
  },
  refresh:    () => { if (Api.isConfigured()) { needsResync = false; load(); if (typeof invalidateLog === 'function') invalidateLog(); } },

  filterTag:  d => { TAG_FILTER = d.tag && TAG_FILTER !== d.tag ? d.tag : null; if (STATE) render(); },
  toggleChildForm: d => {
    if (CHILD_FORMS_OPEN.has(d.id)) CHILD_FORMS_OPEN.delete(d.id); else CHILD_FORMS_OPEN.add(d.id);
    if (STATE) render();
  },

  // Each of these can be taken back from the bar that appears for a few seconds, so none asks first.
  complete:   d => changeGoal(d.id, 'completed', 'Completing', 'Completed'),
  postpone:   d => changeGoal(d.id, 'postponed', 'Postponing', 'Postponed'),
  reactivate: d => setGoal(d.id, 'active', 'Reactivating'),
  remove:     d => changeGoal(d.id, 'archived', 'Removing', 'Removed'),
  undo:       () => { const fn = undoFn; hideUndo(); if (fn) fn(); },

  editGoal:   d => { EDITING = d.id; if (STATE) render(); const t = $('egt_' + d.id); if (t) { t.focus(); t.select(); } },
  cancelEdit: () => { EDITING = null; if (typeof LOG_EDITING !== 'undefined') LOG_EDITING = null; if (STATE) render(); },
  saveGoal:   d => saveGoalEdit(d.id),
  clearDue:   d => { const el = $('egd_' + d.id); if (el) el.value = ''; },
  updateApp:    () => runUpdate('update'),
  rollbackApp:  () => { if (confirm('Go back to the earlier version of the script? Your goals and settings are not touched.')) runUpdate('rollback'); },
  dismissNotice: d => {
    if (d.kind === 'key') keyNoticeDismissed = true;
    else if (d.kind === 'review') reviewNoticeDismissed = true;
    else { forceUpdateNotice = false; try { localStorage.setItem(DISMISS_KEY, EXPECTED_BACKEND); } catch (_) { /* shows again next visit */ } }
    renderNotices();
  },

  // Fields are cleared before the optimistic render, so the re-render does not put the typed text back.
  addGoal: () => {
    const title = val('goalTitle');
    if (!title) return;
    const priority = val('goalPri'), tags = val('goalTags'), due = val('goalDue');
    clearFields('goalTitle', 'goalTags', 'goalDue');
    addGoalNow({ title, priority, tags, due });
  },
  addChild: d => {
    const title = val('cgt_' + d.id);
    if (!title) return;
    const priority = val('cgp_' + d.id), tags = val('cgtags_' + d.id);
    CHILD_FORMS_OPEN.delete(d.id);
    OPEN_DETAILS.add('s:' + d.id);
    addGoalNow({ title, priority, tags, parentId: d.id });
  },
  planEdit: () => {
    const p = STATE && STATE.weeklyReport && STATE.weeklyReport.data && STATE.weeklyReport.data.plan;
    if (!p) return;
    PLAN_EDIT = { goals: arr(p.goals).map(planDraftGoal), priorities: arr(p.priorities).join('\n'), focus: arr(p.focus_areas).join(', ') };
    render();
    if (PLAN_EDIT.goals[0] && $('pgt_' + PLAN_EDIT.goals[0].key)) $('pgt_' + PLAN_EDIT.goals[0].key).focus();
  },
  planAddGoal: () => { readPlanDraft(); if (PLAN_EDIT && PLAN_EDIT.goals.length < 10) { const g = planDraftGoal({}); PLAN_EDIT.goals.push(g); render(); const t = $('pgt_' + g.key); if (t) t.focus(); } },
  planDrop: d => { readPlanDraft(); if (PLAN_EDIT) { PLAN_EDIT.goals = PLAN_EDIT.goals.filter(g => String(g.key) !== String(d.key)); render(); } },
  planSave: () => planSaveNow(),
  planCancel: () => { PLAN_EDIT = null; if (STATE) render(); },
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
  completeTask: d => changeTask(d.id, 'done', 'Saving', 'Task done'),
  reopenTask:   d => setTask(d.id, 'active', 'Saving'),
  removeTask:   d => changeTask(d.id, 'removed', 'Saving', 'Removed task'),

  logActivity: () => {
    const text = val('logText'), tags = val('logTags');
    if (!text) return;
    const minutes = Number(val('logMins')) || 0;
    clearFields('logText', 'logTags', 'logMins');
    const args = { text, tags };
    if (minutes) args.minutes = minutes;
    fire('Saving', 'logActivity', args, {
      optimistic: () => { if (minutes) STATE.weekMinutes = (STATE.weekMinutes || 0) + minutes; },
      onOk: res => {
        if (res && res.streak != null && STATE) { STATE.streak = res.streak; updateStreak(res.streak); }
        if (res && res.weekMinutes != null && STATE) { STATE.weekMinutes = res.weekMinutes; updateWeekChip(res.weekMinutes); }
        if (res && res.entry && typeof logAdded === 'function') logAdded(res.entry);
        toast(minutes ? 'Logged ' + fmtMinutes(minutes) + '.' : 'Logged.');
      },
      onFail: () => {   // put the text back so nothing typed is lost
        if (minutes && STATE) STATE.weekMinutes = Math.max(0, (STATE.weekMinutes || 0) - minutes);
        if ($('logText') && !$('logText').value) $('logText').value = text;
        if ($('logTags') && !$('logTags').value) $('logTags').value = tags;
        if (minutes && $('logMins') && !$('logMins').value) $('logMins').value = String(minutes);
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
  } else if (e.key === 'Escape' && e.target.closest && e.target.closest('.edit-form')) {
    e.preventDefault();
    HANDLERS.cancelEdit();
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

// ---- look: theme, accent, font, size ------------------------------
// js/look.js applies and caches the look on this device. Theme, accent and font are also saved in the sheet so
// every device matches; size stays on the device. The sheet's copy wins when the page loads, unless a change made
// here has not reached the sheet yet.
let lookTimer = null;
const lookMsg = (t, k) => paneMsg('lookMsg', t, k);
const lookKnown = () => !!STATE && 'appearance' in STATE;   // a script that predates the look feature does not send the field

function buildLookForm() {
  const pill = (act, v, label) => `<button type="button" class="ghost run" data-act="${act}" data-v="${esc(v)}" aria-pressed="false">${esc(label)}</button>`;
  $('lookTheme').innerHTML = Object.keys(Look.THEMES).map(k => pill('lookTheme', k, Look.THEMES[k].label)).join('');
  $('lookScheme').innerHTML = Look.SCHEMES.map((x, i) => `<button type="button" class="ghost run scheme" data-act="lookScheme" data-v="${i}" aria-pressed="false"><span class="dots"><i style="background:${x.primary}"></i><i style="background:${x.accent}"></i></span>${esc(x.label)}</button>`).join('');
  const psw = (v, label) => `<button type="button" class="swatch" data-act="lookPrimary" data-v="${esc(v)}" style="--sw:${esc(v)}" aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="false"></button>`;
  $('lookPrimary').innerHTML = Look.PRIMARIES.map(p => psw(p.color, p.label)).join('') + '<input type="color" id="lookPrimaryCustom" aria-label="Custom primary color" title="Pick any color">';
  $('lookSize').innerHTML = Object.keys(Look.SIZES).map(k => pill('lookSize', k, Look.SIZES[k].label)).join('');
  $('lookFont').innerHTML = Object.keys(Look.FONTS).map(k => `<option value="${k}" style="font-family:${esc(Look.FONTS[k].stack)}">${esc(Look.FONTS[k].label)}</option>`).join('');
  const sw = (v, label, auto) => `<button type="button" class="swatch${auto ? ' auto' : ''}" data-act="lookAccent" data-v="${esc(v)}" aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="false"></button>`;
  $('lookAccent').innerHTML = sw('', 'Theme default', true) + Look.SWATCHES.map(s => sw(s.color, s.label, false)).join('') +
    '<input type="color" id="lookCustom" aria-label="Custom accent color" title="Pick any color">';
}

/** Shows which choices are active, and the swatches in the colors they will really have on this theme. */
function syncLookForm() {
  const look = Look.get(), pal = Look.palette(look), custom = look.theme === 'custom';
  document.querySelectorAll('#lookTheme button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === look.theme)));
  document.querySelectorAll('#lookSize button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === look.size)));
  document.querySelectorAll('#lookScheme button').forEach(b => {
    const x = Look.SCHEMES[Number(b.dataset.v)];
    b.setAttribute('aria-pressed', String(custom && look.primary === x.primary && look.accent === x.accent));
  });
  $('lookPrimaryGroup').hidden = !custom;
  document.querySelectorAll('#lookPrimary .swatch').forEach(b => b.setAttribute('aria-pressed', String(look.primary === b.dataset.v)));
  $('lookAccentLabel').textContent = custom ? 'Secondary color (buttons and highlights)' : 'Accent color';
  document.querySelectorAll('#lookAccent .swatch').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.v === look.accent));
    if (b.dataset.v) b.style.setProperty('--sw', Look.fitAccent(b.dataset.v, pal).color);
  });
  $('lookFont').value = look.font;
  const accentIn = $('lookCustom'), primaryIn = $('lookPrimaryCustom');
  if (accentIn && document.activeElement !== accentIn) accentIn.value = Look.fitAccent(look.accent || pal.accent, pal).color;
  if (primaryIn && document.activeElement !== primaryIn) primaryIn.value = look.primary || Look.DEFAULT_PRIMARY;
}

function setLook(part) {
  const before = Look.get();
  const next = Look.set(part);
  syncLookForm();
  const synced = Look.SYNCED.some(k => before[k] !== next[k]);
  if (!synced) { lookMsg('Text size is kept on this device.'); return; }
  lookMsg(Api.isConfigured() ? 'Saving…' : 'Saved on this device.');
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => pushLook(), 700);
}

/** Saves the look in the sheet. `force` sends it even when nothing changed here (the first save from a device that already had a look). */
function pushLook(force) {
  const look = Look.get();
  if (!look.dirty && !force) return;
  if (!Api.isConfigured()) { lookMsg('Saved on this device.', 'good'); return; }
  if (look.theme === 'custom' && STATE && !Api.isDemo() && cmpVer(STATE.version, CUSTOM_LOOK_BUILD) < 0) {
    lookMsg('Saved on this device. Update your sheet\'s script to keep custom colors with your sheet.', 'err');
    return;
  }
  const sent = Look.payload(look);
  request('Saving', 'saveAppearance', sent)
    .then(({ res }) => {
      if (STATE) { STATE.appearance = (res && res.appearance) || sent; saveCache(); }
      // A newer change may have been made while this was in flight; only clear the flag if nothing changed.
      if (JSON.stringify(Look.payload(Look.get())) === JSON.stringify(sent)) Look.markSaved(); else pushLook();
      lookMsg('Saved in your sheet, so your other devices will match.', 'good');
      if (pending === 0) setStatus('Ready', 'ok');
    })
    .catch(err => {
      if (err.code === 'bad_action') lookMsg("Saved on this device. Your sheet's script needs the update before it can keep your look for you.", 'err');
      else lookMsg('Saved on this device; it will be saved in your sheet next time. (' + err.message + ')', 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok');
    });
}

/** When the page loads from the sheet: take the sheet's look, or send this device's look if the sheet has none yet. */
function syncLook(saved) {
  const local = Look.get();
  if (saved && !local.dirty) { Look.adopt(saved); syncLookForm(); return; }
  if (local.dirty || (!saved && !Look.isDefault(local))) { if (lookKnown()) pushLook(true); }
}

// ---- coach voice ---------------------------------------------
// The user's own words, stored exactly as typed and handed to the coach as instructions on how to sound.
// The ready-made voices only fill the box; nothing is saved until Save, and the text stays editable.
const VOICE_MAX = Voices.MAX;

/** The ready-made voices (js/voices.js) as grouped buttons. */
function buildVoiceForm() {
  $('voicePresets').innerHTML = Voices.GROUPS.map(g => `<div class="vgroup"><span class="vlabel">${esc(g.label)}</span><div class="presets">${
    g.voices.map(v => `<button type="button" class="ghost run" data-act="voicePreset" data-preset="${esc(v.id)}">${esc(v.label)}</button>`).join('')}</div></div>`).join('');
}
const voiceMsg = (t, k) => paneMsg('voiceMsg', t, k);

/** The voices the person kept (saved in the sheet): a button that loads each into the box, and a small one that removes it. */
function renderMyVoices() {
  const list = arr(STATE && STATE.myVoices);
  $('myVoices').innerHTML = '<span class="vlabel">My voices</span>' + (list.length
    ? `<div class="presets">${list.map(v => `<span class="myv"><button type="button" class="ghost run" data-act="myVoice" data-id="${esc(v.id)}" title="${esc(snippet(v.text, 140))}">${esc(v.name)}</button><button type="button" class="ghost icon" data-act="removeMyVoice" data-id="${esc(v.id)}" aria-label="Remove ${esc(v.name)}" title="Remove">✕</button></span>`).join('')}</div>`
    : '<p class="muted" style="font-size:12px">Nothing kept yet. Write a voice below, name it and press Save to my voices.</p>');
}

function updateVoiceCount() {
  const n = $('voiceText').value.length;
  $('voiceCount').textContent = n + ' / ' + VOICE_MAX;
}

function renderVoiceForm() {
  $('voiceText').value = (STATE && STATE.coachVoice) || '';
  $('voiceText').maxLength = VOICE_MAX;
  $('voiceName').value = '';
  renderMyVoices();
  updateVoiceCount();
  voiceMsg('');
  $('voiceIntro').textContent = !Api.isConfigured()
    ? 'Connect first, then you can choose how your coach sounds.'
    : (STATE && STATE.coachVoice)
      ? 'Your coach is using the voice below. Change it any time.'
      : 'Nothing set yet, so your coach uses its default voice. Pick a starting point or write your own.';
}

function saveVoice(text) {
  if (!Api.isConfigured()) return voiceMsg('Connect first (the fields above).', 'err');
  voiceMsg('Saving…');
  request('Saving', 'saveCoachVoice', { text })
    .then(({ res }) => {
      const v = res && typeof res.coachVoice === 'string' ? res.coachVoice : text;
      if (STATE) { STATE.coachVoice = v; saveCache(); }
      $('voiceText').value = v;
      updateVoiceCount();
      voiceMsg(v ? 'Saved. Your next daily focus, review and chat replies will use this voice.' : 'Cleared. Your coach is back to its default voice.', 'good');
      $('voiceIntro').textContent = v ? 'Your coach is using the voice below. Change it any time.' : 'Nothing set yet, so your coach uses its default voice. Pick a starting point or write your own.';
      if (pending === 0) idleStatus();
    })
    .catch(err => {
      voiceMsg(err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) idleStatus();
    });
}

/** Keeps the text in the box as a named voice in the sheet (a name already kept is replaced). The coach's own voice is not touched. */
function saveMyVoice() {
  if (!Api.isConfigured()) return voiceMsg('Connect first (the fields above).', 'err');
  const name = $('voiceName').value.trim(), text = $('voiceText').value;
  if (!name) { voiceMsg('Give this voice a name first, in the box under the text.', 'err'); $('voiceName').focus(); return; }
  if (!text.trim()) return voiceMsg('Write the voice first, then save it.', 'err');
  voiceMsg('Saving…');
  request('Saving', 'saveMyVoice', { name, text })
    .then(({ res }) => {
      if (STATE && res && Array.isArray(res.myVoices)) { STATE.myVoices = res.myVoices; saveCache(); }
      renderMyVoices();
      voiceMsg('Kept as “' + name + '”. It is under My voices on every device. To make your coach use it, press Save voice.', 'good');
      if (pending === 0) idleStatus();
    })
    .catch(err => {
      voiceMsg(err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) idleStatus();
    });
}

function removeMyVoice(id) {
  voiceMsg('Removing…');
  request('Removing', 'removeMyVoice', { id })
    .then(({ res }) => {
      if (STATE && res && Array.isArray(res.myVoices)) { STATE.myVoices = res.myVoices; saveCache(); }
      renderMyVoices();
      voiceMsg('Removed.', 'good');
      if (pending === 0) idleStatus();
    })
    .catch(err => {
      voiceMsg(err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) idleStatus();
    });
}

// ---- phone pairing -------------------------------------------
// Computer: create a one-time link. Phone: open it (or paste it) and the one-time code is traded for that
// phone's own device token, so the main token never leaves the computer.
const PAIR_RE = /pair=(AKfycb[A-Za-z0-9_-]{40,200})\.([0-9a-f]{20,64})/;
const parsePairing = text => { const m = PAIR_RE.exec(String(text || '')); return m ? { id: m[1], code: m[2] } : null; };

function deviceName() {
  const ua = navigator.userAgent || '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return os + ', ' + br;
}

function paneMsg(id, text, kind) {
  const p = $(id);
  p.textContent = text || '';
  p.className = 'cfg-msg' + (kind ? ' ' + kind : '');
}
const phoneMsg = (t, k) => paneMsg('phoneMsg', t, k);

const phoneUsable = () => Api.isConfigured() && !Api.isDemo();
const isMaster = () => !(STATE && STATE.role === 'device');

function renderPhoneBox() {
  const live = phoneUsable(), master = isMaster();
  $('phoneIntro').textContent = !live
    ? (Api.isDemo() ? 'Pairing needs a real connection, so it is not available in demo mode.' : 'Connect this computer first, then you can add your phone.')
    : !master
      ? 'This device is connected as a phone. Create links and manage phones from your computer.'
      : 'We email a one-time link to your own address. Open that email on your phone and it connects itself. The link works once and expires in ten minutes. Each phone gets its own access, which you can cut off here.';
  $('phoneMake').hidden = !(live && master);
  $('phoneDevices').hidden = !(live && master);
  $('phoneBox').open = false;   // reopening it reloads the phone list
  phoneMsg('');
  renderDevices(null);
}

function renderDevices(list) {
  const box = $('deviceList');
  $('revokeAllBtn').hidden = !(list && list.length);
  if (!list) { box.textContent = 'Open this section to load the list.'; return; }
  if (!list.length) { box.textContent = 'No phones connected yet.'; return; }
  box.innerHTML = list.map(d => `<div class="device-row"><div>
      <div class="device-name">${esc(d.name)}</div>
      <div class="device-meta">added ${esc(fmtDate(d.created))} · ${d.used ? 'last used ' + esc(fmtDate(d.used)) : 'not used yet'}</div></div>
      <button type="button" class="ghost run" data-act="revokeDevice" data-id="${esc(d.id)}" aria-label="Disconnect ${esc(d.name)}">Disconnect</button></div>`).join('');
}

/** Pairing calls go through the same queue and status chip as everything else. */
function phoneRequest(label, action, args, onDone) {
  if (!phoneUsable()) return phoneMsg('Connect first.', 'err');
  phoneMsg(label + '…');
  request(label, action, args)
    .then(({ res }) => { onDone(res); if (pending === 0) setStatus('Ready', 'ok'); })
    .catch(err => {
      phoneMsg(err.code === 'forbidden' ? 'Only your computer can do that.' : err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok');
    });
}

function loadDevices() {
  phoneRequest('Loading the list', 'listDevices', {}, res => { renderDevices(res.devices); phoneMsg(''); });
}

/**
 * One click: make a one-time code, then have the backend email the link to your own address.
 * The link is never shown on screen, so there is nothing to copy or paste.
 */
function sendPhoneLink() {
  if (!phoneUsable()) return phoneMsg('Connect first.', 'err');
  phoneMsg('Creating a one-time link…');
  request('Creating a link', 'createPairing', {})
    .then(({ res }) => {
      const base = location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
      const link = base + '#pair=' + Api.backendId(Api.getConfig().url) + '.' + res.code;
      phoneMsg('Emailing it to you…');
      return request('Sending', 'emailPairingLink', { link });
    })
    .then(({ res }) => {
      phoneMsg(`Sent to ${res.to}. Open that email on your phone within ten minutes. The link works once.`, 'good');
      if (pending === 0) setStatus('Ready', 'ok');
    })
    .catch(err => {
      phoneMsg(err.code === 'forbidden' ? 'Only your computer can do that.' : err.message, 'err');
      if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok');
    });
}

function revokeDevice(id) {
  phoneRequest('Disconnecting', 'revokeDevice', { id }, res => { renderDevices(res.devices); phoneMsg('Phone disconnected.', 'good'); });
}

function revokeAll() {
  phoneRequest('Disconnecting', 'revokeAllDevices', {}, res => { renderDevices(res.devices); phoneMsg('All phones disconnected.', 'good'); });
}

/** Phone side: replacing an existing connection must be a choice, never a surprise. */
function confirmReplace(p) {
  const cfg = Api.getConfig();
  if (!Api.isConfigured() || Api.isDemo() || !cfg.url) return true;
  return confirm(Api.backendId(cfg.url) === p.id
    ? 'This device is already connected to this LearnerBot. Use pairing links only on a phone: continuing swaps this device\'s full access for phone-level access (it could no longer add other phones). Continue?'
    : 'This link connects to a different LearnerBot than the one saved on this device. Replace the saved connection?');
}

async function redeemLink(p) {
  setStatus('Connecting this phone …', 'busy');
  const url = Api.backendUrl(p.id);
  try {
    const res = await Api.callPublic(url, 'redeemPairing', { code: p.code, name: deviceName() });
    Api.setConfig({ url, token: res.token });
    resetSession();
    if ($('settings').open) $('settings').close();
    toast('This phone is connected.');
    boot();
    return true;
  } catch (e) {
    const known = ['bad_code', 'rate_limited', 'too_many_devices', 'not_configured'].includes(e.code);
    const text = known ? e.message : 'Could not connect with that link: ' + e.message;
    toast(text, 'error');
    if (Api.isConfigured() && !STATE) boot();           // we paused the normal start for this; resume it
    else setStatus(Api.isConfigured() ? 'Ready' : 'Not connected', Api.isConfigured() ? 'ok' : '');
    return false;
  }
}

/** A pairing link opened on this device (from the email): take the code out of the address bar at once, then use it. */
function startFromLink() {
  const p = parsePairing(location.hash);
  if (!p) return false;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* address bar stays as is */ }
  if (!confirmReplace(p)) return false;                 // keep the saved connection; the normal start continues
  if (!Api.isConfigured()) showConnect();
  redeemLink(p);
  return true;
}

/**
 * Installs the newest app text from the LearnerBot site into the sheet's script (the loader there does the
 * work and checks it), then reloads. Only the main connection may; a phone is told to use the computer.
 */
function runUpdate(kind) {
  if (updating) return;
  updating = true;
  updateError = '';
  renderNotices(); renderVersionLine();
  const going = kind === 'rollback';
  request(going ? 'Going back' : 'Updating the script', going ? 'rollbackApp' : 'updateApp', going ? {} : { expectVersion: EXPECTED_BACKEND })
    .then(({ res }) => {
      forceUpdateNotice = false;
      const status = res && res.status;
      if (!going && status === 'current') toast('Already up to date.');
      if (going && status === 'none') toast('Nothing to go back to.');
      return load().then(() => {
        if (!going && status === 'updated') offerUndo('Updated the script to ' + res.to, () => runUpdate('rollback'));
        else if (going && status === 'rolled_back') toast('Went back to version ' + res.to + '.');
      });
    })
    .catch(err => {
      updateError = err.message;
      toast(err.message, 'error');
      if (isAuthError(err)) fail(err);
    })
    .finally(() => {
      updating = false;
      if (pending === 0) setStatus(STATE ? 'Ready' : 'Not connected', STATE ? 'ok' : '');
      if (STATE) renderNotices();
      renderVersionLine();
    });
}

/** The backend version line in Settings, with a way to update when the script is behind. */
function renderVersionLine() {
  const p = $('versionLine');
  if (!STATE || Api.isDemo() || !Api.isConfigured()) { p.hidden = true; return; }
  p.hidden = false;
  const info = STATE.appInfo, master = STATE.role !== 'device';
  const btn = (act, label, busy) => `<button type="button" class="ghost run" data-act="${act}"${updating ? ' disabled' : ''}>${updating ? busy : label}</button>`;
  let html;
  if (backendOutdated()) {
    html = `LearnerBot ${esc(SITE_RELEASE)}. Your sheet's script is ${STATE.version ? 'build ' + esc(STATE.version) : 'an older version'}; the newest is build ${esc(EXPECTED_BACKEND)}. ` +
      (info && master ? btn('updateApp', 'Update now', 'Updating…') : master ? '<a href="update.html">Update it (about 2 minutes)</a>.' : 'Update it from your computer.');
  } else {
    html = `LearnerBot ${esc(SITE_RELEASE)}. Your sheet's script is up to date (build ${esc(STATE.version || EXPECTED_BACKEND)}).`;
  }
  if (info && info.canRollback && master) html += ' ' + btn('rollbackApp', 'Go back to ' + esc(info.rollbackTo), 'Going back…');
  if (info && info.loadError) html += `<div class="cfg-msg err">${esc(info.loadError)}</div>`;
  p.innerHTML = html;
}

/** The Housekeeping section: how long removed things are kept, and the completed-goals tidy-up. */
function renderHousekeepForm() {
  const hk = STATE && STATE.housekeeping;
  if (hk) $('purgeDays').value = String(hk.purgeDays);
  $('purgeDays').disabled = !hk;
  $('tidyLine').textContent = !hk ? 'Connect first.' : hk.reviewCount
    ? `${hk.reviewCount} completed ${hk.reviewCount === 1 ? 'goal is' : 'goals are'} ready to review. Last tidy-up: ${fmtDate(hk.lastReview)}.`
    : `No completed goals are ready to review yet. Last tidy-up: ${fmtDate(hk.lastReview)}.`;
  $('reviewNowBtn').disabled = !hk || !hk.reviewCount;
  paneMsg('housekeepMsg', '');
}

function saveHousekeepNow() {
  if (!Api.isConfigured()) return paneMsg('housekeepMsg', 'Connect first.', 'err');
  paneMsg('housekeepMsg', 'Saving\u2026');
  request('Saving', 'saveHousekeeping', { purgeDays: Number($('purgeDays').value) })
    .then(({ res }) => {
      if (STATE && res && res.housekeeping) { STATE.housekeeping = res.housekeeping; saveCache(); }
      paneMsg('housekeepMsg', 'Saved. Removed items are deleted for good after ' + Number($('purgeDays').value) + ' days.', 'good');
      if (pending === 0) setStatus('Ready', 'ok');
    })
    .catch(err => { paneMsg('housekeepMsg', err.message, 'err'); if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok'); });
}

function openSettings(message, kind) {
  renderHousekeepForm();
  syncLookForm();
  lookMsg('');
  renderNotifyForm();
  renderVoiceForm();
  renderVersionLine();
  renderPhoneBox();
  renderTimings();
  const cfg = Api.getConfig();
  $('cfgUrl').value = cfg.url || '';
  $('cfgToken').value = '';
  setTokenVisible(false);
  $('cfgToken').placeholder = cfg.token ? 'Saved for this URL. Leave blank to keep it, or paste a new one' : 'Paste the access token';
  cfgMsg(typeof message === 'string' ? message : '', kind);
  // The connection section opens only when there is something to fix (not connected yet, or a refused connection).
  const needsConnect = !Api.isConfigured() || (typeof message === 'string' && message !== '');
  $('connectBox').open = needsConnect;
  const dlg = $('settings');
  if (!dlg.open) dlg.showModal();
  // Never pull focus into a text box on open: on a phone that raises the keyboard. With a mouse, help when the connection needs fixing.
  if (needsConnect && window.matchMedia && matchMedia('(pointer:fine)').matches) $('cfgUrl').focus();
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
    cfgMsg('Connected' + (info.version ? ' (script build ' + info.version + ')' : '') + '.' +
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
  if (typeof resetHistory === 'function') resetHistory();
  PLAN_EDIT = null;
  fromCache = false;
  forceUpdateNotice = false;
  EDITING = null;
  hideUndo();
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
  if (Queue.size()) { showWaiting(); pumpQueue(); }         // ...send what was still waiting from last time...
  load();                                                   // ...and bring it up to date in the background
}

// Changes are kept in this browser, so closing the page is safe. Only when the browser will not store anything do they need a warning.
window.addEventListener('beforeunload', e => {
  if (Queue.size() > 0 && !Queue.durable()) { e.preventDefault(); e.returnValue = ''; }
});

// Back online, or back on this tab: send what is waiting, and after a while quietly refresh (no timers for that, only on return).
window.addEventListener('online', () => { retryStep = 0; if (Queue.size()) pumpQueue(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !STATE || !Api.isConfigured()) return;
  if (Queue.size()) { retryStep = 0; pumpQueue(); }
  else if (pending === 0 && Date.now() - lastLoadAt > 60000) load();
});

document.addEventListener('DOMContentLoaded', () => {
  $('chatForm').addEventListener('submit', sendChat);
  $('voiceText').addEventListener('input', updateVoiceCount);
  $('purgeDays').addEventListener('change', saveHousekeepNow);
  buildVoiceForm();
  buildLookForm();
  syncLookForm();
  $('lookFont').addEventListener('change', e => setLook({ font: e.target.value }));
  $('lookAccent').addEventListener('input', e => { if (e.target.id === 'lookCustom') setLook({ accent: e.target.value }); });
  $('lookPrimary').addEventListener('input', e => { if (e.target.id === 'lookPrimaryCustom') setLook({ theme: 'custom', primary: e.target.value }); });
  $('phoneBox').addEventListener('toggle', () => { if ($('phoneBox').open && phoneUsable() && isMaster()) loadDevices(); });
  switchView('dash');
  if (!startFromLink()) { if (Api.isConfigured()) boot(); else showConnect(); }
});
