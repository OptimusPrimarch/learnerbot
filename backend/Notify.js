// ============================================================
// Notify.js \u2014 email settings, scheduled jobs, test email
//
// Settings live in Script Properties. Like the time triggers they drive, they stay with this
// script and do not travel when the sheet is copied, so a copy never claims emails are on
// with nothing scheduled.
//
// Only the scheduled jobs send email. Pressing Run daily / Run weekly in the app never does.
// Mail only ever goes to the Google account that owns this script.
// ============================================================

const NOTIFY_DEFAULTS = {
  daily:  { enabled: false, hour: 7 },
  weekly: { enabled: false, day: 0, hour: 18 },   // day: 0 = Sunday ... 6 = Saturday
  nudge:  { enabled: false, hour: 20 }
};
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const JOB_HANDLERS = ['_dailyJob', '_weeklyJob', '_nudgeJob', '_workdayJob'];
const TEST_EMAILS_PER_HOUR = 5;

// ---- Settings -----------------------------------------------

function _notifySettings() {
  let saved = {};
  try { saved = JSON.parse(_props().getProperty('NOTIFY') || '{}') || {}; } catch (_) { saved = {}; }
  const pick = k => Object.assign({}, NOTIFY_DEFAULTS[k], saved[k] || {});
  return { daily: pick('daily'), weekly: pick('weekly'), nudge: pick('nudge'), siteUrl: typeof saved.siteUrl === 'string' ? saved.siteUrl : '' };
}

function _int(v, min, max, label) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) {
    throw _err('bad_request', label + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  return n;
}

function _cleanNotify(a) {
  const d = a.daily || {}, w = a.weekly || {}, n = a.nudge || {};
  const out = {
    daily:  { enabled: d.enabled === true, hour: _int(d.hour, 0, 23, 'The daily hour') },
    weekly: { enabled: w.enabled === true, day: _int(w.day, 0, 6, 'The weekly day'), hour: _int(w.hour, 0, 23, 'The weekly hour') },
    nudge:  { enabled: n.enabled === true, hour: _int(n.hour, 0, 23, 'The nudge hour') },
    siteUrl: ''
  };
  // The link emails point back to: https only, no spaces or quote characters.
  const url = String(a.siteUrl || '').trim().slice(0, 300);
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s"'<>]*)?$/.test(url)) out.siteUrl = url;
  return out;
}

function _ownerEmail() {
  try { return Session.getEffectiveUser().getEmail() || ''; } catch (_) { return ''; }
}

/** What the page shows: the saved choices plus where mail goes and which time zone the hours use. */
function _notifyView() {
  return Object.assign(_notifySettings(), { email: _ownerEmail(), tz: _tzName() });
}

function saveNotifications(a) {
  const s = _cleanNotify(a || {});
  _props().setProperty('NOTIFY', JSON.stringify(s));
  _syncTriggers(s);
  return { notify: _notifyView() };
}

// ---- Triggers (one per switched-on schedule) ----------------

// ---- The Workday's own refresh (no email): Google Tasks and Google Calendar on weekdays, at the hours the person chose ----

const WORKDAY_DEFAULT_HOURS = [6, 15];

function _loaderVersion() {
  try { return typeof LB_LOADER_VERSION === 'number' ? LB_LOADER_VERSION : 1; } catch (_) { return 1; }
}

function _workdaySettings() {
  let s = {};
  try { s = JSON.parse(_props().getProperty('WORKDAY') || '{}') || {}; } catch (_) { s = {}; }
  const hours = (Array.isArray(s.hours) ? s.hours : []).map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23).slice(0, 4);
  return { enabled: s.enabled === true, hours: hours.length ? hours : WORKDAY_DEFAULT_HOURS.slice() };
}

/** What the page shows: whether it runs, when, and whether this copy of Code.gs can run a timer for it (loader version 2 or newer). */
function getWorkdaySchedule() {
  const s = _workdaySettings(), loader = _loaderVersion();
  return { enabled: s.enabled, hours: s.hours, loader: loader, canSchedule: loader >= 2, tz: _tzName() };
}

function saveWorkdaySchedule(a) {
  _needMaster();
  if (_loaderVersion() < 2) throw _err('needs_loader', 'Automatic refresh needs a one-time paste of the newest Code.gs into your sheet (the update page explains how), because the timer is part of that file.');
  a = a || {};
  const hours = Array.from(new Set((Array.isArray(a.hours) ? a.hours : []).map(h => _int(h, 0, 23, 'An hour')))).sort((x, y) => x - y);
  if (!hours.length || hours.length > 4) throw _err('bad_request', 'Choose between one and four times.');
  _props().setProperty('WORKDAY', JSON.stringify({ enabled: a.enabled === true, hours: hours }));
  _syncTriggers(_notifySettings());
  return { schedule: getWorkdaySchedule() };
}

/** Timer entry point. Weekdays only (a timer cannot say "weekdays", so it checks). Never throws. */
function _workdayJob() {
  try {
    if (!_workdaySettings().enabled) return;
    if (Number(Utilities.formatDate(new Date(), _tzName(), 'u')) >= 6) return;   // 1 = Monday ... 7 = Sunday
    refreshGoogleTasks();
    refreshGoogleCalendar();
  } catch (e) {
    _logJobError('workday', e);
  }
}

