// ============================================================
// Api.js \u2014 the JSON API the static site talks to
//
// POST  body (text/plain, to avoid a CORS preflight):
//       {"token": "...", "action": "getState", "args": {...}, "tz": "America/Denver"}
// reply {"ok": true, "data": ...}  or  {"ok": false, "code": "...", "error": "..."}
// GET   returns a harmless health check, never any data.
// ============================================================

function doGet() {
  return _json({ ok: true, data: { app: 'LearnerBot', release: APP_RELEASE, version: APP_VERSION } });
}

function doPost(e) {
  const t0 = Date.now();
  Object.keys(_prof).forEach(k => delete _prof[k]);
  const marks = {};
  const ms = () => Object.assign({ total: Date.now() - t0 }, marks, _prof);
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return _json({ ok: false, code: 'bad_request', error: 'Request body was not valid JSON.', ms: ms() });
  }
  try {
    // A public action (redeeming a pairing code) has no token yet, so it must not touch anything a
    // caller could abuse without one: no time zone change, no sheet set-up.
    const isPublic = typeof req.action === 'string' && PUBLIC_ACTIONS.indexOf(req.action) >= 0;
    if (!isPublic) {
      _authorize(req.token);
      marks.auth = Date.now() - t0;
      _useTimeZone(req.tz);
    }
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, req.action) ? ACTIONS[req.action] : null;
    if (!fn) throw _err('bad_action', 'Unknown action.');
    if (!isPublic) _ensureHeaders();
    marks.ready = Date.now() - t0;
    const data = fn(req.args || {});
    return _json({ ok: true, data: data, ms: ms() });
  } catch (err) {
    return _json({ ok: false, code: (err && err.code) || 'error', error: String((err && err.message) || err), ms: ms() });
  }
}

const ACTIONS = {
  ping: () => ({ release: APP_RELEASE, version: APP_VERSION, hasKey: _hasKey(), tz: _tzName(), role: _role }),
  getState: () => getState(),

  // Small changes answer with just what the page needs (the page already updated itself),
  // not a re-read of every tab. AI actions below still return the full state.
  addGoal: a => ({ goal: addGoal(a.title, a.priority, a.tags, a.parentId, a.due, a.ref, a.replay === true) }),
  updateGoal: a => ({ goal: updateGoal(a.id, a.fields) }),
  setGoalStatus: a => {
    if (!setGoalStatus(a.id, a.status)) throw _err('not_found', 'Goal not found.');
    return { ok: true };
  },
  addTask: a => ({ task: addTask(a.goalId, a.title, a.ref, a.replay === true) }),
  setTaskStatus: a => {
    if (!setTaskStatus(a.id, a.status)) throw _err('not_found', 'Task not found.');
    return { ok: true };
  },
  logActivity: a => {
    const entry = addJournalEntry(a.text, a.tags, a.minutes, a.ref, a.replay === true);
    maybePurge();
    return { entry: entry, streak: getStreak(), weekMinutes: weekMinutes() };
  },

  // The Today page (Today.js). setTodayFeed is how the planner on the owner's computer delivers the day; master connection only.
  getToday:         () => getTodayView(),
  setTodayFeed:     a => setTodayFeed(a),
  addTodayTask:     a => addTodayTask(a),
  setTodayGoal:     a => setTodayGoal(a),
  setTodayStatus:   a => setTodayStatus(a),
  completeTodayTask: a => completeTodayTask(a),

  // Looking back at the log (shown in History), and changing it. Removing only hides an entry.
  getLog:     a => getLog(a),
  updateLog:  a => ({ entry: updateLog(a.id, a.fields), streak: getStreak(), weekMinutes: weekMinutes() }),
  removeLog:  a => removeLog(a.id),
  restoreLog: a => restoreLog(a.id),

  // Keeping the sheet light, and the quarterly review of completed goals.
  saveHousekeeping: a => ({ housekeeping: saveHousekeeping(a) }),
  getReview:   () => getReview(),
  applyReview: a => ({ result: applyReview(a), housekeeping: getHousekeeping() }),

  updatePlan: a => updatePlan(a),
  submitFeedback: a => {
    addFeedback(a.text, a.ref, a.replay === true);
    return { ok: true };
  },
  saveCoachVoice: a => ({ coachVoice: setCoachVoice(a.text) }),
  saveMyVoice:    a => ({ myVoices: saveMyVoice(a.name, a.text) }),
  removeMyVoice:  a => ({ myVoices: removeMyVoice(a.id) }),
  saveAppearance: a => ({ appearance: setAppearance(a) }),

  saveNotifications: a => saveNotifications(a),
  sendTestEmail:     () => sendTestEmail(),

  // Phone pairing (Pairing.js). Everything but redeemPairing is master-only.
  createPairing:     () => createPairing(),
  redeemPairing:     a => redeemPairing(a || {}),
  emailPairingLink:  a => emailPairingLink(a),
  listDevices:       () => listDevices(),
  revokeDevice:      a => revokeDevice(a),
  revokeAllDevices:  () => revokeAllDevices(),

  runDaily:  () => runDailyNow(),
  runWeekly: () => runWeeklyNow(),
  chat:      a => chat(a.message)
};

