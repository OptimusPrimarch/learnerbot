'use strict';
// Today's Look: the day from 8am to 8pm, placing things on it, focus blocks and their tags, and what the coach is asked.
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { load, ymd } = require('./fake-apps-script');

const root = path.join(__dirname, '..');
const WED = '2026-11-25T17:00:00Z';                 // Wednesday 10:00 in Denver (UTC-7)
const DAY = '2026-11-25';
const T = hm => `${DAY}T${hm}:00-07:00`;
const ev = (id, summary, from, to) => ({ id, iCalUID: id + '@g', summary, start: { dateTime: T(from) }, end: { dateTime: T(to) }, status: 'confirmed' });
const cal = events => ({ calendars: [{ id: 'me', summary: 'Me', primary: true, selected: true, events: events || [] }] });
const feed = over => Object.assign({ date: DAY, complete: true,
  items: [{ sourceId: '123034', title: 'Write the landing zone ADR', points: 5, state: 'Active', flags: [] },
          { sourceId: '121800', title: 'Fix job count cache', points: 1, state: 'PR Ready', flags: [] }],
  meta: { budget: 1.8, focus: [{ start: '13:00', end: '17:00', minutes: 240 }], busy: [{ start: '09:00', end: '09:30', src: 'Outlook' }, { start: '11:00', end: '12:00', src: 'Outlook' }] } }, over || {});

// A day with a morning meeting from each calendar (the Google one is already over: the calendar still shows it).
const day = () => {
  const w = load(root, { now: WED, calendar: cal([ev('g1', 'Dentist', '08:00', '08:45')]) });
  w.ok('setTodayFeed', feed());
  return w;
};

test('the view carries every booked window of the day from both calendars, including ones already over', () => {
  const v = day().ok('getToday');
  assert.deepEqual(v.busy.map(b => b.start + '-' + b.end + ' ' + b.src), ['08:00-08:45 Google', '09:00-09:30 Outlook', '11:00-12:00 Outlook']);
});

test('a work item can be placed on the day, given a length from its points, moved and taken off again', () => {
  const w = day();
  const id = w.ok('getToday').items.find(t => t.sourceId === '123034').id;
  const r = w.ok('scheduleTodayItem', { id, start: '13:00' });
  assert.deepEqual([r.task.start, r.task.dur], ['13:00', 120], '5 points is capped at two hours');
  const m = w.ok('updateScheduledBlock', { id, start: '14:00', minutes: 90 });
  assert.deepEqual([m.task.start, m.task.dur], ['14:00', 90]);
  const off = w.ok('removeScheduledBlock', { id });
  assert.deepEqual([off.task.start, off.task.dur], ['', 0]);
  assert.equal(off.view.items.some(t => t.id === id), true, 'it stays on the to-do list');
});

test('nothing can be placed over a booked meeting, outside 8am to 8pm, or over another block', () => {
  const w = day();
  const [a, b] = w.ok('getToday').items.map(t => t.id);
  assert.equal(w.call('scheduleTodayItem', { id: a, start: '11:30', minutes: 30 }).code, 'conflict');
  assert.equal(w.call('scheduleTodayItem', { id: a, start: '07:30', minutes: 30 }).code, 'bad_request');
  assert.equal(w.call('scheduleTodayItem', { id: a, start: '19:45', minutes: 30 }).code, 'bad_request');
  assert.equal(w.call('scheduleTodayItem', { id: a, start: '13:00', minutes: 5 }).code, 'bad_request');
  w.ok('scheduleTodayItem', { id: a, start: '13:00', minutes: 60 });
  assert.equal(w.call('scheduleTodayItem', { id: b, start: '13:30', minutes: 30 }).code, 'conflict');
  assert.equal(w.ok('scheduleTodayItem', { id: b, start: '14:00', minutes: 30 }).task.start, '14:00', 'touching is fine');
  assert.equal(w.ok('scheduleTodayItem', { id: a, start: '12:30', minutes: 90 }).task.dur, 90, 'a block does not clash with its own old place');
});

test('a focus block never leaves the list, and several can be added', () => {
  const w = day();
  const one = w.ok('addFocusBlock', { start: '13:00', minutes: 30, ref: 'aaaaaaaaaaaaaaaa' });
  const two = w.ok('addFocusBlock', { start: '15:00', minutes: 45, tags: ['learning'] });
  assert.equal(one.task.source, 'focus');
  assert.deepEqual(two.task.tags, ['LEARNING']);
  assert.equal(two.view.items.filter(t => t.source === 'focus').length, 2);
  const again = w.ok('addFocusBlock', { start: '13:00', minutes: 30, ref: 'aaaaaaaaaaaaaaaa', replay: true });
  assert.equal(again.task.id, one.task.id, 'a retry does not add it twice');
});

