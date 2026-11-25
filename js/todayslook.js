'use strict';
// todayslook.js: the Today's Look tab. The day from 8 AM to 8 PM drawn from both calendars (booked time on the left, the person's own plan
// on the right), the coach's assessment and focus above it, and a Quick schedule underneath: the bullets of today's focus, then the rest of the
// to-do list, each with a time picker that puts it on the day. A 30-minute Focus block never leaves the list: it is for work or learning that
// is not already on the list or the calendar, and its tags say what each block is for. Focus blocks that cover exactly the same time merge.
//
// Loaded after today.js (it shares todayData, findToday, hm12 and the finish box). Placing things is saved in the sheet at once; unlike the
// to-do list it needs a connection, because the sheet checks every time against the bookings and answers with the whole day.

const LK_START = 8 * 60, LK_END = 20 * 60, LK_PX = 1.2;     // the day shown, and pixels per minute
const LK_LENS = Array.from({ length: 16 }, (_, i) => (i + 1) * 15);
let LOOK = null;                                             // what the place/change box is open for

const lkMin = hm => { const m = /^(\d{2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const lkHm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
const lkTime = n => hm12(lkHm(n));
const lkLocalYmd = v => {
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const lkIsBlock = i => i.source === 'focus' || i.source === 'focus-action';
const lkTop = m => Math.round((m - LK_START) * LK_PX);

/** How long an item is given when it is placed: its points (two per hour-ish) for work items, half an hour otherwise. */
function lkDefaultLen(it) {
  if (it && it.kind === 'todo' && it.points != null) return Math.max(15, Math.min(120, Math.round(it.points * 2) * 15));
  return 30;
}

/** Everything the page needs to know about the day: what is placed, what is left to place, and which bullets belong to today's focus. */
function lkModel(t) {
  const items = arr(t.items), carried = arr(t.carried);
  const placed = items.filter(i => i.start && i.dur && i.status !== 'skipped' && i.status !== 'closed');
  const rp = STATE && STATE.dailyReport;
  const rep = rp && rp.data && lkLocalYmd(rp.date) === t.date ? rp.data : null;       // only today's focus counts as today's focus
  const covered = new Set(rep ? arr(rep.covered) : []);
  const actRows = items.filter(i => i.source === 'focus-action');
  const bullets = rep ? arr(rep.actions).map(x => String(x).trim()).filter(Boolean) : [];
  const bulletsLeft = bullets.filter(b => !actRows.some(r => r.title === b.slice(0, 80)));
  const open = items.concat(carried).filter(i => !lkIsBlock(i) && i.status === 'open' && !i.start);
  return { items, placed, rep, bullets, bulletsLeft, openAll: open, todoLeft: open.filter(i => !covered.has('t' + i.id)), coveredCount: open.filter(i => covered.has('t' + i.id)).length };
}

/** Time already taken: the bookings from both calendars and everything the person has placed (except one block, when it is the one being moved). */
function lkTaken(t, exceptId) {
  const out = [];
  arr(t.busy).forEach(w => { const s = lkMin(w.start), e = lkMin(w.end); if (s != null && e != null && e > s) out.push([s, e]); });
  arr(t.items).forEach(i => {
    if (!i.start || !i.dur || i.id === String(exceptId) || i.status === 'skipped' || i.status === 'closed') return;
    const s = lkMin(i.start);
    out.push([s, s + i.dur]);
  });
  return out;
}
const lkFits = (taken, s, len) => s >= LK_START && s + len <= LK_END && !taken.some(x => s < x[1] && x[0] < s + len);

/** Start times that work for a block of `len` minutes: every half hour, plus right after each booking, and nothing already past. */
function lkStarts(t, len, exceptId) {
  const taken = lkTaken(t, exceptId);
  const now = t.date === todayStr() ? new Date().getHours() * 60 + new Date().getMinutes() : 0;
  const cand = new Set();
  for (let s = LK_START; s < LK_END; s += 30) cand.add(s);
  taken.forEach(x => { if (x[1] % 5 === 0) cand.add(x[1]); });
  return Array.from(cand).sort((a, b) => a - b).filter(s => s + 30 > now && lkFits(taken, s, len)).slice(0, 24);
}

// ---- drawing ------------------------------------------------------

function lkNotes(t) {
  const f = t.feed, cal = t.calendar, src = (f && f.sources) || {};
  const notes = [];
  if (cal && cal.error) {
    const perm = /author|permission|scope|access|consent/i.test(cal.error);
    notes.push(`<p class="cfg-msg err" role="alert">Google Calendar could not be read: ${esc(cal.error)}${perm ? ' In your sheet choose LearnerBot > Authorize Google (Calendar and Tasks) and approve the permission screen. Then, if it still fails, Deploy > Manage deployments > the pencil > New version > Deploy, and press Refresh Google on the To do card.' : ''}</p>`);
  } else if (cal && cal.enabled === false) {
    const hk = 'today-gcal-help';
    notes.push(`<details class="t-help" data-key="${hk}"${OPEN_DETAILS.has(hk) ? ' open' : ''}><summary>Bring in your Google Calendar</summary>
      <ol class="t-steps"><li>In your sheet, open <b>Extensions → Apps Script</b>.</li>
        <li>Beside <b>Services</b>, press <b>+</b>, choose <b>Google Calendar API</b>, then <b>Add</b>.</li>
        <li>On the Goals Dashboard open <b>To do</b> and press <b>Refresh Google</b>. Google asks you to approve it once.</li></ol>
      <p class="muted">Your main calendar and any you have ticked are read. Nothing is changed in Google Calendar, and event names stay in Google.</p></details>`);
  }
  if (src.outlook === 'missing' && arr(t.busy).length) {
    notes.push(`<p class="muted" style="font-size:14px">Your Outlook calendar has not arrived today, so only Google bookings are shown until the planner runs.</p>`);
  }
  return notes.join('');
}

function lkHead(t, m) {
  const items = arr(t.items).filter(i => !lkIsBlock(i));
  const done = items.filter(i => i.status === 'done');
  const live = items.filter(i => i.status !== 'skipped' && i.status !== 'closed');
  const mins = arr(t.items).filter(i => i.status === 'done').reduce((s, i) => s + (i.minutes || 0), 0);
  const f = t.feed;
  const when = f && f.at ? new Date(f.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const r = m.rep;
  const focus = r
    ? `<h3>${esc(r.focus)}</h3>${r.assessment ? `<p class="assess">${esc(r.assessment)}</p>` : ''}${r.reason ? `<p class="muted" style="font-size:14px;margin-top:6px">${esc(r.reason)}</p>` : ''}`
    : `<p class="muted">No daily focus for today yet. Press <em>Run daily</em> and your coach will weigh your to-do list against your goals.</p>`;
  const load = f && f.budget !== '' && f.budget != null ? `<p class="muted" style="margin-top:8px;font-size:14px">A realistic load is about ${esc(f.budget)} story points of work.</p>` : '';
  return `<section class="card wide focus t-head" aria-label="Today's Look at a glance">
    <div class="card-head"><label class="head">Today's Look · ${esc(todayHeading(t.date))}</label>
      <span class="row" style="margin:0;gap:8px;align-items:center"><span class="chip${t.fresh ? ' ok' : ''}">${t.fresh ? 'Plan received' + (when ? ' ' + esc(when) : '') : 'No plan today'}</span>
      <button class="ghost run" data-act="runDaily">Run daily</button></span></div>
    ${focus}
    <p role="status" aria-live="polite" style="margin-top:8px"><b>${done.length}</b> of <b>${live.length}</b> to-do items done${mins ? ' · ' + esc(fmtMinutes(mins)) + ' logged' : ''}</p>
    ${load}
  </section>`;
}

function lkBlockLabel(i) {
  if (i.source === 'focus') return 'Focus' + (arr(i.tags).length ? ' · ' + i.tags.join(', ') : '');
  return i.title;
}

function lkCalendar(t, m) {
  const hours = [];
  for (let h = LK_START / 60; h <= LK_END / 60; h++) hours.push(`<div class="lk-hr" style="top:${lkTop(h * 60)}px"><span>${esc(hourLabel(h).replace(':00', ''))}</span></div>`);
  const clip = (s, e) => [Math.max(s, LK_START), Math.min(e, LK_END)];
  const booked = arr(t.busy).map(w => {
    const [s, e] = clip(lkMin(w.start), lkMin(w.end));
    if (!(e > s)) return '';
    const h = Math.max(16, Math.round((e - s) * LK_PX) - 2);
    return `<div class="lk-booked-blk" style="top:${lkTop(s)}px;height:${h}px"><b>Booked</b>${w.src ? ' <span>' + esc(w.src) + '</span>' : ''}<small>${esc(lkTime(lkMin(w.start)))} to ${esc(lkTime(lkMin(w.end)))}</small></div>`;
  }).join('');
  const taken = lkTaken(t);
  const now = t.date === todayStr() ? new Date().getHours() * 60 + new Date().getMinutes() : -1;
  let slots = '';
  for (let s = LK_START; s < LK_END; s += 30) {
    if (s + 30 <= now || !lkFits(taken, s, 30)) continue;
    slots += `<button type="button" class="lk-slot" style="top:${lkTop(s)}px;height:${Math.round(30 * LK_PX) - 2}px" data-act="lookSlot" data-start="${lkHm(s)}" tabindex="-1" aria-label="Free at ${esc(lkTime(s))}. Place something here"><span aria-hidden="true">+</span></button>`;
  }
  const blocks = m.placed.map(i => {
    const s = lkMin(i.start), e = s + i.dur;
    const h = Math.max(20, Math.round(i.dur * LK_PX) - 2);
    const kind = i.source === 'focus' ? 'k-focus' : (i.source === 'focus-action' ? 'k-action' : 'k-todo');
    const done = i.status === 'done';
    return `<button type="button" class="lk-blk ${kind}${done ? ' is-done' : ''}" style="top:${lkTop(s)}px;height:${h}px" data-act="lookBlock" data-id="${esc(i.id)}"
        aria-label="${esc(lkBlockLabel(i))}, ${esc(lkTime(s))} to ${esc(lkTime(e))}${done ? ', done' : ''}. Press to change">
      <b>${done ? '✓ ' : ''}${esc(lkBlockLabel(i))}</b><small>${esc(lkTime(s))} to ${esc(lkTime(e))}</small></button>`;
  }).join('');
  const nowLine = now >= LK_START && now <= LK_END ? `<div class="lk-now" style="top:${lkTop(now)}px" aria-hidden="true"></div>` : '';
  const allDay = t.feed && t.feed.allDay ? `<p class="muted" style="margin-top:8px;font-size:13px">${esc(t.feed.allDay)} all-day item${t.feed.allDay === 1 ? '' : 's'} on your calendar (they do not take up time here).</p>` : '';
  return `<section class="card wide t-sec" aria-label="Your day from 8 AM to 8 PM">
    <div class="card-head"><label class="head">Your day, 8 AM to 8 PM</label></div>
    ${lkNotes(t)}
    <div class="lk-legend muted"><span><i class="lk-key bk"></i>Booked (Outlook and Google)</span><span><i class="lk-key mine"></i>Your plan</span>
      <span class="lk-tip">Tap an empty time to place something, or tap a block to change it. Keyboard: use Quick schedule below.</span></div>
    <div class="lk-cal" style="height:${Math.round((LK_END - LK_START) * LK_PX)}px">
      ${hours.join('')}
      <div class="lk-lane lk-booked">${booked}</div>
      <div class="lk-lane lk-mine">${slots}${blocks}</div>
      ${nowLine}
    </div>
    ${allDay}
    <p class="muted" style="margin-top:8px;font-size:12px">Event names stay in your Google and Outlook accounts; only times are kept here. Nothing you place is added to either calendar.</p>
  </section>`;
}

/** The little time picker beside an item: "Next open slot" first, then every start that fits. */
function lkPicker(t, kind, len, attrs) {
  const starts = lkStarts(t, len);
  const label = attrs.label;
  if (!starts.length) return `<select class="lk-pick" disabled aria-label="${esc(label)}"><option>No open time long enough</option></select>`;
  return `<select class="lk-pick" data-change="lookPlace" data-kind="${kind}" ${attrs.data} data-next="${lkHm(starts[0])}" aria-label="${esc(label)}">
    <option value="">Schedule …</option><option value="next">Next open slot (${esc(lkTime(starts[0]))})</option>
    ${starts.map(s => `<option value="${lkHm(s)}">${esc(lkTime(s))}</option>`).join('')}</select>`;
}

function lkQuick(t, m) {
  const tagHints = arr(t.tagHints);
  const row = (title, metaHtml, picker) => `<li class="lk-item"><div class="lk-main"><div class="t-title">${title}</div>${metaHtml ? `<div class="t-meta">${metaHtml}</div>` : ''}</div>${picker}</li>`;
  const focusRow = `<li class="lk-item lk-focusrow"><div class="lk-main"><div class="t-title">Focus block <span class="pill">30 min</span></div>
      <div class="t-meta muted">For work or learning that is not already on your list or calendar. It stays here after you place it, so you can add as many as you like.</div>
      <label class="sr-only" for="lookFocusTags">Tags for the new focus block (optional)</label>
      <input id="lookFocusTags" type="text" maxlength="60" list="lookTagList2" autocomplete="off" placeholder="Tags (optional), e.g. SQL, READING">
      <datalist id="lookTagList2">${tagHints.map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
    ${lkPicker(t, 'focus', 30, { label: 'Time for a new focus block', data: '' })}</li>`;
  const bullets = m.bulletsLeft.map((b, i) => row(esc(b), '<span class="pill">From today\'s focus</span> <span class="pill">30 min</span>',
    lkPicker(t, 'action', 30, { label: 'Time for: ' + b, data: `data-i="${i}"` }))).join('');
  const todos = m.todoLeft.map(it => {
    const len = lkDefaultLen({ kind: 'todo', points: it.points });
    const meta = [it.source === 'google-task' ? '<span class="pill gtask">Google Task</span>' : (it.sourceId ? `<span class="pill">#${esc(it.sourceId)}</span>` : ''),
      it.points != null ? `<span class="pill">${esc(it.points)} pt${it.points === 1 ? '' : 's'}</span>` : '', `<span class="pill">${esc(fmtMinutes(len))}</span>`,
      it.date < t.date ? `<span class="pill medium">From ${esc(dayLabel(it.date))}</span>` : ''].filter(Boolean).join('');
    return row(esc(it.title), meta, lkPicker(t, 'todo', len, { label: 'Time for: ' + it.title, data: `data-id="${esc(it.id)}"` }));
  }).join('');
  const placedCount = m.placed.length;
  return `<section class="card wide t-sec" aria-label="Quick schedule">
    <div class="card-head"><label class="head">Quick schedule</label><span class="muted" style="font-size:13px">${placedCount} on your day</span></div>
    <ul class="lk-list">${focusRow}</ul>
    ${m.rep ? `<h4 class="lk-sub">From today's focus</h4>${bullets ? `<ul class="lk-list">${bullets}</ul>` : '<p class="muted" style="font-size:14px">All of today\'s focus is on your day.</p>'}`
            : `<p class="muted" style="font-size:14px;margin-top:10px">Run daily to get bullets from your coach to place here.</p>`}
    <h4 class="lk-sub">Rest of your to-do list${m.coveredCount ? ` <span class="muted">(${m.coveredCount} more ${m.coveredCount === 1 ? 'is' : 'are'} covered by today's focus)</span>` : ''}</h4>
    ${todos ? `<ul class="lk-list">${todos}</ul>` : `<p class="muted" style="font-size:14px">${m.openAll.length || arr(t.items).some(i => !lkIsBlock(i)) ? 'Nothing else left to place. Nice.' : 'Your to-do list is empty. Add tasks on the Goals Dashboard.'}</p>`}
  </section>`;
}

// Show or minimize the team objectives. The choice is remembered on this device (a phone and a computer can differ);
// before one is made they stay minimized, as they always have.
const OBJ_PREF_KEY = 'learnerbot.workday.objectives';
let objShownVisit = false;   // used when this browser will not store anything
function objShown() {
  try { const v = localStorage.getItem(OBJ_PREF_KEY); return v ? v === 'show' : objShownVisit; } catch (_) { return objShownVisit; }
}
function setObjShown(on) {
  objShownVisit = on;
  try { localStorage.setItem(OBJ_PREF_KEY, on ? 'show' : 'min'); } catch (_) { /* kept for this visit only */ }
}

function lkObjectives(f) {
  const list = f ? arr(f.objectives) : [];
  if (!list.length) return '';
  const shown = objShown();
  const avg = Math.round(list.reduce((s, o) => s + (Number(o.progress) || 0), 0) / list.length);
  const body = shown
    ? `<ul class="plain" id="objList">${list.map(o => `<li>${esc(o.name)} <span class="muted">· ${esc(o.progress)}%${o.due ? ', due ' + esc(o.due) : ''}</span>
        <div class="progress-bar" role="progressbar" aria-label="${esc(o.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(o.progress)}"><div class="progress-fill" style="width:${esc(o.progress)}%"></div></div></li>`).join('')}</ul>`
    : `<p class="muted t-obj-sum" id="objList">${list.length} objective${list.length === 1 ? '' : 's'} · ${avg}% done on average</p>`;
  return `<section class="card wide t-sec" aria-label="Team objectives">
    <div class="card-head"><label class="head">Team objectives <span class="muted">(${list.length})</span></label>
      <button type="button" class="ghost run" data-act="toggleObjectives" aria-expanded="${shown}" aria-controls="objList">${shown ? 'Minimize' : 'Show'}</button></div>
    ${body}
  </section>`;
}

function renderToday() {
  const host = $('todayView');
  if (!host) return;
  const t = todayData();
  if (!todayAvailable()) {
    host.innerHTML = `<section class="card wide"><label class="head">Today's Look</label>
      <p class="empty">${t ? 'Update your sheet to use this page.' : 'This page needs the newest version of your sheet\'s script. Press Update now in the yellow banner, or open Settings.'}</p></section>`;
    return;
  }
  if (!Array.isArray(t.busy)) {
    host.innerHTML = `<section class="card wide"><label class="head">Today's Look</label>
      <p class="empty">Update your sheet to use this page. Press Update now in the yellow banner, or open Settings.</p></section>`;
    return;
  }
  todayStaleCheck(t);
  const m = lkModel(t);
  let html = lkHead(t, m);
  if (!t.fresh) {
    html += `<div class="notice warn wide-notice" role="status"><div><b>No fresh plan arrived today.</b>
      <div class="muted">${t.feed && t.feed.date ? 'The last plan was for ' + esc(dayLabel(t.feed.date)) + '. ' : ''}Work items come from the planner on your computer. Your own tasks, Google Tasks and both calendars still show.</div></div></div>`;
  }
  html += lkCalendar(t, m) + lkQuick(t, m) + lkObjectives(t.feed);
  host.innerHTML = html;
}

// ---- placing and changing ------------------------------------------

/** One change to the day. The sheet checks it against the bookings and answers with the whole day, which replaces what is on screen. */
function lookCall(label, action, args, onError) {
  const t = todayData();
  if (!t) return Promise.resolve(false);
  return request(label, action, args).then(({ res, latest }) => {
    if (res && res.view) { if (latest && STATE) STATE.today = res.view; else needsResync = true; }
    settle();
    return true;
  }).catch(err => {
    if (isAuthError(err)) { fail(err); return false; }
    if (onError) onError(err.message); else toast(err.message, 'error');
    return false;
  });
}

const lookPlaced = id => arr((todayData() || {}).items).find(i => i.id === String(id));

function lookOpts(el, list, selected) {
  el.innerHTML = list.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`).join('');
}
const lookStartOpts = () => { const o = []; for (let s = LK_START; s < LK_END; s += 15) o.push([lkHm(s), lkTime(s)]); return o; };

function lookMsg2(text) { const p = $('lookDlgMsg'); if (p) p.textContent = text || ''; }

function lookTagChips() {
  const t = todayData();
  const hints = arr(t && t.tagHints);
  $('lookTagList').innerHTML = hints.map(x => `<option value="${esc(x)}">`).join('');
  $('lookTagChips').innerHTML = hints.slice(0, 6).map(x => `<button type="button" class="ghost" data-act="lookTagAdd" data-v="${esc(x)}">${esc(x)}</button>`).join('');
}

function lookSyncPick() {
  const v = $('lookItem').value;
  const t = todayData(), m = t ? lkModel(t) : null;
  let len = 30;
  if (v.indexOf('t:') === 0 && m) { const it = m.openAll.find(i => i.id === v.slice(2)); if (it) len = lkDefaultLen({ kind: 'todo', points: it.points }); }
  $('lookLen').value = String(len);
  $('lookTagsBox').hidden = v !== 'focus';
}

function openLook(opts) {
  const t = todayData(), dlg = $('lookDlg');
  if (!t || !dlg || typeof dlg.showModal !== 'function') return;
  lookMsg2('');
  lookTagChips();
  const lenList = LK_LENS.map(m => [m, fmtMinutes(m)]);
  if (opts.id) {                                           // an item that is already on the day
    const it = lookPlaced(opts.id);
    if (!it) return;
    LOOK = { mode: 'edit', id: it.id };
    $('lookHead').textContent = 'Change this block';
    $('lookWhat').textContent = it.source === 'focus' ? 'Focus block' : it.title;
    $('lookPickBox').hidden = true;
    const done = it.status === 'done';
    $('lookStart').closest('.lk-fields').hidden = done;
    lookOpts($('lookStart'), lookStartOpts(), it.start);
    lookOpts($('lookLen'), lenList, it.dur);
    $('lookTagsBox').hidden = done || it.source !== 'focus';
    $('lookTags').value = arr(it.tags).join(', ');
    $('lookSaveBtn').hidden = done; $('lookSaveBtn').textContent = 'Save changes';
    $('lookDoneBtn').hidden = false; $('lookDoneBtn').textContent = done ? 'Put back (undo done)' : 'Mark done';
    $('lookRemoveBtn').hidden = done;
    $('lookRemoveBtn').textContent = it.source === 'focus' || it.source === 'focus-action' ? 'Remove from the day' : 'Take off the day';
  } else {                                                 // an empty time was chosen
    const m = lkModel(t);
    LOOK = { mode: 'new' };
    $('lookHead').textContent = 'Place on your day';
    $('lookWhat').textContent = '';
    $('lookPickBox').hidden = false;
    $('lookStart').closest('.lk-fields').hidden = false;
    $('lookItem').innerHTML = `<option value="focus">Focus block (loose work or learning)</option>` +
      (m.bulletsLeft.length ? `<optgroup label="From today's focus">${m.bulletsLeft.map((b, i) => `<option value="a:${i}">${esc(snippet(b, 70))}</option>`).join('')}</optgroup>` : '') +
      (m.openAll.length ? `<optgroup label="To do">${m.openAll.map(i => `<option value="t:${esc(i.id)}">${esc(snippet(i.title, 70))}</option>`).join('')}</optgroup>` : '');
    lookOpts($('lookStart'), lookStartOpts(), opts.start);
    lookOpts($('lookLen'), lenList, 30);
    $('lookTags').value = '';
    $('lookTagsBox').hidden = false;
    $('lookSaveBtn').hidden = false; $('lookSaveBtn').textContent = 'Place';
    $('lookDoneBtn').hidden = true;
    $('lookRemoveBtn').hidden = true;
  }
  dlg.showModal();
  (LOOK.mode === 'new' ? $('lookItem') : $('lookStart')).focus();
}

function closeLook() {
  const dlg = $('lookDlg');
  LOOK = null;
  if (dlg && dlg.open) dlg.close();
}

function lookSave() {
  if (!LOOK) return;
  const start = $('lookStart').value, minutes = Number($('lookLen').value), tags = $('lookTags').value.trim();
  const err = m => lookMsg2(m);
  lookMsg2('');
  let go;
  if (LOOK.mode === 'edit') {
    const it = lookPlaced(LOOK.id);
    const args = { id: LOOK.id, start, minutes };
    if (it && it.source === 'focus') args.tags = tags;
    go = lookCall('Saving', 'updateScheduledBlock', args, err);
  } else {
    const t = todayData(), m = t && lkModel(t), v = $('lookItem').value, ref = Queue.newRef();
    if (v === 'focus') go = lookCall('Saving', 'addFocusBlock', { start, minutes, tags, ref }, err);
    else if (v.indexOf('a:') === 0) go = lookCall('Saving', 'addScheduledAction', { title: m.bulletsLeft[Number(v.slice(2))] || '', start, minutes, ref }, err);
    else if (v.indexOf('t:') === 0) {
      if (v.indexOf('t:tmp_') === 0) { err('That task is still being saved. Try again in a moment.'); return; }
      go = lookCall('Saving', 'scheduleTodayItem', { id: v.slice(2), start, minutes }, err);
    } else return;
  }
  go.then(ok => { if (ok) closeLook(); });
}

function lookRemove() {
  if (!LOOK || LOOK.mode !== 'edit') return;
  lookCall('Saving', 'removeScheduledBlock', { id: LOOK.id }, lookMsg2).then(ok => { if (ok) closeLook(); });
}

function lookDone() {
  if (!LOOK || LOOK.mode !== 'edit') return;
  const it = lookPlaced(LOOK.id);
  if (!it) return;
  const id = it.id, dur = it.dur, wasDone = it.status === 'done';
  closeLook();
  if (wasDone) todaySetStatus(id, 'open', 'Putting back', '');
  else todayAskTime(id, null, dur);
}

/** The picker beside an item in Quick schedule. */
function lookQuickPlace(el) {
  const t = todayData();
  if (!t || !el.value) return;
  const start = el.value === 'next' ? el.dataset.next : el.value;
  const kind = el.dataset.kind;
  el.value = '';
  if (kind === 'focus') {
    const tags = $('lookFocusTags') ? $('lookFocusTags').value.trim() : '';
    lookCall('Saving', 'addFocusBlock', { start, minutes: 30, tags, ref: Queue.newRef() }).then(ok => { if (ok && $('lookFocusTags')) $('lookFocusTags').value = ''; });
  } else if (kind === 'action') {
    const b = lkModel(t).bulletsLeft[Number(el.dataset.i)];
    if (b) lookCall('Saving', 'addScheduledAction', { title: b, start, minutes: 30, ref: Queue.newRef() });
  } else if (kind === 'todo') {
    if (String(el.dataset.id).indexOf('tmp_') === 0) { toast('That task is still being saved. Try again in a moment.', 'error'); return; }
    const it = findToday(el.dataset.id);
    lookCall('Saving', 'scheduleTodayItem', { id: el.dataset.id, start, minutes: it ? lkDefaultLen({ kind: 'todo', points: it.points }) : 30 });
  }
}

document.addEventListener('change', e => {
  const el = e.target && e.target.closest && e.target.closest('[data-change="lookPlace"]');
  if (el) lookQuickPlace(el);
  else if (e.target && e.target.id === 'lookItem') lookSyncPick();
});

Object.assign(HANDLERS, {
  lookSlot:   d => openLook({ start: d.start }),
  lookBlock:  d => openLook({ id: d.id }),
  lookSave:   () => lookSave(),
  lookRemove: () => lookRemove(),
  lookDone:   () => lookDone(),
  lookCancel: () => closeLook(),
  lookTagAdd: d => {
    const el = $('lookTags'), have = el.value.split(',').map(s => s.trim()).filter(Boolean);
    if (have.map(s => s.toUpperCase()).indexOf(String(d.v).toUpperCase()) < 0) have.push(d.v);
    el.value = have.join(', ');
  },
  toggleObjectives: () => { setObjShown(!objShown()); if (STATE) render(); }
});

(function wireLookDialog() {
  const dlg = $('lookDlg');
  if (dlg) dlg.addEventListener('close', () => { LOOK = null; });
})();
