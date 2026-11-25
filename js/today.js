'use strict';
// today.js: the to-do list. It lives in a card on the Goals Dashboard (collapsed until opened), just below Log Activity.
// The day's work (sent each morning by the planner on the owner's computer, Google Tasks, plus anything added by hand), each item
// optionally linked to a goal. Checking an item off asks how long it took and saves a log entry. Today's Look (todayslook.js) draws the
// day around the same items. "Today" is only the internal name of all this.
//
// Loaded after app.js and history.js and uses their helpers (STATE, fire, offerUndo, render, toast, esc, fmtMinutes, ...).
// Every change goes through fire(), so it is applied at once, kept in the queue when there is no signal, and never applied twice.

let TODAY_FINISHING = null;     // id of the task whose "how long did it take?" box is open
let TODAY_OPENER = '';          // id of the check button that opened it, to give focus back
let TODAY_STALE_LOAD = false;   // a refresh because the page was left open past midnight is already on its way

const todayData = () => (STATE && STATE.today && typeof STATE.today === 'object' ? STATE.today : null);
const todayAvailable = () => !!todayData() && !backendOutdated();
const todayItems = () => { const t = todayData(); return t ? arr(t.items).concat(arr(t.carried)) : []; };
const findToday = id => todayItems().find(x => x.id === String(id));

/** Applies a change to an item wherever it is held (today's list or the carried-over list). */
function patchToday(id, patch) {
  const t = todayData();
  if (!t) return;
  const fix = x => (x.id === String(id) ? { ...x, ...patch } : x);
  t.items = arr(t.items).map(fix);
  t.carried = arr(t.carried).map(fix);
}

/** A hand-added task got its real id from the sheet: later changes that named the temporary one now name the real one. */
function swapTodayItem(tmp, real) {
  if (!real || !real.id) return;
  bindId(tmp, real.id);
  const t = todayData();
  if (!t) return;
  t.items = arr(t.items).map(x => (x.id === tmp ? { ...real, status: x.status, goalId: x.goalId, minutes: x.minutes, doneOn: x.doneOn } : x));
}

const hm12 = hm => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return String(hm || '');
  const h = Number(m[1]);
  return (h % 12 || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
};
const span = w => hm12(w.start) + ' to ' + hm12(w.end);