test('two focus blocks with the same start and end merge, and their tags are combined', () => {
  const w = day();
  w.ok('addFocusBlock', { start: '13:00', minutes: 30, tags: ['SQL'] });
  const r = w.ok('addFocusBlock', { start: '13:00', minutes: 30, tags: ['Reading', 'sql'] });
  assert.deepEqual(r.task.tags, ['SQL', 'READING']);
  assert.equal(r.view.items.filter(t => t.source === 'focus').length, 1);
  // moving one onto the other merges too
  w.ok('addFocusBlock', { start: '15:00', minutes: 30, tags: ['DATA'] });
  const mover = w.ok('getToday').items.find(t => t.source === 'focus' && t.start === '15:00').id;
  const m = w.ok('updateScheduledBlock', { id: mover, start: '13:00' });
  assert.deepEqual(m.task.tags, ['SQL', 'READING', 'DATA']);
  assert.equal(m.view.items.filter(t => t.source === 'focus').length, 1);
  // a focus block that only partly overlaps is a clash, not a merge
  assert.equal(w.call('addFocusBlock', { start: '13:15', minutes: 30 }).code, 'conflict');
});

test('focus blocks can be retagged and removed, and the tags are offered again next time', () => {
  const w = day();
  const id = w.ok('addFocusBlock', { start: '13:00', minutes: 30 }).task.id;
  const t = w.ok('updateScheduledBlock', { id, tags: 'Writing, Review, too many, a, b' });
  assert.deepEqual(t.task.tags, ['WRITING', 'REVIEW', 'TOO MANY', 'A']);
  assert.deepEqual(w.ok('getToday').tagHints, ['A', 'REVIEW', 'TOO MANY', 'WRITING']);
  const gone = w.ok('removeScheduledBlock', { id });
  assert.equal(gone.view.items.some(x => x.source === 'focus'), false);
});

test('a bullet from the daily focus can be placed, and finishing a focus block logs its time and tags', () => {
  const w = day();
  const a = w.ok('addScheduledAction', { title: 'Draft the ADR outline', start: '13:00', minutes: 45 }).task;
  assert.equal(a.source, 'focus-action');
  const f = w.ok('addFocusBlock', { start: '15:00', minutes: 30, tags: ['SQL'] }).task;
  const done = w.ok('completeTodayTask', { id: f.id, minutes: 30 });
  assert.equal(done.entry.text, 'Focus time (SQL)');
  assert.deepEqual(done.entry.tags, ['SQL']);
  const doneA = w.ok('completeTodayTask', { id: a.id, minutes: 45 });
  assert.equal(doneA.entry.text, 'Completed: Draft the ADR outline');
  assert.equal(w.call('removeScheduledBlock', { id: f.id }).code, 'bad_request', 'a logged block stays');
});

test('focus blocks and placed bullets are not "carried over" and are not counted as planned work', () => {
  const w = day();
  w.ok('addFocusBlock', { start: '13:00', minutes: 30 });
  w.ok('addScheduledAction', { title: 'Draft the ADR outline', start: '14:00', minutes: 30 });
  const v = w.ok('getToday');
  assert.equal(v.carried.length, 0);
  w.ok('runDaily');
  const user = w.groqCalls.at(-1).messages[1].content;
  assert.doesNotMatch(user, /Draft the ADR outline/, 'only the to-do list goes to the coach');
});

test('the coach is asked to weigh the to-do list against the goals and to say which items it covers', () => {
  const w = day();
  w.ok('addGoal', { title: 'Data strategy', priority: 'high', tags: 'DATA' });
  w.ok('addTodayTask', { title: 'Book the offsite' });
  w.setGroq(JSON.stringify({ assessment: 'The ADR and the strategy goal agree.', focus: 'Landing zone', actions: ['Outline the ADR', 'Fix the cache bug'], reason: 'Both due.', covered: ['t1', '[t2]', 'nonsense', 't1', 'x9'] }));
  w.ok('runDaily');
  const sys = w.groqCalls.at(-1).messages[0].content, user = w.groqCalls.at(-1).messages[1].content;
  assert.match(sys, /assessment across those current obligations and the ACTIVE GOALS/);
  assert.match(sys, /"covered"/);
  assert.match(user, /\[t3\] Book the offsite/);
  assert.match(user, /\[t1\] #123034 Write the landing zone ADR/);
  const rep = w.ok('getState').dailyReport.data;
  assert.equal(rep.assessment, 'The ADR and the strategy goal agree.');
  assert.deepEqual(rep.covered, ['t1', 't2'], 'only well-formed, distinct keys survive');
});

test('the to-do list reaches the coach even when no planner feed arrived today', () => {
  const w = load(root, { now: WED });
  w.ok('addTodayTask', { title: 'Book the offsite' });
  w.ok('runDaily');
  const user = w.groqCalls.at(-1).messages[1].content;
  assert.match(user, /no fresh plan arrived today/);
  assert.match(user, /\[t1\] Book the offsite/);
});

test('an older coach answer with no assessment is still fine', () => {
  const w = load(root, { now: WED });
  const rep = w.ok('runDaily').dailyReport.data;
  assert.equal(rep.assessment, '');
  assert.deepEqual(rep.covered, []);
});

test('placing something that was carried over from yesterday moves it to today', () => {
  const w = load(root, { now: WED });
  const y = ymd(-1);
  w.ok('setTodayFeed', Object.assign(feed({ date: y }), { date: y }));
  const v0 = w.ok('getToday');
  assert.ok(v0.carried.length >= 1, 'yesterday\'s open items are carried');
  const id = v0.carried[0].id;
  const r = w.ok('scheduleTodayItem', { id, start: '13:00', minutes: 30 });
  assert.equal(r.view.items.some(t => t.id === id && t.start === '13:00'), true);
});
