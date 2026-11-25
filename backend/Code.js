// ============================================================
// Code.js \u2014 config, setup menu, triggers, emails, AI flows
// ============================================================

const GROQ_MODEL  = 'openai/gpt-oss-120b';
// APP_RELEASE is the name people see (1.0, 1.1, ...); APP_VERSION is the build id the update check compares,
// and it only ever goes up. A release is one or more builds; CHANGELOG.md in the site repo maps them.
const APP_RELEASE = '1.14';
const APP_VERSION = '2026.11.28';

const AI_CALLS_PER_HOUR = 40;
const LIMITS = { title: 200, text: 2000, tags: 120, message: 1000, voice: 800, voiceName: 30, myVoices: 12 };

// How the site looks is saved in the sheet so every device matches. Only these names are accepted; the site
// keeps the same lists in js/look.js (a test fails if they drift apart).
const APPEARANCE_THEMES = ['dark', 'light', 'contrast', 'custom'];
const APPEARANCE_FONTS = ['system', 'humanist', 'serif', 'wide', 'mono', 'rounded'];

// ---- Script properties & settings ---------------------------

function _props() { return PropertiesService.getScriptProperties(); }

function getApiKey() {
  const key = _props().getProperty('GROQ_API_KEY');
  if (!key) throw _err('no_key', 'No Groq API key yet. In the sheet, open LearnerBot \u2192 Set Groq API key.');
  return key;
}

function _hasKey() { return !!_props().getProperty('GROQ_API_KEY'); }

function _ensureToken() {
  let t = _props().getProperty('API_TOKEN');
  if (!t) {
    t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    _props().setProperty('API_TOKEN', t);
  }
  return t;
}

let _tz = null;
function _tzName() {
  if (!_tz) _tz = _props().getProperty('TZ') || Session.getScriptTimeZone();
  return _tz;
}

/** Caps AI-backed requests so a leaked token can't drain the Groq quota. */
function _throttleAi() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('ai_count') || 0);
  if (n >= AI_CALLS_PER_HOUR) throw _err('rate_limited', 'AI request limit reached for this hour. Try again later.');
  cache.put('ai_count', String(n + 1), 3600);
}

// ---- Sheet menu (setup) -------------------------------------

function onOpen() {
  const menu = SpreadsheetApp.getUi().createMenu('LearnerBot')
    .addItem('1. Set Groq API key\u2026', 'menuSetGroqKey')
    .addItem('2. Show connection info', 'menuShowConnection')
    .addSeparator()
    .addItem('Turn off all emails', 'menuEmailsOff')
    .addItem('Reset access token', 'menuResetToken');
  // The loader (a separate part of the script) provides this; it is the way back if an update ever misbehaves.
  if (typeof menuUseBuiltIn === 'function') menu.addSeparator().addItem('Repair: use the built-in version', 'menuUseBuiltIn');
  menu.addToUi();
}

function menuSetGroqKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Groq API key',
    'Paste your key from console.groq.com/keys (it starts with gsk_). It is stored in this script\'s private properties, not in the sheet.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) {
    ui.alert('That does not look like a Groq key (expected gsk_\u2026). Nothing was saved.');
    return;
  }
  _props().setProperty('GROQ_API_KEY', key);
  ui.alert('Saved. Next: LearnerBot \u2192 Show connection info.');
}

function menuShowConnection() {
  initHeaders();
  const token = _ensureToken();
  // ScriptApp.getService().getUrl() is deliberately not used: for a deployment made in the editor it can
  // return an address that looks valid but answers 404. The real URL comes from Deploy > Manage deployments.
  const field = (id, label, value) =>
    '<label>' + _h(label) + '</label><input id="' + id + '" readonly onclick="this.select()" value="' + _h(value) + '">' +
    '<button onclick="cp(\'' + id + '\')">Copy</button>';
  const html =
    '<style>body{font:14px sans-serif;margin:16px}label{display:block;font-weight:600;margin-top:10px}' +
    'input{width:100%;box-sizing:border-box;font:12px monospace;padding:6px;margin:4px 0}.warn{color:#b00}.hint{color:#555;font-size:12px}</style>' +
    '<p>The LearnerBot site (\u2699 Settings) needs two things from <b>this</b> sheet: the <b>Web app URL</b> and the <b>access token</b>. Treat the token like a password.</p>' +
    '<p><b>1. Web app URL.</b> In the Apps Script editor choose <b>Deploy \u2192 Manage deployments</b> and copy the <b>Web app URL</b> shown for your deployment (it ends in <code>/exec</code>). ' +
    'No deployment yet? Deploy \u2192 New deployment \u2192 Web app (Execute as: Me, Who has access: Anyone). Use this address, not one from anywhere else.</p>' +
    '<p><b>2. Access token.</b></p>' +
    field('t', 'Access token', token) +
    '<p class="hint">Token starts with <b>' + _h(token.slice(0, 4)) + '</b> and ends with <b>' + _h(token.slice(-4)) + '</b> (' + token.length + ' characters). ' +
    'If a Copy button does nothing, click the box and press Ctrl+C.</p>' +
    (_hasKey() ? '' : '<p class="warn">No Groq key saved yet \u2014 use LearnerBot \u2192 Set Groq API key.</p>') +
    '<script>function cp(id){var e=document.getElementById(id);e.select();document.execCommand("copy");}</script>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(540).setHeight(430), 'LearnerBot connection');
}

