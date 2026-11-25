// GCal.js: your Google calendars, read inside this script with your own Google account, and merged with the Outlook windows the planner sends.
//
// Read-only. Nothing is created, changed or deleted. Event NAMES stay in your Google account: what is stored in the sheet is only time windows
// (start, end, "Google"), and a count of all-day items. The main connection can ask for the day with names (getGoogleDay) so the planner on
// your computer can print one combined calendar; nobody else can.
//
// ONE-TIME SETUP, in the sheet: Extensions > Apps Script > Services (+) > Google Calendar API > Add, then approve Google's permission screen
// (press Refresh Google on the To do card). Until then Today's Look says so and uses whatever the planner sent.
//
// Which calendars: your main calendar and every calendar ticked in Google Calendar's left-hand list. Nothing else is filtered out: all-day
// items, out-of-office and "free" events are kept. They are only treated differently for open time: an all-day item has no hours, and an
// event marked free (or Google's own Focus time) does not use up time, so neither shrinks the day's open focus windows.

const GCAL_KEY = 'gcal_status';
const GCAL_MAX_CALENDARS = 15;
const GCAL_MAX_WINDOWS = 30;
const WORK_DEFAULTS = { workStart: '08:30', workEnd: '17:00', minFocus: 45, hoursPerPoint: 4.5 };

function _calendarApi() {
  try { return typeof Calendar !== 'undefined' && Calendar && Calendar.Events && Calendar.CalendarList ? Calendar : null; }
  catch (_) { return null; }
}