/** Everything the dashboard needs, in one response. Each section fails on its own. */
function getState() {
  const errs = [];
  const safe = (label, fn, fallback) => {
    try { return fn(); }
    catch (e) { errs.push(label + ': ' + e.message); return fallback; }
  };
  return {
    goals:          safe('goals',    getAllGoals,                      []),
    tasks:          safe('tasks',    getAllTasks,                      []),
    historyGoals:   safe('hist',     getHistoryGoals,                  []),
    dailyReport:    safe('daily',    () => getLatestReport('daily'),   null),
    weeklyReport:   safe('weekly',   () => getLatestReport('weekly'),  null),
    recentFeedback: safe('feedback', () => getRecentFeedback(3),       []),
    history:        safe('history',  () => getRecentHistory(5),        []),
    chatHistory:    safe('chat',     () => getChatHistory(30),         []),
    streak:         safe('streak',   getStreak,                        0),
    weekMinutes:    safe('minutes',  weekMinutes,                      0),
    coachVoice:     safe('voice',    getCoachVoice,                    ''),
    myVoices:       safe('myvoices', getMyVoices,                      []),
    appearance:     safe('look',     getAppearance,                    null),
    housekeeping:   safe('tidy',     getHousekeeping,                  null),
    today:          safe('today',    getTodayView,                     null),
    notify:         safe('notify',   _notifyView,                      null),
    role:           _role,
    hasKey:         _hasKey(),
    release:        APP_RELEASE,
    version:        APP_VERSION,
    // Which copy of the app is running and whether the site can update it (the loader answers; null when there is none).
    appInfo:        safe('app',      () => (typeof lbInfo === 'function' ? lbInfo() : null), null),
    _errors:        errs
  };
}

// ---- Plumbing -----------------------------------------------

function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _authorize(token) {
  const expected = _props().getProperty('API_TOKEN');
  if (!expected) throw _err('not_configured', 'This backend is not set up yet. In the sheet, open LearnerBot \u2192 Show connection info.');
  if (token === expected) { _role = 'master'; return; }
  const device = _deviceForToken(token);
  if (!device) throw _err('unauthorized', 'Wrong access token.');
  _role = 'device';
  _touchDevice(device);
}

function _useTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return;
  try { Utilities.formatDate(new Date(), tz, 'yyyy'); } catch (_) { return; }
  _tz = tz;
  if (_props().getProperty('TZ') !== tz) _props().setProperty('TZ', tz);
}

// Keyed by version, so a newly pasted update adds its new columns on the very next request
// instead of waiting for an old "already done" marker to expire.
function _ensureHeaders() {
  const cache = CacheService.getScriptCache();
  const key = 'h_ok_' + APP_VERSION;
  if (cache.get(key)) return;
  initHeaders();
  // Goals and tasks completed or removed before status dates existed start counting from today. A problem here
  // must never stop the request that triggered it.
  try { backfillStatusDates(); } catch (e) { Logger.log('Status dates not filled in: ' + (e && e.message ? e.message : e)); }
  cache.put(key, '1', 3600);
}