function _syncTriggers(s) {
  ScriptApp.getProjectTriggers()
    .filter(t => JOB_HANDLERS.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  const tz = _tzName();
  // atHour runs within about 15 minutes of the hour; Apps Script cannot be more exact.
  if (s.daily.enabled)  ScriptApp.newTrigger('_dailyJob').timeBased().inTimezone(tz).atHour(s.daily.hour).everyDays(1).create();
  if (s.weekly.enabled) ScriptApp.newTrigger('_weeklyJob').timeBased().inTimezone(tz).onWeekDay(ScriptApp.WeekDay[WEEKDAYS[s.weekly.day]]).atHour(s.weekly.hour).create();
  if (s.nudge.enabled)  ScriptApp.newTrigger('_nudgeJob').timeBased().inTimezone(tz).atHour(s.nudge.hour).everyDays(1).create();
  const w = _workdaySettings();
  if (w.enabled && _loaderVersion() >= 2) w.hours.forEach(h => ScriptApp.newTrigger('_workdayJob').timeBased().inTimezone(tz).atHour(h).everyDays(1).create());
}

/** Sheet-menu panic button: every schedule off, hours remembered. */
function menuEmailsOff() {
  const s = _notifySettings();
  ['daily', 'weekly', 'nudge'].forEach(k => { s[k].enabled = false; });
  _props().setProperty('NOTIFY', JSON.stringify(s));
  _syncTriggers(s);
  SpreadsheetApp.getUi().alert('All scheduled emails are off. (The Workday\'s own refresh, if you turned it on, is separate and keeps running.) You can turn emails back on in the LearnerBot site: \u2699 \u2192 Email updates.');
}

// ---- Scheduled jobs -----------------------------------------

function _dailyJob() {
  _runJob('daily', () => {
    refreshGoogleTasks();      // neither throws; the coach hears today's Google Tasks and calendar too
    refreshGoogleCalendar();
    const r = generateDaily();
    _sendMail('Daily focus: ' + _oneLine(r.focus), _dailyHtml(r));
  });
}

function _weeklyJob() {
  _runJob('weekly', () => {
    const w = generateWeekly();
    _sendMail('Weekly review: ' + w.score + '/10', _weeklyHtml(w.score, w.dashboard));
  });
}

function _nudgeJob() {
  _runJob('nudge', () => {
    if (_loggedToday()) return;
    _sendMail('Quick check-in: nothing logged yet today', _nudgeHtml());
  });
}

/** A scheduled run must never throw: failures are recorded (Reports tab, type "error") and skipped. */
function _runJob(name, fn) {
  try {
    if (!_notifySettings()[name].enabled) return;   // switched off after the trigger was created
    fn();
  } catch (e) {
    _logJobError(name, e);
  }
}

function _logJobError(job, e) {
  const message = String((e && e.message) || e).slice(0, 300);
  try { saveReport('error', { job: job, message: message }); }
  catch (_) { Logger.log('Scheduled ' + job + ' job failed: ' + message); }
}

function _loggedToday() {
  const today = _today();
  return _visibleJournal(JOURNAL_TAIL).some(r => r[1] && _day(r[0]).slice(0, 10) === today);
}

// ---- Test email ---------------------------------------------

function sendTestEmail() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('test_mail_count') || 0);
  if (n >= TEST_EMAILS_PER_HOUR) throw _err('rate_limited', 'Test emails are limited to ' + TEST_EMAILS_PER_HOUR + ' an hour.');
  cache.put('test_mail_count', String(n + 1), 3600);
  const to = _ownerEmail();
  if (!to) throw _err('no_email', 'Google did not give this script an address to send to.');
  _sendMail('LearnerBot test email', _testHtml());
  return { sent: true, to: to };
}

// ---- Sending and layout -------------------------------------

function _sendMail(subject, html) {
  const to = _ownerEmail();
  if (!to) throw _err('no_email', 'Google did not give this script an address to send to.');
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
}

function _oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, 120); }

function _footer() {
  const url = _notifySettings().siteUrl;
  return '<p style="font-family:sans-serif;color:#888;font-size:12px;margin-top:24px">' +
    (url ? '<a href="' + _h(url) + '">Open LearnerBot</a> \u00b7 ' : '') +
    'Change or stop these emails in LearnerBot: \u2699 \u2192 Email updates.</p>';
}

function _list(items) {
  return '<ul style="font-family:sans-serif">' + (items || []).map(x => '<li>' + _h(x) + '</li>').join('') + '</ul>';
}

function _dailyHtml(r) {
  return '<h2 style="font-family:sans-serif">Today\'s focus: ' + _h(r.focus) + '</h2>' + _list(r.actions) +
    '<p style="font-family:sans-serif;color:#666"><em>' + _h(r.reason) + '</em></p>' + _footer();
}

function _weeklyHtml(score, d) {
  d = d || {};
  return '<h2 style="font-family:sans-serif">Weekly score: ' + _h(score) + '/10</h2>' +
    '<p style="font-family:sans-serif">' + _h(d.summary) + '</p>' +
    ((d.wins || []).length ? '<h3 style="font-family:sans-serif">Wins</h3>' + _list(d.wins) : '') +
    ((d.suggestions || []).length ? '<h3 style="font-family:sans-serif">Suggestions</h3>' + _list(d.suggestions) : '') + _footer();
}

function _nudgeHtml() {
  return '<h2 style="font-family:sans-serif">Nothing logged yet today</h2>' +
    '<p style="font-family:sans-serif">A line is enough: what did you do or learn today? It keeps your streak and feeds your weekly review.</p>' + _footer();
}

function _testHtml() {
  return '<h2 style="font-family:sans-serif">It works</h2>' +
    '<p style="font-family:sans-serif">This is a test email from your LearnerBot. Scheduled emails will reach this address.</p>' + _footer();
}

