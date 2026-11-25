'use strict';
// The loader's Authorize Google menu item, and The Workday's own timed refresh inside the script.
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { load } = require('./fake-apps-script');

const root = path.join(__dirname, '..');
const WED = '2026-11-25T17:00:00Z';     // Wednesday 10:00 in Denver
const SAT = '2026-11-28T17:00:00Z';     // Saturday 10:00 in Denver
const cal = () => ({ calendars: [{ id: 'me', summary: 'Me', primary: true, selected: true, events: [] }] });
const tasks = () => ({ lists: [{ id: 'L1', title: 'My Tasks', items: [] }] });
const emails = { daily: { enabled: true, hour: 7 }, weekly: { enabled: false, day: 0, hour: 18 }, nudge: { enabled: false, hour: 20 } };

// ---------------- Authorize Google ----------------

test('the loader has direct Calendar and Tasks calls in its source, which is how Google learns what to ask for', () => {
  const src = require('fs').readFileSync(path.join(root, 'backend-latest.gs'), 'utf8');
  const loader = src.slice(0, src.indexOf('\nfunction _lbBuiltin() {'));
  for (const call of ['Calendar.CalendarList.list(', 'Calendar.Events.list(', 'Tasks.Tasklists.list(', 'Tasks.Tasks.list(']) {
    assert.ok(loader.includes(call), call + ' must be written out in the loader source');
  }
});

test('LearnerBot > Authorize Google runs those calls and says so', () => {
  const w = load(root, { now: WED, calendar: cal(), tasks: tasks() });
  w.ctx.menuAuthorizeGoogle();
  assert.match(w.alerts.at(-1), /^Done\. LearnerBot can now read your Google Calendar and Google Tasks/);
  assert.ok(w.calendarCalls.some(c => c.id === 'primary'));
  assert.ok(w.tasksCalls.some(c => c.id === '@default'));
});

test('without the services turned on, Authorize Google explains what to add instead of failing', () => {
  const w = load(root, { now: WED });
  assert.doesNotThrow(() => w.ctx.menuAuthorizeGoogle());
  assert.match(w.alerts.at(-1), /Google Calendar API and Google Tasks API/);
});

test('the sheet menu offers Authorize Google', () => {
  const w = load(root, { now: WED });
  w.ctx.onOpen();
  assert.ok(w.menus.at(-1).items.some(([label, fn]) => /Authorize Google/.test(label) && fn === 'menuAuthorizeGoogle'));
});

test('the page can see which loader the sheet has', () => {
  assert.equal(load(root, { now: WED }).ok('getState').appInfo.loader, 2);
  assert.equal(load(root, { now: WED, oldLoader: true }).ok('getState').appInfo.loader, undefined);
});

// ---------------- the timed refresh ----------------

test('the schedule starts off, with the usual hours, and the sheet can run a timer', () => {
  const s = load(root, { now: WED }).ok('getToday').schedule;
  assert.deepEqual([s.enabled, s.hours, s.canSchedule, s.loader], [false, [6, 15], true, 2]);
});

test('saving the schedule creates one timer per hour for the Workday job, and nothing else is disturbed', () => {
  const w = load(root, { now: WED, calendar: cal(), tasks: tasks() });
  w.ok('saveNotifications', emails);
  assert.deepEqual(w.triggers.map(t => t.handler), ['_dailyJob']);
  const r = w.ok('saveWorkdaySchedule', { enabled: true, hours: [15, 6, 15] });
  assert.deepEqual([r.schedule.enabled, r.schedule.hours], [true, [6, 15]], 'sorted, no repeats');
  assert.deepEqual(w.triggers.filter(t => t.handler === '_workdayJob').map(t => t.hour), [6, 15]);
  assert.equal(w.triggers.filter(t => t.handler === '_dailyJob').length, 1, 'the email timer is still there');
  w.ok('saveNotifications', Object.assign({}, emails, { daily: { enabled: false, hour: 7 } }));
  assert.deepEqual(w.triggers.map(t => t.handler).sort(), ['_workdayJob', '_workdayJob'], 'changing emails leaves the Workday timers alone');
  w.ok('saveWorkdaySchedule', { enabled: false, hours: [6, 15] });
  assert.deepEqual(w.triggers, [], 'switching it off removes only its own timers');
});

test('the schedule is checked and only the main connection can change it', () => {
  const w = load(root, { now: WED });
  assert.equal(w.call('saveWorkdaySchedule', { enabled: true, hours: [6] }, 'wrong').code, 'unauthorized');
  assert.equal(w.call('saveWorkdaySchedule', { enabled: true, hours: [] }).code, 'bad_request');
  assert.equal(w.call('saveWorkdaySchedule', { enabled: true, hours: [6, 9, 12, 15, 18] }).code, 'bad_request');
  assert.equal(w.call('saveWorkdaySchedule', { enabled: true, hours: [25] }).code, 'bad_request');
  assert.equal(w.call('saveWorkdaySchedule', { enabled: true, hours: ['soon'] }).code, 'bad_request');
  assert.deepEqual(w.triggers, []);
});

test('a sheet that has not had the newest Code.gs pasted is told so, and no timer is made', () => {
  const w = load(root, { now: WED, oldLoader: true });
  assert.equal(w.ok('getToday').schedule.canSchedule, false);
  const r = w.call('saveWorkdaySchedule', { enabled: true, hours: [6, 15] });
  assert.equal(r.code, 'needs_loader');
  assert.match(r.error, /one-time paste/);
  assert.deepEqual(w.triggers, []);
});

test('the timer refreshes Google Tasks and Calendar on a weekday', () => {
  const w = load(root, { now: WED, calendar: cal(), tasks: tasks() });
  w.ok('saveWorkdaySchedule', { enabled: true, hours: [6, 15] });
  const before = w.calendarCalls.length + w.tasksCalls.length;
  w.ctx._workdayJob();                                            // the loader's entry point, as Google's timer calls it
  assert.ok(w.calendarCalls.length + w.tasksCalls.length > before, 'both services were asked');
  assert.equal(w.ok('getToday').calendar.enabled, true);
});

test('the timer does nothing at the weekend, or when it is switched off, and never throws', () => {
  const sat = load(root, { now: SAT, calendar: cal(), tasks: tasks() });
  sat.ok('saveWorkdaySchedule', { enabled: true, hours: [6, 15] });
  sat.ctx._workdayJob();
  assert.equal(sat.calendarCalls.length + sat.tasksCalls.length, 0, 'Saturday');
  const off = load(root, { now: WED, calendar: cal(), tasks: tasks() });
  off.ctx._workdayJob();
  assert.equal(off.calendarCalls.length + off.tasksCalls.length, 0, 'switched off');
  const broken = load(root, { now: WED, calendar: Object.assign(cal(), { fail: 'Authorization is required' }), tasks: tasks() });
  broken.ok('saveWorkdaySchedule', { enabled: true, hours: [6] });
  assert.doesNotThrow(() => broken.ctx._workdayJob());
  assert.match(broken.ok('getToday').calendar.error, /Authorization/);
});

test('Update now from a sheet with an older loader still works; the loader stays old until Code.gs is pasted', () => {
  const w = load(root, { oldLoader: true, asVersion: '2026.11.28' });
  assert.equal(w.ok('updateApp', { expectVersion: '2026.11.29' }).status, 'updated');
  assert.equal(w.ok('getToday').schedule.canSchedule, false);
});