function menuResetToken() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Reset access token', 'Everything using the old token stops working until you paste the new one, and every connected phone is disconnected. Continue?', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  _props().deleteProperty('API_TOKEN');
  _props().deleteProperty('DEVICES');   // phones hold their own tokens; a reset must cut them off too
  _ensureToken();
  ui.alert('Done. Open LearnerBot \u2192 Show connection info for the new token, and pair your phones again.');
}

// Email settings, triggers and the scheduled jobs live in Notify.js.

// ---- AI flows -----------------------------------------------

/** One coaching run: asks the model and saves the report. Used by the app and by the scheduled job. */
function generateDaily() {
  _throttleAi();
  const result = callLearningCoach(buildDailyContext());
  saveReport('daily', result);
  return result;
}

function runDailyNow() {
  generateDaily();
  return getState();
}

/** One weekly review + plan: saves the report and a history row. */
function generateWeekly() {
  _throttleAi();
  const dash  = callLifeDashboard(buildWeeklyContext());
  const plan  = callGoalArchitect(buildPlanContext(dash));
  const goals = getAllGoals();
  const done  = goals.filter(g => g.status === 'completed').length;
  const score = goals.length > 0 ? Math.round((done / goals.length) * 10) : 0;
  saveReport('weekly', { dashboard: dash, plan: plan, score: score });
  addHistoryEntry(score, dash.summary || '');
  return { dashboard: dash, score: score };
}

function runWeeklyNow() {
  generateWeekly();
  return getState();
}

function chat(message) {
  const text = _clip(message, LIMITS.message);
  if (!text) throw _err('bad_request', 'Say something first.');
  _throttleAi();
  const goals    = getAllGoals();
  const tasks    = getAllTasks();
  const goalList = goals.map(g => `[#${g.id}] ${g.title} (${g.priority}, ${g.status})${g.tags.length ? ' [' + g.tags.join(', ') + ']' : ''}${g.parentId ? ' parent:' + g.parentId : ''}${g.due ? ' due:' + g.due : ''}`).join('\n');
  const taskList = tasks.filter(t => t.status === 'active').map(t => `[task#${t.id} \u2192 goal#${t.goalId}] ${t.title}`).join('\n');
  const ctx = `TODAY: ${_todayLine()}\n\nUSER MESSAGE:\n${text}\n\nCURRENT GOALS:\n${goalList || '(none)'}\n\nACTIVE TASKS:\n${taskList || '(none)'}`;
  saveChatMessage('user', text);
  const intent = callConcierge(ctx);
  const reply = applyIntent(intent);
  saveChatMessage('bot', reply);
  return { reply: reply, state: getState() };
}

/** Applies one structured action chosen by the concierge model. */
function applyIntent(intent) {
  try {
    switch (intent.action) {
      case 'add_goal':
        // A date the model got wrong is dropped rather than failing the whole request.
        if (intent.title) addGoal(intent.title, intent.priority, intent.tags, intent.parent_id, _safeDue(intent.due));
        break;
      case 'complete_goal':
        if (intent.goal_id) setGoalStatus(intent.goal_id, 'completed');
        break;
      case 'postpone_goal':
        if (intent.goal_id) setGoalStatus(intent.goal_id, 'postponed');
        break;
      case 'remove_goal':
        if (intent.goal_id) setGoalStatus(intent.goal_id, 'archived');
        break;
      case 'update_goal': {
        if (!intent.goal_id) break;
        const f = {};
        if (intent.title) f.title = intent.title;
        if (PRIORITIES.indexOf(intent.priority) >= 0) f.priority = intent.priority;
        if (intent.tags) f.tags = intent.tags;
        if (intent.due) {
          if (String(intent.due).trim().toLowerCase() === 'none') f.due = '';
          else { const d = _safeDue(intent.due); if (d) f.due = d; }
        }
        if (Object.keys(f).length) updateGoal(intent.goal_id, f);
        break;
      }
      case 'add_task':
        if (intent.goal_id && intent.title) addTask(intent.goal_id, intent.title);
        break;
      case 'complete_task':
        if (intent.task_id) setTaskStatus(intent.task_id, 'done');
        break;
      case 'add_feedback':
        if (intent.text) addFeedback(intent.text);
        break;
      case 'log_activity':
        if (intent.text) addJournalEntry(intent.text, intent.tags, _safeMinutes(intent.minutes));
        break;
      case 'run_daily':
        runDailyNow();
        break;
      case 'run_weekly':
        runWeeklyNow();
        break;
    }
    return String(intent.reply || 'Done.');
  } catch (e) {
    return 'Sorry, I could not do that: ' + (e && e.message ? e.message : e);
  }
}

// ---- HTML escaping (used by the connection window and the emails) ----

function _h(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

