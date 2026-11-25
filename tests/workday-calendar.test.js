'use strict';
// Google Calendar read inside the script, merged with the Outlook windows from the planner.
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { load } = require('./fake-apps-script');

const root = path.join(__dirname, '..');
const DAY = '2026-11-25';                         // a Wednesday; Denver is UTC-7 on this date
const T = (hm) => `${DAY}T${hm}:00-07:00`;        // a timed event as Google sends it
const ev = (id, summary, from, to, extra) => Object.assign({ id, iCalUID: id + '@g', summary, start: { dateTime: T(from) }, end: { dateTime: T(to) }, status: 'confirmed' }, extra || {});
const allDay = (id, summary, extra) => Object.assign({ id, summary, start: { date: DAY }, end: { date: '2026-11-26' } }, extra || {});

const calendar = () => ({ calendars: [
  { id: 'me@x.com', summary: 'Me', primary: true, selected: true, events: [
    ev('lunch', 'Lunch with Sam', '12:00', '13:00'),
    ev('dentist', 'Dentist (private)', '14:30', '15:00', { location: 'Main St' }),
    ev('read', 'Reading time', '14:00', '15:00', { transparency: 'transparent' }),        // marked free: shown, never blocks
    ev('focus', 'Focus time', '09:00', '10:00', { eventType: 'focusTime' }),             // Google's own focus block: never blocks
    ev('skip', 'Declined thing', '16:00', '17:00', { attendees: [{ self: true, responseStatus: 'declined' }] }),
    ev('cancel', 'Cancelled thing', '11:00', '12:00', { status: 'cancelled' }),
    ev('home', 'Home', '08:00', '17:00', { eventType: 'workingLocation' }),
    { id: 'other', iCalUID: 'other@g', summary: 'Tomorrow', start: { dateTime: '2026-11-26T09:00:00-07:00' }, end: { dateTime: '2026-11-26T10:00:00-07:00' } },
    allDay('bday', "Sam's birthday"),
    allDay('ooo', 'Out of office', { eventType: 'outOfOffice' }),
    { id: 'night', iCalUID: 'night@g', summary: 'Late call', start: { dateTime: `${DAY}T23:00:00-07:00` }, end: { dateTime: '2026-11-26T01:00:00-07:00' } } ] },
  { id: 'fam@x.com', summary: 'Family', selected: true, events: [
    ev('lunch2', 'Lunch with Sam', '12:00', '13:00', { iCalUID: 'lunch@g' }),               // the same event on a second calendar
    ev('swim', 'Swim practice', '16:00', '17:30') ] },
  { id: 'hidden@x.com', summary: 'Not ticked', selected: false, events: [ev('nope', 'Should not appear', '10:00', '11:00')] },
  { id: 'gone@x.com', summary: 'Deleted', selected: true, deleted: true, events: [ev('nope2', 'Deleted calendar event', '10:00', '11:00')] } ] });

// Wednesday 10:00 in Denver
const NOW = '2026-11-25T17:00:00Z';
const feed = (meta, over) => Object.assign({ date: DAY, complete: true, items: [{ sourceId: '1', title: 'A work item', points: 3, state: 'Active', flags: [] }],
  meta: Object.assign({ outlookKnown: true, settings: { workStart: '08:30', workEnd: '17:00', minFocus: 45, hoursPerPoint: 4.5 },
    busy: [{ start: '09:30', end: '09:45', src: 'Outlook' }, { start: '11:00', end: '12:00', src: 'Outlook' }], objectives: [] }, meta || {}) }, over || {});

test('without the Calendar service the planner\'s own windows are used and the page is told', () => {
  const w = load(root, { now: NOW });
  const r = w.ok('setTodayFeed', feed({ focus: [{ start: '13:00', end: '15:00', minutes: 120 }], budget: 1.2, busy: [{ start: '12:00', end: '13:00', src: 'Google' }] }));
  assert.equal(r.calendar.enabled, false);
  const f = r.view.feed;
  assert.deepEqual(f.focus, [{ start: '13:00', end: '15:00', minutes: 120 }]);
  assert.equal(f.budget, 1.2);
  assert.equal(f.sources.google, 'off');
  assert.equal(r.view.calendar.enabled, false);
});

test('Google events: ticked calendars only, free/focus/declined/all-day never block, nothing is dropped, names are not stored', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const status = w.ok('refreshGoogle').calendar;
  assert.equal(status.enabled, true); assert.equal(status.error, ''); assert.equal(status.calendars, 2, 'the main and the ticked one; not the unticked or deleted');
  assert.deepEqual(status.busy, [
    { start: '12:00', end: '13:00', src: 'Google' },          // once, though it is on two calendars
    { start: '14:30', end: '15:00', src: 'Google' },
    { start: '16:00', end: '17:30', src: 'Google' },
    { start: '23:00', end: '23:59', src: 'Google' } ].sort((a, b) => (a.start < b.start ? -1 : 1)), 'declined, free, focus time, cancelled, working location, tomorrow are not booked time; midnight is clipped');
  assert.equal(status.allDay, 2, 'the birthday and out of office are counted, not hidden');
  const stored = JSON.stringify(w.ok('getToday').calendar);
  for (const name of ['Lunch', 'Dentist', 'Reading', 'birthday', 'Swim', 'Late call', 'Sam']) assert.ok(!stored.includes(name), name + ' must not be stored');
  assert.ok(!w.calendarCalls.some(c => c.id === 'hidden@x.com' || c.id === 'gone@x.com'));
  const ask = w.calendarCalls[0].o;
  assert.equal(ask.singleEvents, true);
  assert.ok(!/description/.test(ask.fields), 'event descriptions are never requested');
});

