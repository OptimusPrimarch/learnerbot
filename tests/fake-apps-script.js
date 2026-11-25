'use strict';
// A small stand-in for Google Apps Script and a spreadsheet, so the shipped backend can be exercised end to end:
// the real backend-latest.gs runs in a vm with these globals, and tests call it through doPost like the website does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function range(sheet, r, c, nr, nc) {
  const self = {
    getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(sheet.cells[(r + i) + ',' + (c + j)] ?? ''); out.push(row); } return out; },
    setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => { sheet.cells[(r + i) + ',' + (c + j)] = v; sheet.bump(r + i, c + j); })); return self; },
    setValue: v => { sheet.cells[r + ',' + c] = v; sheet.bump(r, c); return self; },
    setNumberFormat: () => self, setFontWeight: () => self, setBackground: () => self, setFontColor: () => self
  };
  return self;
}

function makeSheet(name) {
  const sh = {
    name, cells: {}, lastRow: 0, lastCol: 0,
    bump(r, c) { if (r > sh.lastRow) sh.lastRow = r; if (c > sh.lastCol) sh.lastCol = c; },
    getLastRow: () => sh.lastRow, getLastColumn: () => sh.lastCol,
    getRange: (r, c, nr, nc) => range(sh, r, c, nr || 1, nc || 1),
    setFrozenRows: () => {},
    deleteRows(start, count) {
      const cells = {};
      Object.keys(sh.cells).forEach(k => {
        const [r, c] = k.split(',').map(Number);
        if (r >= start && r < start + count) return;
        cells[(r >= start + count ? r - count : r) + ',' + c] = sh.cells[k];
      });
      sh.cells = cells; sh.lastRow = Math.max(0, sh.lastRow - count);
    }
  };
  return sh;
}

/** Builds a fresh fake world and loads the generated Code.gs into it. Answers { call, props, groqCalls, sheets, setGroq }. */
function load(repoRoot, opts) {
  opts = opts || {};
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: sh => { delete sheets[sh.name]; }
  };
  const store = { API_TOKEN: 'master-token', GROQ_API_KEY: 'gsk_test', TZ: opts.tz || 'America/Denver' };
  const cache = {};
  const groqCalls = [];
  let groqAnswer = '{"focus":"Test focus","actions":["a1","a2"],"reason":"because"}';
  const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, Error, Set, Map, Promise, Intl, RegExp, parseInt, parseFloat, isNaN, Boolean,
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); },
      getProperties: () => ({ ...store }), setProperties: o => Object.assign(store, o), deleteProperty: k => { delete store[k]; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
    Session: { getScriptTimeZone: () => 'America/Denver', getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
          .reduce((o, x) => { o[x.type] = x.value; return o; }, {});
        if (fmt === 'yyyy') return p.year;
        if (fmt === 'EEEE') return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
        return p.year + '-' + p.month + '-' + p.day;
      },
      getUuid: () => 'uuid-' + Math.random().toString(16).slice(2), sleep: () => {},
      computeDigest: () => [1, 2, 3], DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    UrlFetchApp: { fetch: (url, o) => {
      if (/backend-payload\.js/.test(url)) {   // "Update now": the sheet's loader downloads the new app from the site
        const text = opts.payload != null ? opts.payload : fs.readFileSync(path.join(repoRoot, 'backend-payload.js'), 'utf8');
        return { getResponseCode: () => 200, getContentText: () => text };
      }
      groqCalls.push(JSON.parse(o.payload));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ message: { content: groqAnswer }, finish_reason: 'stop' }] }) };
    } },
    ScriptApp: { WeekDay: {}, getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => { throw new Error('triggers are not part of these tests'); }, getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/AKfycbTEST/exec' }) },
    MailApp: { sendEmail: () => {} }, HtmlService: { createHtmlOutput: s => ({ s }) },
    Logger: { log: () => {} }
  };
  // opts.tasks = { lists: [{ id, title, items: [...] }], fail: 'message' } stands in for the Google Tasks service (enabled in the real
  // sheet through Services > Google Tasks API). The object stays live, so a test can change it between refreshes.
  const tasksCalls = [];
  if (opts.tasks) {
    ctx.Tasks = {
      Tasklists: { list: () => { if (opts.tasks.fail) throw new Error(opts.tasks.fail); return { items: opts.tasks.lists.map(l => ({ id: l.id, title: l.title })) }; } },
      Tasks: { list: (id, o) => { tasksCalls.push({ id, o }); const l = opts.tasks.lists.find(x => x.id === id); return { items: l ? l.items : [] }; } }
    };
  }
  vm.createContext(ctx);
  let gs = fs.readFileSync(path.join(repoRoot, 'backend-latest.gs'), 'utf8');
  // opts.asVersion makes the built-in copy claim an older build, like a sheet that has not been updated yet (the loader is the real one).
  if (opts.asVersion) gs = gs.replace(/const APP_VERSION = '[^']+'/, "const APP_VERSION = '" + opts.asVersion + "'").replace(/const LB_BUILTIN_VERSION = '[^']+'/, "const LB_BUILTIN_VERSION = '" + opts.asVersion + "'");
  vm.runInContext(gs, ctx, { filename: 'backend-latest.gs' });

  function call(action, args, token) {
    vm.runInContext('_lbRun = null; _lbLoadError = ""', ctx);   // every Apps Script request starts fresh: the loader picks the app again
    const out = ctx.doPost({ postData: { contents: JSON.stringify({ token: token === undefined ? 'master-token' : token, action, args: args || {}, tz: 'America/Denver' }) } });
    return JSON.parse(out.getContent());
  }
  const ok = (action, args) => { const r = call(action, args); if (!r.ok) throw new Error(action + ' failed: ' + r.code + ' ' + r.error); return r.data; };
  return { call, ok, store, groqCalls, tasksCalls, sheets, setGroq: s => { groqAnswer = s; }, ctx };
}

const ymd = (offsetDays, tz) => {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;
};

module.exports = { load, ymd };
