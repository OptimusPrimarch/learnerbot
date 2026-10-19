'use strict';
// history.js: the History tab. Two sections: Goals (completed, postponed and removed goals, with the
// quarterly tidy-up of completed goals) and Log (looking back at, editing and removing what you logged).
//
// Loaded after app.js and uses its helpers (STATE, request, fire, offerUndo, render, tagChip, ...).
// The log is not part of the dashboard data: it is asked for when the Log section opens, and the page
// keeps its own copy (LOGDATA) up to date as you edit, remove and add entries.

let HIST_SECTION = 'goals';   // 'goals' | 'log'
let LOGDATA = null;           // { entries, days, more, at } once loaded
let LOG_BUSY = false;
let LOG_ERR = '';
let LOG_TAG = null;           // tag filter
let LOG_EDITING = null;       // id of the entry whose editor is open
let REVIEW = null;            // the tidy-up being done: { goals, choice: { id: 'keep' | 'remove' } }
let reviewNoticeDismissed = false;
const LOG_STEPS = [30, 90, 365, 3650];   // how far back "Show older" goes, in days

const logAvailable = () => !!STATE && !backendOutdated() && Api.isConfigured();

function resetHistory() {
  HIST_SECTION = 'goals'; LOGDATA = null; LOG_BUSY = false; LOG_ERR = ''; LOG_TAG = null; LOG_EDITING = null; REVIEW = null; reviewNoticeDismissed = false;
}
const invalidateLog = () => { LOGDATA = null; LOG_ERR = ''; if (VIEW === 'history' && HIST_SECTION === 'log' && STATE) loadLog(30); };