test('merged schedule: Outlook windows from the planner plus Google, open time from now on, budget from what is left', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const f = w.ok('setTodayFeed', feed()).view.feed;
  assert.deepEqual(f.busy.map(b => [b.start, b.end, b.src]), [
    ['11:00', '12:00', 'Outlook'], ['12:00', '13:00', 'Google'], ['14:30', '15:00', 'Google'], ['16:00', '17:30', 'Google'], ['23:00', '23:59', 'Google']],
    'the 09:30 meeting is over; windows are in time order');
  assert.deepEqual(f.focus, [{ start: '10:00', end: '11:00', minutes: 60 }, { start: '13:00', end: '14:30', minutes: 90 }, { start: '15:00', end: '16:00', minutes: 60 }]);
  assert.equal(f.budget, 0.8, '210 minutes of open time at 4.5 hours a point');
  assert.equal(f.allDay, 2);
  assert.deepEqual(f.sources, { outlook: 'ok', google: 'ok' });
});

test('the planner\'s own Google windows are replaced by the script\'s, never counted twice', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const f = w.ok('setTodayFeed', feed({ busy: [{ start: '12:00', end: '13:00', src: 'Google' }, { start: '11:00', end: '11:30', src: 'Outlook' }] })).view.feed;
  assert.equal(f.busy.filter(b => b.start === '12:00').length, 1);
});

test('the work day comes from the planner\'s settings, and odd settings fall back to the defaults', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const early = w.ok('setTodayFeed', feed({ settings: { workStart: '08:00', workEnd: '12:00', minFocus: 30, hoursPerPoint: 2 } })).view.feed;
  assert.deepEqual(early.focus, [{ start: '10:00', end: '11:00', minutes: 60 }]);
  assert.equal(early.budget, 0.5);
  const odd = w.ok('setTodayFeed', feed({ settings: { workStart: 'soon', workEnd: '99:99', minFocus: -5, hoursPerPoint: 'lots' } })).view.feed;
  assert.equal(odd.focus.at(-1).end, '16:00', 'the 17:00 default end, with the 16:00 swim practice before it');
});

test('without today\'s plan the Google calendar still gives the day\'s shape, and the coach hears it with a clear note', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const v = w.ok('refreshGoogle').view;
  assert.equal(v.fresh, false);
  assert.ok(v.feed && v.feed.focus.length > 0);
  assert.equal(v.feed.sources.outlook, 'missing');
  w.ok('runDaily');
  const user = w.groqCalls.at(-1).messages[1].content;
  assert.match(user, /no fresh plan arrived today/);
  assert.match(user, /Open focus time: 10:00-12:00/);
  assert.match(user, /Outlook calendar did not arrive/);
  assert.match(user, /Booked: 12:00-13:00 \(Google\)/);
});

test('an Outlook calendar that did not arrive is flagged, not mistaken for an empty day', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const f = w.ok('setTodayFeed', feed({ outlookKnown: false, busy: [] })).view.feed;
  assert.equal(f.sources.outlook, 'missing');
  assert.ok(f.busy.every(b => b.src === 'Google'));
});

test('a problem with the Calendar service is recorded, never thrown, and earlier windows are kept', () => {
  const cal = calendar();
  const w = load(root, { now: NOW, calendar: cal });
  w.ok('refreshGoogle');
  cal.fail = 'Authorization is required to perform that action.';
  const r = w.ok('refreshGoogle');
  assert.match(r.calendar.error, /Authorization is required/);
  assert.equal(r.calendar.enabled, true);
  assert.equal(r.view.feed.sources.google, 'error');
  assert.ok(r.view.feed.busy.some(b => b.src === 'Google'), 'the windows from the last good refresh are still used');
});

test('getGoogleDay gives the main connection the day with names; nothing is stored and a wrong token is refused', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  const d = w.ok('getGoogleDay');
  assert.equal(d.enabled, true);
  assert.deepEqual(d.calendars, ['Me', 'Family']);
  const lunch = d.events.find(e => e.subject === 'Lunch with Sam');
  assert.deepEqual([lunch.start, lunch.end, lunch.allDay, lunch.free, lunch.calendar], ['12:00', '13:00', false, false, 'Me']);
  assert.equal(d.events.find(e => e.subject === 'Reading time').free, true);
  assert.equal(d.events.find(e => e.subject === 'Declined thing').declined, true);
  assert.equal(d.events.filter(e => e.allDay).length, 2);
  assert.ok(d.events.find(e => e.subject === "Sam's birthday").allDay);
  assert.ok(!JSON.stringify(w.ok('getToday').calendar).includes('Lunch'), 'asking does not store names');
  assert.equal(w.call('getGoogleDay', {}, 'wrong').code, 'unauthorized');
  assert.equal(load(root, { now: NOW }).ok('getGoogleDay').enabled, false);
});

test('every planner feed and the 7 AM job refresh the calendar, and the old refreshTasks name still works', () => {
  const w = load(root, { now: NOW, calendar: calendar() });
  assert.equal(w.ok('setTodayFeed', feed()).calendar.enabled, true);
  assert.ok(w.calendarCalls.length >= 2);
  const r = w.ok('refreshTasks');
  assert.ok(r.calendar && r.tasks && r.view);
});
