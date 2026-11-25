'use strict';
// Tests for the Today page's backend (backend/Today.js), run against the generated backend-latest.gs.
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { load, ymd } = require('./fake-apps-script');

const root = path.join(__dirname, '..');
const feed = (over) => Object.assign({
  date: ymd(0),
  items: [
    { sourceId: '123034', title: 'Write the landing zone architecture ADR', points: 5, state: 'Active', flags: ['DUE-IN-2d'], note: 'Data as a Product Strategy' },
    { sourceId: '121800', title: 'Fix job count cache on undelete', points: 1, state: 'PR Ready', flags: [] }
  ],
  meta: { budget: 1.8, focus: [{ start: '09:00', end: '17:00', minutes: 480 }], busy: [{ start: '08:30', end: '09:00' }],
    objectives: [{ key: '975', name: 'Data as a Product Strategy', progress: 11, due: '1/31' }] }
}, over || {});

test('generated files are in step with backend/ and tools/', () => {
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-bundle.js'), '--check'], { stdio: 'pipe' });
});

test('the new script starts, reports the new build, and the Today tab exists', () => {
  const w = load(root);
  const ping = w.ok('ping');
  assert.equal(ping.release, '1.8');
  const s = w.ok('getState');
  assert.equal(s.today.fresh, false);
  assert.deepEqual(s.today.items, []);
  assert.ok(w.sheets.Today, 'Today tab was created');
  assert.equal(w.sheets.Today.cells['1,1'], 'ID');
  assert.deepEqual(s._errors, []);
});

test('setTodayFeed: adds items, refreshes them without duplicating, and keeps the person\'s own choices', () => {
  const w = load(root);
  const g = w.ok('addGoal', { title: 'Data strategy', priority: 'high', tags: 'DATA' }).goal;
  const r1 = w.ok('setTodayFeed', feed());
  assert.equal(r1.added, 2); assert.equal(r1.updated, 0);
  assert.equal(r1.view.fresh, true);
  const adr = r1.view.items.find(t => t.sourceId === '123034');
  assert.equal(adr.title, 'Write the landing zone architecture ADR');
  assert.equal(adr.points, 5);
  assert.deepEqual(adr.flags, ['DUE-IN-2d']);
  assert.equal(adr.note, 'Data as a Product Strategy');
  w.ok('setTodayGoal', { id: adr.id, goalId: g.id });
  // the planner sends the day again with a changed state and points
  const r2 = w.ok('setTodayFeed', feed({ items: [{ sourceId: '123034', title: 'Write the landing zone ADR', points: 8, state: 'Done?', flags: [] }] }));
  assert.equal(r2.added, 0); assert.equal(r2.updated, 1);
  const again = r2.view.items.find(t => t.sourceId === '123034');
  assert.equal(again.id, adr.id);
  assert.equal(again.title, 'Write the landing zone ADR');
  assert.equal(again.points, 8);
  assert.equal(again.goalId, g.id, 'the goal link survives a refresh');
  assert.equal(r2.view.items.length, 2, 'items left out of a later feed stay');
});

test('setTodayFeed: refuses a wrong day, a wrong token, bad dates; drops items with no id; cleans flags', () => {
  const w = load(root);
  assert.equal(w.call('setTodayFeed', feed({ date: ymd(-5) })).code, 'bad_request');
  assert.equal(w.call('setTodayFeed', { date: 'tomorrow', items: [] }).code, 'bad_request');
  assert.equal(w.call('setTodayFeed', feed(), 'nope').code, 'unauthorized');
  const r = w.ok('setTodayFeed', feed({ items: [
    { title: 'no id' },
    { sourceId: '1', title: 'x'.repeat(300), flags: ['a,b', 'BLOCKED'] }
  ] }));
  assert.equal(r.added, 1);
  assert.equal(r.view.items[0].title.length, 80);
  assert.deepEqual(r.view.items[0].flags, ['a b', 'BLOCKED']);
});

test('a feed for yesterday is not fresh: the coach is told to ignore work items', () => {
  const w = load(root);
  w.ok('setTodayFeed', feed({ date: ymd(-1) }));
  assert.equal(w.ok('getToday').fresh, false);
  w.ok('runDaily');
  const prompt = w.groqCalls.at(-1).messages.map(m => m.content).join('\n');
  assert.match(prompt, /no fresh plan arrived today/);
  assert.doesNotMatch(prompt, /landing zone/);
});

