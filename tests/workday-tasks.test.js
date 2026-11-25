'use strict';
// Google Tasks on The Workday, items that leave a refresh, and new conversations with the assistant.
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { load, ymd } = require('./fake-apps-script');

const root = path.join(__dirname, '..');
const feed = (over) => Object.assign({ date: ymd(0), complete: true,
  items: [{ sourceId: '123034', title: 'Write the landing zone ADR', points: 5, state: 'Active', flags: [] },
          { sourceId: '121800', title: 'Fix job count cache', points: 1, state: 'PR Ready', flags: [] }],
  meta: { budget: 1.8, focus: [{ start: '09:00', end: '17:00', minutes: 480 }], busy: [] } }, over || {});

const due = d => ymd(d) + 'T00:00:00.000Z';
const taskLists = () => ({ lists: [
  { id: 'L1', title: 'My Tasks', items: [
    { id: 'tA', title: 'Renew passport', status: 'needsAction', due: due(0), webViewLink: 'https://tasks.google.com/task/tA',
      links: [{ type: 'email', description: 'Passport reminder', link: 'https://mail.google.com/mail/u/0/#inbox/abc' }, { type: 'x', description: 'Bad', link: 'https://evil.example.com/steal' }, { type: 'x', link: 'javascript:alert(1)' }] },
    { id: 'tB', title: 'Pay the invoice', status: 'needsAction', due: due(-3), webViewLink: 'https://tasks.google.com/task/tB' },
    { id: 'tC', title: 'Already done', status: 'completed', due: due(0) },
    { id: 'tD', title: 'Someday', status: 'needsAction' },
    { id: 'tE', title: 'Next week', status: 'needsAction', due: due(5) } ] },
  { id: 'L2', title: 'Home', items: [ { id: 'tF', title: 'Call the plumber', status: 'needsAction', due: due(0) } ] } ] });

// ---------------- Google Tasks ----------------

test('without the Tasks service the page is told, and the work feed is unaffected', () => {
  const w = load(root);
  const r = w.ok('refreshTasks');
  assert.equal(r.tasks.enabled, false);
  assert.equal(r.view.tasks.enabled, false);
  assert.equal(w.ok('setTodayFeed', feed()).added, 2);
});

test('Google Tasks due today or overdue arrive as items with their links; the rest do not', () => {
  const w = load(root, { tasks: taskLists() });
  const r = w.ok('refreshTasks');
  assert.equal(r.tasks.enabled, true); assert.equal(r.tasks.count, 3); assert.equal(r.tasks.error, '');
  const items = r.view.items.filter(i => i.source === 'google-task');
  assert.deepEqual(items.map(i => i.title), ['Pay the invoice', 'Call the plumber', 'Renew passport'], 'overdue first, then due today (A to Z within a day)');
  const passport = items.find(i => i.sourceId === 'tA');
  assert.deepEqual(passport.flags, ['DUE-TODAY']);
  assert.deepEqual(items.find(i => i.sourceId === 'tB').flags, ['OVERDUE']);
  assert.equal(passport.note, 'My Tasks');
  assert.equal(passport.status, 'open');
  assert.deepEqual(passport.links.map(l => l.u), ['https://tasks.google.com/task/tA', 'https://mail.google.com/mail/u/0/#inbox/abc'],
    'the task\'s own link first, then a linked email; links to anywhere but Google are dropped');
  assert.equal(passport.links[0].d, 'Open in Google Tasks');
  const ask = w.tasksCalls[0].o;
  assert.equal(ask.showCompleted, false);
  assert.equal(ask.dueMax, ymd(0) + 'T23:59:59.000Z');
});

test('only https links to Google are ever stored', () => {
  const w = load(root, { tasks: { lists: [{ id: 'L', title: 'T', items: [{ id: 'x', title: 'Sneaky', status: 'needsAction', due: due(0),
    webViewLink: 'https://google.com.evil.example.com/task',
    links: [{ link: 'https://evilgoogle.com/x' }, { link: 'http://mail.google.com/insecure' }, { link: 'https://docs.google.com/document/d/1/edit', description: 'A doc' }] }] }] } });
  const it = w.ok('refreshTasks').view.items[0];
  assert.deepEqual(it.links.map(l => l.u), ['https://docs.google.com/document/d/1/edit'], 'the bad web link falls back to nothing; only the real Google doc remains');
});

test('a refresh keeps the person\'s goal link and does not duplicate, and a task finished in Google is closed', () => {
  const tasks = taskLists();
  const w = load(root, { tasks });
  const g = w.ok('addGoal', { title: 'Get organised', priority: 'high', tags: 'LIFE' }).goal;
  const first = w.ok('refreshTasks').view.items.find(i => i.sourceId === 'tA');
  w.ok('setTodayGoal', { id: first.id, goalId: g.id });
  const second = w.ok('refreshTasks');
  assert.equal(second.view.items.filter(i => i.source === 'google-task').length, 3, 'no duplicates');
  assert.equal(second.view.items.find(i => i.sourceId === 'tA').goalId, g.id);
  tasks.lists[0].items.find(i => i.id === 'tB').status = 'completed';   // ticked off in Google Tasks
  const third = w.ok('refreshTasks');
  assert.equal(third.view.items.find(i => i.sourceId === 'tB').status, 'closed');
  assert.equal(third.tasks.closed, 1);
  assert.equal(w.ok('getLog', { days: 7 }).entries.length, 0, 'closing is not a completion, so nothing is logged');
  assert.equal(w.ok('setTodayStatus', { id: third.view.items.find(i => i.sourceId === 'tB').id, status: 'open' }).task.status, 'open', 'and it can be put back');
});

