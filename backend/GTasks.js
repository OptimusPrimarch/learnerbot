// GTasks.js: Google Tasks that are due today (or overdue) go into the to-do list, each with a link back to the task.
//
// Read-only, and only the sheet owner's own tasks: the sheet's script reads them with its owner's Google account through the Tasks
// service. Google does not put tasks in a calendar's iCal link, which is why this is not part of the calendar feed.
//
// ONE-TIME SETUP, in the sheet: Extensions > Apps Script > Services (the + beside it) > Google Tasks API > Add. Then run anything in
// LearnerBot once and approve Google's permission screen. Until then this does nothing and the to-do card says so.
//
// A refresh runs with every planner feed (6 AM and 3 PM), at the 7 AM daily focus, and when Refresh Google on the To do card is pressed.

const GTASKS_KEY = 'gtasks_status';
const GTASKS_MAX = 40;

function _tasksApi() {
  try { return typeof Tasks !== 'undefined' && Tasks && Tasks.Tasks && Tasks.Tasklists ? Tasks : null; }
  catch (_) { return null; }
}

/** { enabled, at, count, error } from the last refresh, for the page. */
function getGoogleTasksStatus() {
  try {
    const s = JSON.parse(getSetting(GTASKS_KEY) || 'null');
    if (s && typeof s === 'object') return s;
  } catch (_) { /* fall through */ }
  return { enabled: _tasksApi() != null, at: '', count: 0, error: '' };
}

function _gtaskLinks(t) {
  const links = [{ u: t.webViewLink || 'https://tasks.google.com/', d: 'Open in Google Tasks' }];
  (Array.isArray(t.links) ? t.links : []).forEach(l => { if (l && l.link) links.push({ u: l.link, d: l.description || l.type || 'Linked item' }); });
  return _cleanLinks(links);
}

/** Open tasks with a due date of today or earlier, across the owner's task lists. Tasks with no due date are left out. */
function _fetchDueGoogleTasks(api, today) {
  const out = [];
  const lists = (api.Tasklists.list({ maxResults: 100 }) || {}).items || [];
  lists.forEach(l => {
    const res = api.Tasks.list(l.id, { showCompleted: false, showHidden: false, dueMax: today + 'T23:59:59.000Z', maxResults: 100 }) || {};
    (res.items || []).forEach(t => {
      if (!t || !t.title || !t.due || t.status === 'completed') return;
      const due = String(t.due).slice(0, 10);
      if (due > today) return;
      out.push({
        sourceId: _clip(t.id, 40), title: _clip(t.title, TODAY_TITLE_MAX), points: '', state: 'To do',
        flags: due < today ? 'OVERDUE' : 'DUE-TODAY', note: _clip(l.title, 40), links: _gtaskLinks(t), _due: due
      });
    });
  });
  out.sort((a, b) => (a._due < b._due ? -1 : a._due > b._due ? 1 : (a.title < b.title ? -1 : 1)));
  return out.slice(0, GTASKS_MAX);
}

/** Never throws: a problem is recorded in the status and shown on the page. Safe to call as often as needed. */
function refreshGoogleTasks() {
  const at = new Date().toISOString();
  const api = _tasksApi();
  let status;
  try {
    if (!api) {
      status = { enabled: false, at: at, count: 0, error: '' };
    } else {
      const today = _today();
      const items = _fetchDueGoogleTasks(api, today);
      status = { enabled: true, at: at, count: items.length, error: '' };
      withLock(() => {
        const r = _upsertItems(today, 'google-task', items, true);   // tasks finished in Google since the last refresh are closed here
        status.added = r.added; status.closed = r.closed;
      });
    }
  } catch (e) {
    status = { enabled: !!api, at: at, count: 0, error: _clip(e && e.message ? e.message : e, 200) };
  }
  try { setSetting(GTASKS_KEY, JSON.stringify(status), 600); } catch (_) { /* the status is only a courtesy */ }
  return status;
}