test('the daily coach reads a fresh plan: short titles, IDs and objectives, nothing else', () => {
  const w = load(root);
  w.ok('setTodayFeed', feed());
  w.ok('runDaily');
  const msgs = w.groqCalls.at(-1).messages;
  const system = msgs[0].content, user = msgs[1].content;
  assert.match(system, /TODAY'S WORK PLAN/);
  assert.match(user, /#123034 Write the landing zone architecture ADR \(Active, 5 pts, DUE-IN-2d/);
  assert.match(user, /Open focus time: 09:00-17:00/);
  assert.match(user, /Data as a Product Strategy: 11%/);
  assert.match(user, /about 1\.8 story points/);
});

test('completing a task logs it with the time, tags it from the linked goal, and never logs twice', () => {
  const w = load(root);
  const g = w.ok('addGoal', { title: 'Data strategy', priority: 'high', tags: 'DATA, STRATEGY' }).goal;
  const v = w.ok('setTodayFeed', feed()).view;
  const adr = v.items.find(t => t.sourceId === '123034');
  w.ok('setTodayGoal', { id: adr.id, goalId: g.id });
  const ref = 'abcdef0123456789';
  const done = w.ok('completeTodayTask', { id: adr.id, minutes: 45, ref });
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.minutes, 45);
  assert.equal(done.entry.minutes, 45);
  assert.deepEqual(done.entry.tags, ['DATA', 'STRATEGY']);
  assert.match(done.entry.text, /^Completed: Write the landing zone architecture ADR \[#123034\]$/);
  assert.equal(done.weekMinutes, 45);
  // the page sends it again because the first answer was lost
  const again = w.ok('completeTodayTask', { id: adr.id, minutes: 45, ref, replay: true });
  assert.equal(again.task.status, 'done');
  const log = w.ok('getLog', { days: 7 });
  assert.equal(log.entries.filter(e => /landing zone/.test(e.text)).length, 1);
});

test('completing without a time, and a task with no goal, still logs (tag TASK)', () => {
  const w = load(root);
  const t = w.ok('addTodayTask', { title: 'Call the vendor' }).task;
  assert.equal(t.source, 'me');
  const done = w.ok('completeTodayTask', { id: t.id });
  assert.equal(done.entry.minutes, 0);
  assert.deepEqual(done.entry.tags, ['TASK']);
  assert.equal(w.call('completeTodayTask', { id: 'nope' }).code, 'not_found');
  const t2 = w.ok('addTodayTask', { title: 'Another' }).task;
  assert.equal(w.call('completeTodayTask', { id: t2.id, minutes: 'lots' }).code, 'bad_request');
  assert.equal(w.ok('getToday').items.find(x => x.id === t2.id).status, 'open', 'a refused time leaves the task open');
});

test('reopening a finished task takes its log entry away; skipping does not log', () => {
  const w = load(root);
  const t = w.ok('addTodayTask', { title: 'Write notes' }).task;
  w.ok('completeTodayTask', { id: t.id, minutes: 30 });
  assert.equal(w.ok('getLog', { days: 7 }).entries.length, 1);
  const re = w.ok('setTodayStatus', { id: t.id, status: 'open' });
  assert.equal(re.task.status, 'open'); assert.equal(re.task.minutes, 0); assert.equal(re.task.logId, '');
  assert.equal(re.weekMinutes, 0);
  assert.equal(w.ok('getLog', { days: 7 }).entries.length, 0);
  const sk = w.ok('setTodayStatus', { id: t.id, status: 'skipped' });
  assert.equal(sk.task.status, 'skipped');
  assert.equal(w.call('setTodayStatus', { id: t.id, status: 'done' }).code, 'bad_request');
});

test('goal links are optional and validated; own tasks are not duplicated by a replay', () => {
  const w = load(root);
  const t = w.ok('addTodayTask', { title: 'Stretch', ref: '0123456789abcdef' }).task;
  const t2 = w.ok('addTodayTask', { title: 'Stretch', ref: '0123456789abcdef', replay: true }).task;
  assert.equal(t.id, t2.id);
  assert.equal(w.call('setTodayGoal', { id: t.id, goalId: '999' }).code, 'not_found');
  assert.equal(w.ok('setTodayGoal', { id: t.id, goalId: '' }).task.goalId, '');
  assert.equal(w.call('addTodayTask', { title: '' }).code, 'bad_request');
});

test('open items from the last days are offered as carried over, once', () => {
  const w = load(root);
  w.ok('setTodayFeed', feed({ date: ymd(-1) }));
  const v = w.ok('getToday');
  assert.equal(v.items.length, 0);
  assert.equal(v.carried.length, 2);
  w.ok('setTodayFeed', feed());
  const v2 = w.ok('getToday');
  assert.equal(v2.items.length, 2);
  assert.equal(v2.carried.length, 0, 'items that came back today are not listed twice');
});

test('the weekly review hears how the week\'s planned tasks went', () => {
  const w = load(root);
  const t = w.ok('addTodayTask', { title: 'One' }).task;
  w.ok('addTodayTask', { title: 'Two' });
  w.ok('completeTodayTask', { id: t.id, minutes: 60 });
  w.ok('runWeekly');
  const review = w.groqCalls.map(c => c.messages[1].content).find(u => /THIS WEEK'S ACTIVITY LOG/.test(u));
  assert.ok(review, 'the weekly review prompt was sent');
  assert.match(review, /TASKS FROM THE TODAY PAGE THIS WEEK: 1 of 2 finished, 1h recorded/);
});

test('the site, the demo and the script agree on the version they expect', () => {
  const fs = require('fs');
  const code = fs.readFileSync(path.join(root, 'backend', 'Code.js'), 'utf8');
  const release = /const APP_RELEASE = '([^']+)'/.exec(code)[1];
  const build = /const APP_VERSION = '([^']+)'/.exec(code)[1];
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  assert.equal(/const EXPECTED_BACKEND = '([^']+)'/.exec(app)[1], build);
  assert.equal(/const SITE_RELEASE = '([^']+)'/.exec(app)[1], release);
  const mock = fs.readFileSync(path.join(root, 'js', 'mock.js'), 'utf8');
  assert.equal(/const VERSION = '([^']+)'/.exec(mock)[1], build);
  assert.equal(/const RELEASE = '([^']+)'/.exec(mock)[1], release);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp('## ' + release.replace('.', '\.') + ' · build ' + build.replace(/\./g, '\.')));
});
