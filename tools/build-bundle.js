#!/usr/bin/env node
'use strict';
// Generates backend-payload.js (what "Update now" downloads) and backend-latest.gs (the whole Code.gs for a new sheet)
// from backend/*.js and tools/loader.js. Run from the repo root:  node tools/build-bundle.js
// Add a module by adding its file name to MODULES (order matters: it is the order they appear in the script).
// Pass --check to fail when the generated files are stale instead of writing them.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MODULES = ['Agents', 'Api', 'Code', 'GTasks', 'Groq', 'Log', 'Notify', 'Pairing', 'Sheets', 'Tidy', 'Today'];
const BAR = '// ============================================================\n';

function build() {
  const modules = MODULES.map(function (n) {
    const f = path.join(root, 'backend', n + '.js');
    if (!fs.existsSync(f)) throw new Error('missing backend/' + n + '.js');
    return BAR + '// ' + n + '.js\n' + BAR + fs.readFileSync(f, 'utf8');
  }).join('');
  const exportsText = fs.readFileSync(path.join(__dirname, 'exports.js'), 'utf8');
  const body = modules + exportsText;

  const version = (/const APP_VERSION = '([^']+)'/.exec(body) || [])[1];
  if (!version) throw new Error('APP_VERSION not found');
  const entries = JSON.stringify(
    Array.from(exportsText.matchAll(/^\s{2}([A-Za-z_]\w*),?$/gm)).map(function (m) { return m[1]; })
      .filter(function (n) { return n !== 'version'; }));

  const loader = fs.readFileSync(path.join(__dirname, 'loader.js'), 'utf8')
    .replace('__BUILTIN_VERSION__', version).replace('__ENTRIES__', entries);

  return {
    'backend-payload.js': '// LearnerBot app payload ' + version + '\n' + body,
    'backend-latest.gs': loader + body + '}\n',
    version: version
  };
}

const out = build();
const check = process.argv.indexOf('--check') >= 0;
let stale = false;
['backend-payload.js', 'backend-latest.gs'].forEach(function (name) {
  const f = path.join(root, name);
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur !== out[name]) {
    stale = true;
    if (!check) fs.writeFileSync(f, out[name]);
  }
});
if (check && stale) { console.error('Generated files are stale. Run: node tools/build-bundle.js'); process.exit(1); }
console.log((check ? 'checked' : 'built') + ' build ' + out.version + (stale && !check ? ' (files updated)' : ''));