/** "Today", "Yesterday", or "Mon, Oct 13" for a yyyy-mm-dd day. */
function dayLabel(ymd) {
  const n = daysUntil(ymd);
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return String(ymd);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// ---- the History tab -------------------------------------------
function renderHistory() {
  const tabs = `<div class="seg hist-tabs needs-new" role="group" aria-label="History sections">
    <button type="button" class="ghost run" data-act="histSection" data-v="goals" aria-pressed="${HIST_SECTION === 'goals'}">Goals</button>
    <button type="button" class="ghost run needs-new" data-act="histSection" data-v="log" aria-pressed="${HIST_SECTION === 'log'}">Log</button>
  </div>`;
  const body = HIST_SECTION === 'log' && logAvailable() ? logHtml() : tidyHtml() + goalsHistoryHtml();
  $('histView').innerHTML = tabs + body;
  if (HIST_SECTION === 'log' && logAvailable() && !LOGDATA && !LOG_BUSY && !LOG_ERR) loadLog(30);
}

// ---- the log ---------------------------------------------------
function loadLog(days) {
  if (LOG_BUSY || !logAvailable()) return;
  LOG_BUSY = true;
  LOG_ERR = '';
  if (LOGDATA && VIEW === 'history') renderHistory();   // the button says Loading…
  request(days > 30 ? 'Loading older entries' : 'Loading the log', 'getLog', { days })
    .then(({ res }) => { LOGDATA = { entries: arr(res.entries), days: res.days, more: !!res.more, at: Date.now() }; })
    .catch(err => { LOG_ERR = err.message; if (isAuthError(err)) fail(err); })
    .finally(() => {
      LOG_BUSY = false;
      if (pending === 0) setStatus('Ready', 'ok');
      if (VIEW === 'history') renderHistory();
    });
}

/** A new entry added from the dashboard shows up in the loaded log straight away. */
function logAdded(entry) {
  if (!LOGDATA || !entry) return;
  if (!LOGDATA.entries.some(e => e.id === entry.id)) LOGDATA.entries.unshift(entry);
  if (VIEW === 'history') renderHistory();
}

function logChips(res) {
  if (!res || !STATE) return;
  if (res.streak != null) { STATE.streak = res.streak; updateStreak(res.streak); }
  if (res.weekMinutes != null) { STATE.weekMinutes = res.weekMinutes; updateWeekChip(res.weekMinutes); }
}

function logRow(e) {
  const id = esc(e.id);
  if (LOG_EDITING === e.id) {
    return `<div class="log-row edit-form">
      <textarea id="lgt_${id}" maxlength="2000" aria-label="Entry text">${esc(e.text)}</textarea>
      <div class="row">
        <input id="lgg_${id}" type="text" value="${esc(arr(e.tags).join(', '))}" placeholder="Tags: WORK, AI (optional)" aria-label="Tags">
        <select id="lgm_${id}" style="width:auto" aria-label="Time spent (optional)"><option value="">Time (optional)</option>${MINUTE_STEPS.map(m => `<option value="${m}"${e.minutes === m ? ' selected' : ''}>${fmtMinutes(m)}</option>`).join('')}${e.minutes && !MINUTE_STEPS.includes(e.minutes) ? `<option value="${e.minutes}" selected>${fmtMinutes(e.minutes)}</option>` : ''}</select>
      </div>
      <div class="row"><button data-act="logSave" data-id="${id}">Save</button><button class="ghost" data-act="cancelEdit">Cancel</button></div>
    </div>`;
  }
  return `<div class="log-row">
    <div class="log-main">
      <div class="log-text">${esc(e.text)}</div>
      ${arr(e.tags).length || e.minutes ? `<div class="tags">${e.minutes ? `<span class="due">${esc(fmtMinutes(e.minutes))}</span>` : ''}${arr(e.tags).map(tagChip).join('')}</div>` : ''}
    </div>
    <span class="actions">
      <button class="icon ghost" data-act="logEdit" data-id="${id}" title="Edit" aria-label="Edit entry">✎</button>
      <button class="icon ghost" data-act="logRemove" data-id="${id}" title="Remove" aria-label="Remove entry">✕</button>
    </span>
  </div>`;
}

function logHtml() {
  if (LOG_ERR && !LOGDATA) return `<div class="card wide"><p class="cfg-msg err" role="alert">${esc(LOG_ERR)}</p><div class="row"><button data-act="logReload">Try again</button></div></div>`;
  if (!LOGDATA) return '<div class="card wide"><p class="empty">Loading your log…</p></div>';
  const all = LOGDATA.entries;
  const tagFreq = {};
  all.forEach(e => arr(e.tags).forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; }));
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  const shown = LOG_TAG ? all.filter(e => arr(e.tags).includes(LOG_TAG)) : all;
  const week = STATE && STATE.weekMinutes ? fmtMinutes(STATE.weekMinutes) + ' recorded this week' : '';
  let html = `<div class="card wide"><div class="card-head"><label class="head">Your log</label><span class="muted" style="font-size:13px">${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}${LOG_TAG ? ' tagged ' + esc(LOG_TAG) : ''}${week ? ' · ' + esc(week) : ''}</span></div>`;
  if (topTags.length) {
    html += `<div class="tags" style="margin-bottom:10px">${topTags.map(t => `<span class="tag" role="button" tabindex="0" style="--h:${tagHue(t)};cursor:pointer${LOG_TAG === t ? ';outline:2px solid hsl(var(--h),70%,var(--tag-fg-l));outline-offset:1px' : ''}" data-act="logTag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}${LOG_TAG ? '&nbsp;<button class="ghost icon" data-act="logTag" data-tag="" style="font-size:11px;padding:2px 8px">✕ clear</button>' : ''}</div>`;
  }
  if (!shown.length) {
    html += `<p class="empty">${LOG_TAG ? 'No entries with that tag in this period.' : 'Nothing logged in the last ' + LOGDATA.days + ' days. Entries you add on the Dashboard show up here.'}</p>`;
  } else {
    const days = [];
    shown.forEach(e => { const last = days[days.length - 1]; if (last && last.date === e.date) last.items.push(e); else days.push({ date: e.date, items: [e] }); });
    html += days.map(d => {
      const mins = d.items.reduce((s, e) => s + (e.minutes || 0), 0);
      return `<div class="log-day"><div class="log-day-head"><span>${esc(dayLabel(d.date))}</span>${mins ? `<span class="muted">${esc(fmtMinutes(mins))}</span>` : ''}</div>${d.items.map(logRow).join('')}</div>`;
    }).join('');
  }
  if (LOGDATA.more) {
    const next = LOG_STEPS.find(n => n > LOGDATA.days) || LOG_STEPS[LOG_STEPS.length - 1];
    html += `<div class="row"><button class="ghost" data-act="logOlder" data-days="${next}"${LOG_BUSY ? ' disabled' : ''}>${LOG_BUSY ? 'Loading…' : 'Show older'}</button></div>`;
  }
  html += `<p class="muted" style="font-size:12px;margin-top:12px">Removed entries are hidden at once and deleted for good after ${STATE && STATE.housekeeping ? esc(STATE.housekeeping.purgeDays) : '30'} days (change this in Settings &rarr; Housekeeping).</p></div>`;
  return html;
}

