'use strict';
// today.js: the Workday tab ("The Workday" on screen; Today is only its internal name). The day's work (sent each morning by the planner on the owner's computer, plus anything added by
// hand), each item optionally linked to a goal. Checking an item off asks how long it took and saves a log entry.
//
// Loaded after app.js and history.js and uses their helpers (STATE, fire, offerUndo, render, toast, esc, fmtMinutes, ...).
// Every change goes through fire(), so it is applied at once, kept in the queue when there is no signal, and never applied twice.

let TODAY_FINISHING = null;     // id of the task whose "how long did it take?" box is open
let TODAY_OPENER = '';          // id of the check button that opened it, to give focus back
let TODAY_STALE_LOAD = false;
let todayDayInit = false;       // "Your day" starts open; after that the person's open/closed choice is remembered like any panel   // a refresh because the page was left open past midnight is already on its way

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

function todayRow(it, carried) {
  const done = it.status === 'done', skipped = it.status === 'skipped';
  const id = esc(it.id);
  const meta = [];
  if (it.sourceId) meta.push(`<span class="pill">#${esc(it.sourceId)}</span>`);
  if (it.points != null) meta.push(`<span class="pill">${esc(it.points)} pt${it.points === 1 ? '' : 's'}</span>`);
  if (it.state) meta.push(`<span class="pill">${esc(it.state)}</span>`);
  arr(it.flags).forEach(f => meta.push(`<span class="pill ${flagClass(f)}">${esc(f)}</span>`));
  if (carried) meta.push(`<span class="pill medium">From ${esc(dayLabel(it.date))}</span>`);
  const check = `<button type="button" class="t-check${done ? ' on' : ''}" role="checkbox" aria-checked="${done}" data-act="${done ? 'todayReopen' : 'todayDone'}" data-id="${id}"
      aria-label="${done ? 'Done. Put back on the list: ' : 'Mark done: '}${esc(it.title)}"${skipped ? ' disabled' : ''}><span aria-hidden="true">${done ? '✓' : ''}</span></button>`;
  const goal = skipped || done
    ? (it.goalId ? `<div class="t-note muted">Goal: ${esc(goalTitle(it.goalId))}</div>` : '')
    : `<div class="t-goal"><label class="sr-only" for="tg_${id}">Goal for ${esc(it.title)}</label>
        <select id="tg_${id}" data-change="todayGoal" data-id="${id}">${goalOptions(it.goalId)}</select></div>`;
  const side = done
    ? `<span class="muted t-done">${it.minutes ? esc(fmtMinutes(it.minutes)) + ' logged' : 'Logged'}</span>`
    : skipped
      ? `<button type="button" class="ghost run" data-act="todayReopenSkipped" data-id="${id}" aria-label="Put back on the list: ${esc(it.title)}">Put back</button>`
      : `<button type="button" class="ghost run" data-act="todaySkip" data-id="${id}" aria-label="Skip for today: ${esc(it.title)}">Skip</button>`;
  return `<li class="t-row${done ? ' is-done' : ''}${skipped ? ' is-skipped' : ''}">
    ${check}
    <div class="t-main">
      <div class="t-title">${esc(it.title)}</div>
      ${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}
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

function todaySection(title, list, carried, open, key) {
  if (!list.length) return '';
  const rows = `<ul class="t-list">${list.map(i => todayRow(i, carried)).join('')}</ul>`;
  if (open === true) return `<section class="card wide t-sec" aria-label="${esc(title)}"><label class="head">${esc(title)} <span class="muted">(${list.length})</span></label>${rows}</section>`;
  return `<section class="card wide t-sec"><details data-key="${esc(key)}"${OPEN_DETAILS.has(key) ? ' open' : ''}><summary>${esc(title)} <span class="muted">(${list.length})</span></summary>${rows}</details></section>`;
}

function todayHead(t) {
  const items = arr(t.items);
  const done = items.filter(i => i.status === 'done');
  const live = items.filter(i => i.status !== 'skipped');
  const mins = done.reduce((s, i) => s + (i.minutes || 0), 0);
  const pct = live.length ? Math.round(done.length / live.length * 100) : 0;
  const f = t.feed;
  const bits = [];
  if (f && f.budget !== '' && f.budget != null) bits.push(`A realistic load is about ${esc(f.budget)} story points of work.`);
  const when = f && f.at ? new Date(f.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `<section class="card wide focus t-head" aria-label="The Workday at a glance">
    <div class="card-head"><label class="head">The Workday</label>
      <span class="chip${t.fresh ? ' ok' : ''}">${t.fresh ? 'Plan received' + (when ? ' ' + esc(when) : '') : 'No plan today'}</span></div>
    <h3>${esc(todayHeading(t.date))}</h3>
    <p role="status" aria-live="polite"><b>${done.length}</b> of <b>${live.length}</b> done${mins ? ' · ' + esc(fmtMinutes(mins)) + ' logged' : ''}</p>
    <div class="progress-bar t-bar" role="progressbar" aria-label="Tasks done today" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="progress-fill" style="width:${pct}%"></div></div>
    ${bits.length ? `<p class="muted" style="margin-top:10px;font-size:14px">${bits.join(' ')}</p>` : ''}
  </section>`;
}

/** The day's shape from the feed: booked windows (tagged Outlook or Google) and open focus windows, in time order. Names never arrive here. */
function todayDay(f) {
  if (!f) return '';
  const rows = [];
  arr(f.busy).forEach(w => rows.push({ start: w.start, end: w.end, kind: 'busy', src: w.src || '' }));
  arr(f.focus).forEach(w => rows.push({ start: w.start, end: w.end, kind: 'open', minutes: w.minutes }));
  if (!rows.length && !f.allDay) return '';
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.kind === 'busy' ? -1 : 1)));
  const key = 'today-day';
  if (!todayDayInit) { OPEN_DETAILS.add(key); todayDayInit = true; }
  const list = rows.map(r => `<li class="t-day-row ${r.kind}">
      <span class="t-time">${esc(hm12(r.start))} to ${esc(hm12(r.end))}</span>
      ${r.kind === 'open'
        ? `<span><span class="pill completed">Open focus</span> <span class="muted">${esc(fmtMinutes(r.minutes || 0))}</span></span>`
        : `<span><span class="pill">Booked</span>${r.src ? ` <span class="muted">${esc(r.src)}</span>` : ''}</span>`}
    </li>`).join('');
  const allDay = f.allDay ? `<p class="muted" style="margin-top:8px;font-size:14px">${esc(f.allDay)} all-day item${f.allDay === 1 ? '' : 's'} on your calendar (these do not take up time).</p>` : '';
  return `<section class="card wide t-sec" aria-label="Your day"><details data-key="${key}"${OPEN_DETAILS.has(key) ? ' open' : ''}>
    <summary>Your day, both calendars</summary>
    <ul class="t-day-list">${list || '<li class="muted">Nothing timed today.</li>'}</ul>${allDay}
    <p class="muted" style="margin-top:8px;font-size:12px">Event names stay on your computer; only times arrive here.</p>
  </details></section>`;
}

function todayObjectives(f) {
  if (!f || !arr(f.objectives).length) return '';
  const key = 'today-obj';
  return `<section class="card wide t-sec"><details data-key="${key}"${OPEN_DETAILS.has(key) ? ' open' : ''}>
    <summary>Team objectives <span class="muted">(${f.objectives.length})</span></summary>
    <ul class="plain">${f.objectives.map(o => `<li>${esc(o.name)} <span class="muted">· ${esc(o.progress)}%${o.due ? ', due ' + esc(o.due) : ''}</span>
      <div class="progress-bar" role="progressbar" aria-label="${esc(o.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(o.progress)}"><div class="progress-fill" style="width:${esc(o.progress)}%"></div></div></li>`).join('')}</ul>
  </details></section>`;
}

function renderToday() {
  const host = $('todayView');
  if (!host) return;
  const t = todayData();
  if (!todayAvailable()) {
    host.innerHTML = `<section class="card wide"><label class="head">The Workday</label>
      <p class="empty">${t ? 'Update your sheet to use this page.' : 'This page needs the newest version of your sheet\'s script. Press Update now in the yellow banner, or open Settings.'}</p></section>`;
    return;
  }
  if (t.date && t.date !== todayStr() && !TODAY_STALE_LOAD && Api.isConfigured() && !Api.isDemo()) {   // left open past midnight
    TODAY_STALE_LOAD = true;
    setTimeout(() => { TODAY_STALE_LOAD = false; load(); }, 0);
  }
  const items = arr(t.items), carried = arr(t.carried);
  const todo = items.filter(i => i.status === 'open');
  let html = todayHead(t) + todayDay(t.feed);
  if (!t.fresh) {
    html += `<div class="notice warn wide-notice" role="status"><div><b>No fresh plan arrived today.</b>
      <div class="muted">${t.feed && t.feed.date ? 'The last plan was for ' + esc(dayLabel(t.feed.date)) + '. ' : ''}Your coach plans from your goals alone until one arrives. You can still add tasks by hand below, and the planner can be run again from your computer.</div></div></div>`;
  }
  html += `<section class="card wide" aria-label="Add a task"><label class="head" for="todayTitle">Add a task</label>
    <div class="add-goal">
      <input id="todayTitle" class="g-title" type="text" maxlength="80" placeholder="e.g. Reply to the vendor" autocomplete="off" data-enter="todayAdd">
      <select id="todayGoalSel" aria-label="Link to a goal (optional)">${goalOptions('')}</select>
      <button type="button" data-act="todayAdd">Add</button>
    </div></section>`;
  html += todo.length
    ? todaySection('To do', todo, false, true, 'today-todo')
    : `<section class="card wide t-sec"><label class="head">To do</label><p class="empty">${items.length ? 'Everything on today\'s list is handled. Nice.' : 'Nothing on the list yet. Add a task above, or wait for the morning plan.'}</p></section>`;
  html += todaySection('Carried over', carried.filter(i => i.status === 'open'), true, true, 'today-carried');
  html += todaySection('Done', items.filter(i => i.status === 'done'), false, false, 'today-done');
  html += todaySection('Skipped', items.filter(i => i.status === 'skipped'), false, false, 'today-skipped');
  html += todayObjectives(t.feed);
  host.innerHTML = html;
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

function todayAskTime(id, opener) {
  const it = findToday(id);
  const dlg = $('doneDlg');
  if (!it || !dlg || typeof dlg.showModal !== 'function') { todayFinishNow(id, 0); return; }   // no dialog support: finish without a time
  TODAY_FINISHING = String(id);
  TODAY_OPENER = opener || String(id);
  $('doneTask').textContent = it.title;
  $('doneMins').value = '';
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
    const el = document.querySelector(`[data-act="todayDone"][data-id="${back}"]`) || document.querySelector('#todayView .t-check:not(.on)') || $('todayView');
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
  todayDone:   (d, el) => todayAskTime(d.id, d.id),
  todayReopen: d => todaySetStatus(d.id, 'open', 'Reopening', ''),   // no undo here: finishing again needs a time
  todaySkip:   d => todaySetStatus(d.id, 'skipped', 'Skipping', 'Skipped'),
  todayReopenSkipped: d => todaySetStatus(d.id, 'open', 'Putting back', ''),
  todayAdd:    () => todayAddNow(),
  donePreset:  d => { $('doneMins').value = d.v; syncDonePresets(); },
  doneSave:    () => { const id = TODAY_FINISHING; if (!id) return; const m = Number($('doneMins').value) || 0; const dlg = $('doneDlg'); TODAY_FINISHING = null; if (dlg.open) dlg.close(); todayFinishNow(id, m); todayCloseBox(); },
  doneCancel:  () => { TODAY_FINISHING = null; todayCloseBox(); }
});

buildDoneBox();