function todayHeading(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return 'Today';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

const flagClass = f => (/^(BLOCKED|OVERDUE)/i.test(f) ? 'high' : 'medium');

function goalOptions(selected) {
  const goals = arr(STATE.goals).filter(g => g.status === 'active');
  return `<option value="">No goal (optional)</option>` + goals.map(g =>
    `<option value="${esc(g.id)}"${String(selected) === g.id ? ' selected' : ''}>${esc(snippet(g.title, 60))}</option>`).join('');
}

/** Links from Google only (the sheet checks them too, and this is a second look): https to a google.com address, nothing else. */
const safeHref = u => /^https:\/\/([a-z0-9-]+\.)*google\.com\/[^\s"<>]*$/i.test(String(u || ''));
const linkHtml = (l, text) => `<a class="t-link" href="${esc(l.u)}" target="_blank" rel="noopener noreferrer">${esc(text)}<span class="sr-only"> (opens in a new tab)</span></a>`;

function todayRow(it, carried) {
  const done = it.status === 'done', skipped = it.status === 'skipped', closed = it.status === 'closed';
  const isGT = it.source === 'google-task';
  const links = arr(it.links).filter(l => safeHref(l.u));
  const main = isGT && links.length ? links[0] : null;          // a Google Task's own link is its title
  const extra = links.slice(main ? 1 : 0);                      // anything it points at (an email, a document) sits underneath
  const titleHtml = main ? linkHtml(main, it.title) : esc(it.title);
  const linksHtml = extra.length ? `<div class="t-links">${extra.map(l => linkHtml(l, l.d || 'Linked item')).join('')}</div>` : '';
  const id = esc(it.id);
  const meta = [];
  if (isGT) meta.push(`<span class="pill gtask">Google Task</span>`);
  else if (it.sourceId) meta.push(`<span class="pill">#${esc(it.sourceId)}</span>`);
  if (it.points != null) meta.push(`<span class="pill">${esc(it.points)} pt${it.points === 1 ? '' : 's'}</span>`);
  if (it.state) meta.push(`<span class="pill">${esc(it.state)}</span>`);
  arr(it.flags).forEach(f => meta.push(`<span class="pill ${flagClass(f)}">${esc(f)}</span>`));
  if (carried) meta.push(`<span class="pill medium">From ${esc(dayLabel(it.date))}</span>`);
  if (it.start) meta.push(`<span class="pill completed">On your day ${esc(hm12(it.start))}</span>`);
  const check = `<button type="button" class="t-check${done ? ' on' : ''}" role="checkbox" aria-checked="${done}" data-act="${done ? 'todayReopen' : 'todayDone'}" data-id="${id}"
      aria-label="${done ? 'Done. Put back on the list: ' : 'Mark done: '}${esc(it.title)}"${skipped || closed ? ' disabled' : ''}><span aria-hidden="true">${done ? '✓' : ''}</span></button>`;
  const goal = skipped || done || closed
    ? (it.goalId ? `<div class="t-note muted">Goal: ${esc(goalTitle(it.goalId))}</div>` : '')
    : `<div class="t-goal"><label class="sr-only" for="tg_${id}">Goal for ${esc(it.title)}</label>
        <select id="tg_${id}" data-change="todayGoal" data-id="${id}">${goalOptions(it.goalId)}</select></div>`;
  const side = done
    ? `<span class="muted t-done">${it.minutes ? esc(fmtMinutes(it.minutes)) + ' logged' : 'Logged'}</span>`
    : skipped || closed
      ? `<button type="button" class="ghost run" data-act="todayReopenSkipped" data-id="${id}" aria-label="Put back on the list: ${esc(it.title)}">Put back</button>`
      : `<button type="button" class="ghost run" data-act="todaySkip" data-id="${id}" aria-label="Skip for today: ${esc(it.title)}">Skip</button>`;
  return `<li class="t-row${done ? ' is-done' : ''}${skipped ? ' is-skipped' : ''}${closed ? ' is-closed' : ''}">
    ${check}
    <div class="t-main">
      <div class="t-title">${titleHtml}</div>
      ${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}
      ${linksHtml}
      ${it.note ? `<div class="t-note muted">${esc(it.note)}</div>` : ''}
      ${goal}
    </div>
    <div class="t-side">${side}</div>
  </li>`;
}

function goalTitle(id) {
  const g = arr(STATE.goals).concat(arr(STATE.historyGoals)).find(x => x.id === String(id));
  return g ? snippet(g.title, 60) : 'a goal that is no longer active';
}

/** A folded list inside the to-do card (carried over, done, skipped, closed). */
function todoSub(title, list, carried, key) {
  if (!list.length) return '';
  return `<details class="t-sub" data-key="${esc(key)}"${OPEN_DETAILS.has(key) ? ' open' : ''}><summary>${esc(title)} <span class="muted">(${list.length})</span></summary>
    <ul class="t-list">${list.map(i => todayRow(i, carried)).join('')}</ul></details>`;
}

/** What the Google Tasks refresh found, or how to turn it on. */
function tasksNote(g) {
  if (!g) return '';
  const when = g.at ? new Date(g.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  if (g.error) {
    const perm = /author|permission|scope|access|consent/i.test(g.error);
    return `<p class="cfg-msg err" role="alert">Google Tasks could not be read: ${esc(g.error)}${perm ? ' In your sheet choose LearnerBot > Authorize Google (Calendar and Tasks) and approve the permission screen. Then, if it still fails, Deploy > Manage deployments > the pencil > New version > Deploy, and press Refresh Google.' : ''}</p>`;
  }
  if (!g.enabled) {
    const key = 'today-gt-help';
    return `<details class="t-help" data-key="${key}"${OPEN_DETAILS.has(key) ? ' open' : ''}><summary>Bring in your Google Tasks</summary>
      <ol class="t-steps"><li>In your sheet, open <b>Extensions → Apps Script</b>.</li>
        <li>Beside <b>Services</b>, press <b>+</b>, choose <b>Google Tasks API</b>, then <b>Add</b>.</li>
        <li>Come back here and press <b>Refresh Google</b>. Google asks you to approve it once.</li></ol>
      <p class="muted">Tasks due today or overdue then appear in this list, each with a link back to the task. Nothing is changed in Google Tasks.</p></details>`;
  }
  return `<p class="muted t-gt-sum" role="status">${g.count ? esc(g.count) + ' Google Task' + (g.count === 1 ? '' : 's') + ' due today or overdue' : 'No Google Tasks due today'}${when ? ' · checked ' + esc(when) : ''}</p>`;
}

/** The page was left open past midnight: fetch the new day once. */
function todayStaleCheck(t) {
  if (t.date && t.date !== todayStr() && !TODAY_STALE_LOAD && Api.isConfigured() && !Api.isDemo()) {
    TODAY_STALE_LOAD = true;
    setTimeout(() => { TODAY_STALE_LOAD = false; load(); }, 0);
  }
}

/**
 * The to-do card for the Goals Dashboard: a folded card (open or shut as the person left it) with Add a task, the Google refresh, the open list
 * and the finished, skipped and closed ones underneath. Returns null when the sheet's script is too old to have a to-do list.
 */
function todoCard() {
  const t = todayData();
  if (!t || !todayAvailable()) return null;
  todayStaleCheck(t);
  const mine = i => i.source !== 'focus' && i.source !== 'focus-action';
  const items = arr(t.items).filter(mine), carried = arr(t.carried).filter(mine);
  const todo = items.filter(i => i.status === 'open');
  const carriedOpen = carried.filter(i => i.status === 'open');
  const g = t.tasks;
  const key = 'todo-card';
  const body = todo.length
    ? `<ul class="t-list">${todo.map(i => todayRow(i, false)).join('')}</ul>`
    : `<p class="empty">${items.length ? 'Everything on today\'s list is handled. Nice.' : 'Nothing on the list yet. Add a task above, or wait for the morning plan.'}</p>`;
  const d = div('card wide t-sec needs-new');
  d.setAttribute('aria-label', 'To do');
  d.innerHTML = `<details data-key="${key}"${OPEN_DETAILS.has(key) ? ' open' : ''}>
    <summary>To do <span class="muted">(${todo.length} open${carriedOpen.length ? ' · ' + carriedOpen.length + ' carried over' : ''})</span></summary>
    ${t.fresh ? '' : `<p class="muted" style="font-size:14px;margin:6px 0">No planner plan arrived today. Your own tasks and Google Tasks still show here.</p>`}
    <div class="add-goal" style="margin:8px 0">
      <label class="sr-only" for="todayTitle">Add a task</label>
      <input id="todayTitle" class="g-title" type="text" maxlength="80" placeholder="Add a task, e.g. Reply to the vendor" autocomplete="off" data-enter="todayAdd">
      <select id="todayGoalSel" aria-label="Link to a goal (optional)">${goalOptions('')}</select>
      <button type="button" data-act="todayAdd">Add</button>
    </div>
    <div class="card-head" style="margin:6px 0 4px"><span class="muted" style="font-size:13px">Google Tasks and Calendar</span>
      ${g ? '<button type="button" class="ghost run" id="gtRefresh" data-act="todayRefreshTasks">Refresh Google</button>' : ''}</div>
    ${tasksNote(g)}
    ${body}
    ${todoSub('Carried over', carriedOpen, true, 'today-carried')}
    ${todoSub('Done', items.filter(i => i.status === 'done'), false, 'today-done')}
    ${todoSub('Skipped', items.filter(i => i.status === 'skipped'), false, 'today-skipped')}
    ${todoSub('Closed since the last refresh', items.filter(i => i.status === 'closed'), false, 'today-closed')}
  </details>`;
  return d;
}

// ---- Automatic refresh, in the Settings dialog ----

/** Fills the Automatic refresh section of Settings: the sheet refreshes Google Tasks and Calendar by itself on weekdays, with no computer needed. */
function renderAutoBox() {
  const body = $('autoBody'), pill = $('autoPill');
  if (!body) return;
  const t = todayData(), s = t && t.schedule;
  if (pill) { pill.textContent = s && s.canSchedule ? (s.enabled ? 'On' : 'Off') : ''; pill.className = 'pill' + (s && s.enabled ? ' completed' : ''); pill.hidden = !(s && s.canSchedule); }
  if (!s) {
    body.innerHTML = `<p class="muted" style="margin:6px 0">${Api.isConfigured() || Api.isDemo() ? 'Update your sheet\'s script to use this (press Update now in the yellow banner).' : 'Connect first, then you can choose when your sheet refreshes your Google Tasks and Calendar.'}</p>`;
    return;
  }
  if (!s.canSchedule) {
    body.innerHTML = `<p class="muted" style="margin:6px 0">Refreshing Google Tasks and Calendar by itself (even with your computer off) needs a one-time paste of the newest <b>Code.gs</b> into your sheet,
      because the timer is part of that file. <a href="update.html">The update page explains how</a>; it takes about two minutes and nothing else changes.</p>`;
    return;
  }
  const opts = h => Array.from({ length: 24 }, (_, i) => `<option value="${i}"${i === h ? ' selected' : ''}>${esc(hourLabel(i))}</option>`).join('');
  const [a, b] = [s.hours[0], s.hours[1] != null ? s.hours[1] : s.hours[0]];
  body.innerHTML = `<p class="muted" style="margin:6px 0 8px">Your sheet refreshes your Google Tasks and Google Calendar by itself on weekdays, even when your computer is off. Outlook, work items and WAYD still come from the planner on your computer.</p>
    <div class="notify-row"><label><input type="checkbox" id="autoOn"${s.enabled ? ' checked' : ''}> Refresh automatically on weekdays</label>
      <select id="autoH1" aria-label="First refresh time">${opts(a)}</select>
      <select id="autoH2" aria-label="Second refresh time">${opts(b)}</select></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Times are in ${esc(s.tz || 'your time zone')} and can be up to about 15 minutes late. Choose the same time twice for one refresh a day.</p>
    <div class="row"><button type="button" data-act="todaySaveAuto">Save</button></div>
    <p id="autoMsg" class="cfg-msg" role="status"></p>`;
}

// ---- changes --------------------------------------------------

function todayAddNow() {
  const t = todayData();
  if (!t) return;
  const title = val('todayTitle'), goalId = val('todayGoalSel');
  if (!title) return;
  clearFields('todayTitle');
  const ref = Queue.newRef(), tmp = 'tmp_' + ref;
  const item = { id: tmp, date: t.date || todayStr(), title: title.slice(0, 80), source: 'me', sourceId: '', points: null, state: '', goalId: goalId ? resolveId(goalId) : '',
    flags: [], status: 'open', doneOn: '', minutes: 0, logId: '', note: '' };
  const args = { title };
  if (goalId) args.goalId = String(goalId);
  fire('Saving', 'addTodayTask', args, { ref, tmp, optimistic: () => { t.items = arr(t.items).concat(item); }, what: item.title,
    onFail: () => { if ($('todayTitle') && !$('todayTitle').value) $('todayTitle').value = title; } });
}

function todayLinkGoal(id, goalId) {
  const it = findToday(id);
  if (!it) return;
  const before = it.goalId;
  fire('Saving', 'setTodayGoal', { id: String(id), goalId: goalId || '' },
    { optimistic: () => patchToday(id, { goalId: goalId || '' }), what: it.title, onFail: () => { patchToday(id, { goalId: before }); if (STATE) render(); } });
}

function todaySetStatus(id, status, label, verb) {
  const it = findToday(id);
  if (!it) return;
  const before = { status: it.status, minutes: it.minutes, doneOn: it.doneOn };
  const wasDone = it.status === 'done';
  fire(label, 'setTodayStatus', { id: String(id), status }, {
    optimistic: () => {
      patchToday(id, { status, minutes: 0, doneOn: status === 'skipped' ? todayStr() : '' });
      if (wasDone && STATE && before.minutes) STATE.weekMinutes = Math.max(0, (STATE.weekMinutes || 0) - before.minutes);
    },
    onOk: res => {
      if (res && res.task) patchToday(res.task.id, res.task);
      if (res && res.weekMinutes != null && STATE) { STATE.weekMinutes = res.weekMinutes; updateWeekChip(res.weekMinutes); }
      if (res && res.streak != null && STATE) { STATE.streak = res.streak; updateStreak(res.streak); }
      if (typeof invalidateLog === 'function') invalidateLog();
    },
    onFail: () => { patchToday(id, before); if (STATE) render(); },
    what: it.title
  });
  if (verb) offerUndo(`${verb} “${snippet(it.title, 36)}”`, () => todaySetStatus(id, before.status === 'done' ? 'open' : before.status, 'Undoing', ''));
}

/** Saves the completion and its log entry. `minutes` is 0 when the person did not say how long it took. */
function todayFinishNow(id, minutes) {
  const it = findToday(id);
  if (!it || it.status === 'done') return;
  const before = { status: it.status, minutes: it.minutes, doneOn: it.doneOn };
  const args = { id: String(id) };
  if (minutes) args.minutes = minutes;
  fire('Saving', 'completeTodayTask', args, {
    optimistic: () => {
      patchToday(id, { status: 'done', minutes: minutes || 0, doneOn: todayStr() });
      if (minutes && STATE) STATE.weekMinutes = (STATE.weekMinutes || 0) + minutes;
    },
    onOk: res => {
      if (res && res.task) patchToday(res.task.id, res.task);
      if (res && res.streak != null && STATE) { STATE.streak = res.streak; updateStreak(res.streak); }
      if (res && res.weekMinutes != null && STATE) { STATE.weekMinutes = res.weekMinutes; updateWeekChip(res.weekMinutes); }
      if (res && res.entry && typeof logAdded === 'function') logAdded(res.entry);
      if (typeof invalidateLog === 'function') invalidateLog();
    },
    onFail: () => {
      patchToday(id, before);
      if (minutes && STATE) STATE.weekMinutes = Math.max(0, (STATE.weekMinutes || 0) - minutes);
    },
    what: it.title
  });
  offerUndo(`Logged “${snippet(it.title, 36)}”${minutes ? ' · ' + fmtMinutes(minutes) : ''}`, () => todaySetStatus(id, 'open', 'Undoing', ''));
}

// ---- the "how long did it take?" box --------------------------

/** What a row is called in the box: a focus block has no title of its own, so it is named by its tags. */
const todayLabel = it => (it.source === 'focus' ? 'Focus block' + (arr(it.tags).length ? ' (' + it.tags.join(', ') + ')' : '') : it.title);

function todayAskTime(id, opener, preset) {
  const it = findToday(id);
  const dlg = $('doneDlg');
  if (!it || !dlg || typeof dlg.showModal !== 'function') { todayFinishNow(id, 0); return; }   // no dialog support: finish without a time
  TODAY_FINISHING = String(id);
  TODAY_OPENER = opener || String(id);
  $('doneTask').textContent = todayLabel(it);
  $('doneMins').value = preset && MINUTE_STEPS.indexOf(preset) >= 0 ? String(preset) : '';
  syncDonePresets();
  dlg.showModal();
  $('doneMins').focus();
}

function syncDonePresets() {
  const v = $('doneMins').value;
  document.querySelectorAll('#donePresets button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
}

function todayCloseBox() {
  const dlg = $('doneDlg');
  if (dlg && dlg.open) dlg.close();
  const back = TODAY_OPENER;
  TODAY_FINISHING = null; TODAY_OPENER = '';
  // Give focus back: to the same row if it is still on the list, else to the list's heading.
  setTimeout(() => {
    const el = document.querySelector(`[data-act="todayDone"][data-id="${back}"]`) || document.querySelector('.t-check:not(.on)') || $('mainGrid');
    if (el && el.focus) { if (el === $('todayView')) el.setAttribute('tabindex', '-1'); el.focus(); }
  }, 0);
}

function buildDoneBox() {
  const sel = $('doneMins');
  if (!sel || sel.options.length > 1) return;
  sel.innerHTML = `<option value="">I'm not sure (skip the time)</option>` + MINUTE_STEPS.map(m => `<option value="${m}">${fmtMinutes(m)}</option>`).join('');
  $('donePresets').innerHTML = [15, 30, 45, 60, 90, 120].map(m => `<button type="button" class="ghost" data-act="donePreset" data-v="${m}" aria-pressed="false">${fmtMinutes(m)}</button>`).join('');
  sel.addEventListener('change', syncDonePresets);
  sel.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); HANDLERS.doneSave(); } });
  // Escape (or any other way the box closes without saving) leaves the task alone and gives focus back.
  $('doneDlg').addEventListener('close', () => { if (TODAY_FINISHING) todayCloseBox(); });
}