function logSaveNow(id) {
  const e = LOGDATA && LOGDATA.entries.find(x => x.id === id);
  if (!e) { LOG_EDITING = null; return renderHistory(); }
  const text = $('lgt_' + id) ? $('lgt_' + id).value.trim() : e.text;
  if (!text) { toast('An entry needs some text.', 'error'); return; }
  const tags = parseTags($('lgg_' + id).value);
  const minutes = Number($('lgm_' + id).value) || 0;
  const fields = {};
  if (text !== e.text) fields.text = text;
  if (tags.join(',') !== arr(e.tags).join(',')) fields.tags = tags.join(',');
  if (minutes !== (e.minutes || 0)) fields.minutes = minutes || '';
  LOG_EDITING = null;
  if (!Object.keys(fields).length) return renderHistory();
  fire('Saving', 'updateLog', { id, fields }, {
    optimistic: () => { Object.assign(e, { text, tags, minutes }); },
    onOk: res => { if (res && res.entry) { const i = LOGDATA.entries.findIndex(x => x.id === id); if (i >= 0) LOGDATA.entries[i] = res.entry; } logChips(res); },
    onFail: () => invalidateLog(),   // the page showed the change at once; fetch what the sheet really has
    what: snippet(text, 40)
  });
}

function logRemoveNow(id) {
  if (!LOGDATA) return;
  const i = LOGDATA.entries.findIndex(x => x.id === id);
  if (i < 0) return;
  const entry = LOGDATA.entries[i];
  fire('Removing', 'removeLog', { id }, {
    optimistic: () => { LOGDATA.entries = LOGDATA.entries.filter(x => x.id !== id); },
    onOk: logChips,
    onFail: () => { if (LOGDATA && !LOGDATA.entries.some(x => x.id === id)) LOGDATA.entries.splice(Math.min(i, LOGDATA.entries.length), 0, entry); },
    what: snippet(entry.text, 40)
  });
  offerUndo('Removed “' + snippet(entry.text, 36) + '”', () => {
    if (LOGDATA && !LOGDATA.entries.some(x => x.id === id)) LOGDATA.entries.splice(Math.min(i, LOGDATA.entries.length), 0, entry);
    fire('Restoring', 'restoreLog', { id }, { onOk: res => { logChips(res); }, what: snippet(entry.text, 40) });
  });
}

// ---- the quarterly tidy-up of completed goals ------------------
function goalsHistoryHtml() {
  const all = arr(STATE.historyGoals);
  const days = STATE.housekeeping ? STATE.housekeeping.purgeDays : null;
  const groups = [
    ['Completed', '✓', all.filter(g => g.status === 'completed'), ''],
    ['Postponed / On Hold', '⏸', all.filter(g => g.status === 'postponed'), ''],
    ['Removed', '✕', all.filter(g => g.status === 'archived'), days ? 'Removed goals are deleted for good after ' + days + ' days.' : '']
  ];
  let html = groups.filter(([, , list]) => list.length).map(([t, i, list, note]) => histSection(t, i, list, note)).join('');
  if (!all.length) html = '<div class="card wide"><p class="empty">No goal history yet. Complete or postpone goals to see them here.</p></div>';
  return html;
}