const _toMin = hm => { const m = /^(\d{2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const _hm = min => { const c = Math.max(0, Math.min(1439, Math.round(min))); return ('0' + Math.floor(c / 60)).slice(-2) + ':' + ('0' + (c % 60)).slice(-2); };

/** { date, at, enabled, error, busy:[{start,end,src}], allDay, calendars } from the last refresh. */
function getGoogleCalStatus() {
  try {
    const s = JSON.parse(getSetting(GCAL_KEY) || 'null');
    if (s && typeof s === 'object') return s;
  } catch (_) { /* fall through */ }
  return { date: '', at: '', enabled: _calendarApi() != null, error: '', busy: [], allDay: 0, calendars: 0 };
}

/** The calendars to read: the main one and every ticked one. */
function _calendarsToRead(api) {
  const res = api.CalendarList.list({ maxResults: 100, showHidden: false }) || {};
  return (res.items || []).filter(c => c && !c.deleted && (c.primary || c.selected)).slice(0, GCAL_MAX_CALENDARS)
    .map(c => ({ id: c.id, name: String(c.summaryOverride || c.summary || c.id) }));
}

function _addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** One calendar event as a plain object for `day` (minutes since midnight in the sheet's time zone), or null when it is not on that day. */
function _normGoogleEvent(e, calName, day, tz) {
  if (!e || e.status === 'cancelled' || e.eventType === 'workingLocation') return null;   // a working-location marker is not an event
  const self = (e.attendees || []).find(a => a && a.self);
  const resp = self && self.responseStatus ? self.responseStatus : 'accepted';
  const out = {
    subject: String(e.summary || '(no title)'), calendar: calName, allDay: false, s: 0, e: 1440,
    free: e.transparency === 'transparent' || e.eventType === 'focusTime',
    declined: resp === 'declined', tentative: resp === 'tentative',
    online: !!(e.hangoutLink || (e.conferenceData && e.conferenceData.conferenceSolution) || /zoom\.us|teams\.microsoft\.com|meet\.google\.com/.test(String(e.location || '')))
  };
  if (e.start && e.start.date) {                                   // all-day (the end date is the day after the last one)
    if (!(e.start.date <= day && day < String((e.end && e.end.date) || e.start.date))) return null;
    out.allDay = true;
    return out;
  }
  if (!(e.start && e.start.dateTime && e.end && e.end.dateTime)) return null;
  const sd = new Date(e.start.dateTime), ed = new Date(e.end.dateTime);
  const sDay = Utilities.formatDate(sd, tz, 'yyyy-MM-dd'), eDay = Utilities.formatDate(ed, tz, 'yyyy-MM-dd');
  if (eDay < day || sDay > day) return null;
  out.s = sDay < day ? 0 : _toMin(Utilities.formatDate(sd, tz, 'HH:mm'));
  out.e = eDay > day ? 1439 : _toMin(Utilities.formatDate(ed, tz, 'HH:mm'));
  return out.e > out.s ? out : null;
}

/** The day's events from every calendar read, repeating events already expanded by Google (singleEvents). */
function _fetchGoogleDay(api, day) {
  const tz = _tzName();
  const cals = _calendarsToRead(api);
  const params = {
    timeMin: _addDays(day, -1) + 'T00:00:00Z', timeMax: _addDays(day, 2) + 'T00:00:00Z',   // wide on purpose: every time zone's "today" falls inside
    singleEvents: true, orderBy: 'startTime', showDeleted: false, maxResults: 250,
    fields: 'nextPageToken,items(id,iCalUID,summary,status,eventType,transparency,start,end,location,hangoutLink,conferenceData(conferenceSolution(name)),attendees(self,responseStatus))'
  };
  const events = [], seen = {};
  cals.forEach(c => {
    let token = null, pages = 0;
    do {
      const p = Object.assign({}, params);
      if (token) p.pageToken = token;
      const res = api.Events.list(c.id, p) || {};
      (res.items || []).forEach(raw => {
        const n = _normGoogleEvent(raw, c.name, day, tz);
        const key = raw && (raw.iCalUID || raw.id);
        if (!n || (key && seen[key + '|' + n.s])) return;   // the same event on two calendars counts once
        if (key) seen[key + '|' + n.s] = true;
        events.push(n);
      });
      token = res.nextPageToken || null;
    } while (token && ++pages < 3);
  });
  events.sort((a, b) => (a.allDay === b.allDay ? a.s - b.s : (a.allDay ? -1 : 1)));
  return { events: events, calendars: cals.length };
}

const _blocksTime = ev => !ev.allDay && !ev.free && !ev.declined;

/** What is stored: windows and a count, never names. */
function _googleSnapshot(day, at, fetched) {
  return {
    date: day, at: at, enabled: true, error: '', calendars: fetched.calendars,
    busy: fetched.events.filter(_blocksTime).slice(0, GCAL_MAX_WINDOWS).map(ev => ({ start: _hm(ev.s), end: _hm(ev.e), src: 'Google' })),
    allDay: Math.min(20, fetched.events.filter(ev => ev.allDay).length)
  };
}

/** Never throws: a problem is recorded in the status and shown on the page. A failed refresh keeps today's earlier windows. */
function refreshGoogleCalendar() {
  const at = new Date().toISOString(), today = _today(), api = _calendarApi();
  let status;
  try {
    status = api ? _googleSnapshot(today, at, _fetchGoogleDay(api, today))
                 : { date: today, at: at, enabled: false, error: '', busy: [], allDay: 0, calendars: 0 };
  } catch (e) {
    const prev = getGoogleCalStatus();
    status = { date: today, at: at, enabled: !!api, error: _clip(e && e.message ? e.message : e, 200), calendars: 0,
      busy: prev.date === today ? prev.busy : [], allDay: prev.date === today ? prev.allDay : 0 };
  }
  try { setSetting(GCAL_KEY, JSON.stringify(status), 4000); } catch (_) { /* the status is only a courtesy */ }
  return status;
}

/** Main connection only: the day WITH event names, for the planner's combined printout on your computer. Nothing is stored. */
function getGoogleDay() {
  _needMaster();
  const today = _today(), api = _calendarApi();
  if (!api) return { date: today, enabled: false, error: '', calendars: [], events: [] };
  try {
    const f = _fetchGoogleDay(api, today);
    return { date: today, enabled: true, error: '', calendars: _calendarsToRead(api).map(c => c.name),
      events: f.events.map(ev => ({ subject: _clip(ev.subject, 120), calendar: _clip(ev.calendar, 40), allDay: ev.allDay,
        start: ev.allDay ? '' : _hm(ev.s), end: ev.allDay ? '' : _hm(ev.e), free: ev.free, declined: ev.declined, tentative: ev.tentative, online: ev.online })) };
  } catch (e) {
    return { date: today, enabled: true, error: _clip(e && e.message ? e.message : e, 200), calendars: [], events: [] };
  }
}

// ---- the day's shape: Outlook windows from the planner + Google windows from the calendar above ----

function _nowMinutes() { return _toMin(Utilities.formatDate(new Date(), _tzName(), 'HH:mm')); }

/** Open focus windows: gaps of `minFocus` or more inside the work day, from now on, between the booked windows. */
function _focusWindows(busy, ws, we, minFocus) {
  const iv = busy.map(w => [_toMin(w.start), _toMin(w.end)]).filter(x => x[0] != null && x[1] != null && x[1] > ws && x[0] < we)
    .map(x => [Math.max(x[0], ws), Math.min(x[1], we)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  iv.forEach(x => { if (merged.length && x[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x[1]); else merged.push(x.slice()); });
  const out = [];
  let cur = ws;
  merged.concat([[we, we]]).forEach(x => { if (x[0] - cur >= minFocus) out.push({ start: _hm(cur), end: _hm(x[0]), minutes: x[0] - cur }); cur = Math.max(cur, x[1]); });
  return out;
}

/**
 * The schedule Today's Look and the coach use. Outlook windows come from the planner (meta); Google windows from this script's own calendar
 * read. With no Google snapshot (the Calendar service is not on) it falls back to whatever the planner computed.
 */
function _scheduleFor(meta, gcal) {
  const today = _today();
  const plan = meta && meta.date === today ? meta : null;
  const usable = !!(gcal && gcal.enabled && gcal.date === today);
  const haveG = usable && (!gcal.error || (gcal.busy && gcal.busy.length > 0));   // a failed refresh still counts when it kept earlier windows
  const sources = {
    outlook: plan ? (plan.outlookKnown === false ? 'missing' : 'ok') : 'missing',
    google: gcal && gcal.enabled === false ? 'off' : (gcal && gcal.error ? 'error' : (haveG ? 'ok' : 'none'))
  };
  if (!haveG) {
    if (!plan) return null;
    return { busy: plan.busy || [], busyAll: plan.busy || [], focus: plan.focus || [], budget: plan.budget === undefined ? '' : plan.budget, allDay: plan.allDay || 0, sources: sources };
  }
  const st = Object.assign({}, WORK_DEFAULTS, (plan && plan.settings) || {});
  const now = _nowMinutes();
  const ws = Math.max(_toMin(st.workStart), now), we = _toMin(st.workEnd);
  const outlook = ((plan && plan.busy) || []).filter(w => w.src !== 'Google');   // the planner's own Google windows are replaced by ours
  const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const busyAll = outlook.concat(gcal.busy || []).sort(byStart);          // the whole day, for the calendar view
  const busy = busyAll.filter(w => _toMin(w.end) > now);                  // what is still ahead, for the coach
  const focus = _focusWindows(busy, ws, we, st.minFocus);
  const total = focus.reduce((s, w) => s + w.minutes, 0);
  return { busy: busy, busyAll: busyAll, focus: focus, budget: Math.round(total / 60 / st.hoursPerPoint * 10) / 10, allDay: gcal.allDay || 0, sources: sources };
}