document.addEventListener('change', e => {
  const el = e.target && e.target.closest && e.target.closest('[data-change="todayGoal"]');
  if (el) todayLinkGoal(el.dataset.id, el.value);
});

Object.assign(HANDLERS, {
  todayDone:   (d, el) => todayAskTime(d.id, d.id, Number(d.preset) || 0),
  todayReopen: d => todaySetStatus(d.id, 'open', 'Reopening', ''),   // no undo here: finishing again needs a time
  todaySkip:   d => todaySetStatus(d.id, 'skipped', 'Skipping', 'Skipped'),
  todayReopenSkipped: d => todaySetStatus(d.id, 'open', 'Putting back', ''),
  todayAdd:    () => todayAddNow(),
  todaySaveAuto: () => {
    const msg = (text, kind) => { const m = $('autoMsg'); if (m) { m.textContent = text || ''; m.className = 'cfg-msg' + (kind ? ' ' + kind : ''); } };
    const hours = Array.from(new Set([Number($('autoH1').value), Number($('autoH2').value)])).sort((x, y) => x - y);
    const enabled = $('autoOn').checked;
    msg('Saving …');
    request('Saving', 'saveWorkdaySchedule', { enabled, hours })
      .then(({ res }) => {
        if (STATE && STATE.today && res.schedule) STATE.today.schedule = res.schedule;
        settle();
        renderAutoBox();
        msg(enabled ? 'On. Your sheet will refresh at ' + res.schedule.hours.map(hourLabel).join(' and ') + ' on weekdays.' : 'Off.', 'ok');
      })
      .catch(err => { msg(err.message, 'err'); if (isAuthError(err)) fail(err); });
  },
  todayRefreshTasks: () => {   // "Refresh Google": Google Tasks and Google Calendar together
    const b = $('gtRefresh');
    if (b) b.disabled = true;
    request('Refreshing Google', 'refreshGoogle')
      .then(({ res, latest }) => {
        if (latest && STATE && res.view) STATE.today = res.view; else needsResync = true;   // newer local changes are still going out
        settle();
        const errs = [res.tasks && res.tasks.error, res.calendar && res.calendar.error].filter(Boolean);
        const anyOn = (res.tasks && res.tasks.enabled) || (res.calendar && res.calendar.enabled);
        toast(errs.length ? 'Google: ' + errs.join(' · ') : (anyOn ? 'Google Tasks and Calendar refreshed.' : 'Google is not turned on in your sheet yet. The steps are on this page.'), errs.length ? 'error' : '');
      })
      .catch(err => fail(err))
      .finally(() => { const b2 = $('gtRefresh'); if (b2) b2.disabled = false; });
  },
  donePreset:  d => { $('doneMins').value = d.v; syncDonePresets(); },
  doneSave:    () => { const id = TODAY_FINISHING; if (!id) return; const m = Number($('doneMins').value) || 0; const dlg = $('doneDlg'); TODAY_FINISHING = null; if (dlg.open) dlg.close(); todayFinishNow(id, m); todayCloseBox(); },
  doneCancel:  () => { TODAY_FINISHING = null; todayCloseBox(); }
});

buildDoneBox();