/** The tidy-up card (when one is open) or a line saying completed goals are ready for it. */
function tidyHtml() {
  const hk = STATE && STATE.housekeeping;
  if (REVIEW) {
    const goals = REVIEW.goals;
    const keep = goals.filter(g => REVIEW.choice[g.id] === 'keep').length, remove = goals.length - keep;
    const rows = goals.map(g => {
      const id = esc(g.id), pick = REVIEW.choice[g.id];
      const facts = [`done ${fmtDate(g.completed)}`, g.days != null ? `took ${g.days} ${g.days === 1 ? 'day' : 'days'}` : '', `${g.tasks} ${g.tasks === 1 ? 'task' : 'tasks'}`, g.children ? `${g.children} sub-${g.children === 1 ? 'goal' : 'goals'}` : '', `${g.priority} priority`].filter(Boolean).join(' · ');
      return `<div class="rv-row">
        <div class="rv-main"><div class="rv-title">${esc(g.title)}</div><div class="muted" style="font-size:12px">${esc(facts)}</div>${arr(g.tags).length ? `<div class="tags">${g.tags.map(tagChip).join('')}</div>` : ''}</div>
        <div class="seg rv-pick" role="group" aria-label="${esc(g.title)}">
          <button type="button" class="ghost run" data-act="reviewPick" data-id="${id}" data-v="keep" aria-pressed="${pick === 'keep'}">Keep</button>
          <button type="button" class="ghost run" data-act="reviewPick" data-id="${id}" data-v="remove" aria-pressed="${pick === 'remove'}">Remove</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="card wide review">
      <label class="head">Tidy up completed goals</label>
      <p class="muted" style="font-size:13px;margin-bottom:8px">These goals have been done for a while. <b>Keep</b> the ones that matter as a record (they stay here and are not asked about again); <b>Remove</b> the rest entirely, and their tasks go with them. Small, quick goals start on Remove and bigger ones on Keep. Change any of them.</p>
      ${rows || '<p class="empty">Nothing is ready for review yet.</p>'}
      <p class="muted" style="margin-top:10px">Keeping ${keep}, removing ${remove}.</p>
      <div class="row"><button data-act="reviewApply"${goals.length ? '' : ' disabled'}>${remove ? 'Apply: remove ' + remove + ' for good' : 'Apply'}</button><button class="ghost" data-act="reviewCancel">Cancel</button></div>
    </div>`;
  }
  if (hk && hk.reviewCount > 0) {
    const due = hk.reviewDue;
    return `<div class="notice ${due ? 'warn' : ''}"><div><b>${due ? 'Time to tidy up.' : 'Completed goals are ready for a tidy-up.'}</b>
      <div class="muted">${hk.reviewCount} completed ${hk.reviewCount === 1 ? 'goal is' : 'goals are'} ready to review: keep the important ones as a record and remove the rest to keep your sheet light.</div>
      <div class="notice-actions"><button data-act="reviewStart">Review now</button></div></div></div>`;
  }
  return '';
}

function reviewStartNow() {
  if (!STATE || !Api.isConfigured()) return;
  switchView('history');
  HIST_SECTION = 'goals';
  request('Loading the review', 'getReview', {})
    .then(({ res }) => {
      const goals = arr(res.goals);
      if (!goals.length) { toast('Nothing is ready for review yet.'); return; }
      REVIEW = { goals, choice: Object.fromEntries(goals.map(g => [g.id, g.suggest === 'remove' ? 'remove' : 'keep'])) };
    })
    .catch(err => { toast(err.message, 'error'); if (isAuthError(err)) fail(err); })
    .finally(() => { if (pending === 0) setStatus('Ready', 'ok'); if (VIEW === 'history') renderHistory(); });
}

function reviewApplyNow() {
  if (!REVIEW) return;
  const keep = REVIEW.goals.filter(g => REVIEW.choice[g.id] === 'keep').map(g => g.id);
  const remove = REVIEW.goals.filter(g => REVIEW.choice[g.id] !== 'keep').map(g => g.id);
  if (remove.length && !confirm('Remove ' + remove.length + (remove.length === 1 ? ' goal' : ' goals') + ' for good? Their tasks go too. This cannot be undone.')) return;
  request('Tidying up', 'applyReview', { keep, remove })
    .then(({ res }) => {
      const r = res.result || {};
      if (STATE && res.housekeeping) STATE.housekeeping = res.housekeeping;
      REVIEW = null;
      toast('Done: kept ' + (r.kept || 0) + ', removed ' + (r.removed || 0) + '.');
      return load();
    })
    .catch(err => { toast(err.message, 'error'); if (isAuthError(err)) fail(err); else if (pending === 0) setStatus('Ready', 'ok'); })
    .finally(() => { if (VIEW === 'history') renderHistory(); });
}

Object.assign(HANDLERS, {
  histSection: d => { HIST_SECTION = d.v === 'log' ? 'log' : 'goals'; LOG_EDITING = null; if (STATE) renderHistory(); },
  logEdit:   d => { LOG_EDITING = d.id; if (STATE) renderHistory(); const t = $('lgt_' + d.id); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } },
  logSave:   d => logSaveNow(d.id),
  logRemove: d => logRemoveNow(d.id),
  logTag:    d => { LOG_TAG = d.tag && LOG_TAG !== d.tag ? d.tag : null; if (STATE) renderHistory(); },
  logOlder:  d => loadLog(Number(d.days) || 90),
  logReload: () => { LOG_ERR = ''; loadLog(30); },
  reviewStart:  () => reviewStartNow(),
  reviewPick:   d => { if (REVIEW && REVIEW.choice[d.id]) { REVIEW.choice[d.id] = d.v === 'remove' ? 'remove' : 'keep'; renderHistory(); } },
  reviewApply:  () => reviewApplyNow(),
  reviewCancel: () => { REVIEW = null; if (STATE) renderHistory(); }
});