test('finishing a Google Task here logs it, and a later refresh leaves it done', () => {
  const w = load(root, { tasks: taskLists() });
  const it = w.ok('refreshTasks').view.items.find(i => i.sourceId === 'tF');
  const done = w.ok('completeTodayTask', { id: it.id, minutes: 15 });
  assert.match(done.entry.text, /^Completed: Call the plumber$/, 'no work item number on a Google Task');
  assert.equal(w.ok('refreshTasks').view.items.find(i => i.sourceId === 'tF').status, 'done');
});

test('a problem with the Tasks service is recorded, never thrown, and existing items stay', () => {
  const tasks = taskLists();
  const w = load(root, { tasks });
  w.ok('refreshTasks');
  tasks.fail = 'Authorization is required to perform that action.';
  const r = w.ok('refreshTasks');
  assert.equal(r.tasks.enabled, true);
  assert.match(r.tasks.error, /Authorization is required/);
  assert.equal(r.view.items.filter(i => i.source === 'google-task' && i.status === 'open').length, 3);
});

test('every planner feed also refreshes Google Tasks', () => {
  const w = load(root, { tasks: taskLists() });
  const r = w.ok('setTodayFeed', feed());
  assert.equal(r.tasks.count, 3);
  assert.equal(r.view.items.length, 5, '2 work items + 3 Google Tasks');
});

test('the coach hears Google Tasks by name, not as work item numbers', () => {
  const w = load(root, { tasks: taskLists() });
  w.ok('setTodayFeed', feed());
  w.ok('runDaily');
  const user = w.groqCalls.at(-1).messages[1].content;
  assert.match(user, /- Google Task: Renew passport \(To do, DUE-TODAY/);
  assert.match(user, /- #123034 Write the landing zone ADR/);
});

// ---------------- items that leave a refresh ----------------

test('a complete feed closes work items that are no longer listed; a partial one does not', () => {
  const w = load(root);
  w.ok('setTodayFeed', feed());
  const partial = w.ok('setTodayFeed', feed({ complete: false, items: [feed().items[0]] }));
  assert.equal(partial.closed, 0);
  assert.equal(partial.view.items.filter(i => i.status === 'open').length, 2);
  const full = w.ok('setTodayFeed', feed({ items: [feed().items[0]] }));   // the 3 PM refresh: the PR was merged and left the list
  assert.equal(full.closed, 1);
  const gone = full.view.items.find(i => i.sourceId === '121800');
  assert.equal(gone.status, 'closed');
  assert.equal(full.view.items.find(i => i.sourceId === '123034').status, 'open');
});

test('closing only touches open items of the same source and day; done and skipped stay as they are', () => {
  const w = load(root, { tasks: taskLists() });
  const v = w.ok('setTodayFeed', feed()).view;
  const adr = v.items.find(i => i.sourceId === '123034'), pr = v.items.find(i => i.sourceId === '121800');
  w.ok('completeTodayTask', { id: adr.id, minutes: 30 });
  w.ok('setTodayStatus', { id: pr.id, status: 'skipped' });
  const after = w.ok('setTodayFeed', feed({ items: [] })).view;
  assert.equal(after.items.find(i => i.sourceId === '123034').status, 'done');
  assert.equal(after.items.find(i => i.sourceId === '121800').status, 'skipped');
  assert.equal(after.items.filter(i => i.source === 'google-task' && i.status === 'open').length, 3, 'Google Tasks are not closed by the work feed');
});

// ---------------- new conversations ----------------

test('a new conversation starts the assistant\'s display fresh and keeps the old messages in the sheet', () => {
  const w = load(root);
  w.setGroq('{"action":"none","reply":"Hello there."}');
  w.ok('chat', { message: 'Hi' });
  w.ok('chat', { message: 'What is my focus?' });
  assert.equal(w.ok('getState').chatHistory.length, 4, 'two messages and two replies');
  const rowsBefore = w.sheets.Chat.lastRow;
  const r = w.ok('newChat');
  assert.deepEqual(r.chatHistory, []);
  assert.deepEqual(w.ok('getState').chatHistory, []);
  assert.equal(w.sheets.Chat.lastRow, rowsBefore + 1, 'only a divider is added; nothing is deleted');
  w.ok('chat', { message: 'Fresh start' });
  const now = w.ok('getState').chatHistory;
  assert.deepEqual(now.map(m => m.text), ['Fresh start', 'Hello there.']);
  w.ok('newChat'); w.ok('newChat');
  assert.deepEqual(w.ok('getState').chatHistory, [], 'repeating it is harmless');
});
