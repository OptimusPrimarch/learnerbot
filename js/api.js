'use strict';
// api.js — talks to the user's own Apps Script backend (or the in-browser demo store).
// Config lives in this browser only; nothing here is ever sent anywhere but the URL
// the person pasted, and that URL must be a Google Apps Script web app.

const Api = (() => {
  const KEY = 'learnerbot.config.v1';
  // https://script.google.com/macros/s/<id>/exec  or  .../a/macros/<domain>/s/<id>/exec
  const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/;
  const TIMEOUT_MS = 120000;

  let cfg = read();
  let chain = Promise.resolve();

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; }
  }
  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) { /* private mode: keep it in memory for this visit */ }
  }
  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const getConfig   = () => ({ ...cfg });
  const setConfig   = next => { cfg = { ...next }; write(); };
  const isDemo      = () => cfg.mode === 'demo';
  const isConfigured = () => isDemo() || !!(cfg.url && cfg.token);
  const validateUrl = u => URL_RE.test(String(u || '').trim());
  const timeZone    = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } };

  async function send(action, args) {
    if (isDemo()) return Mock.call(action, args || {});
    if (!isConfigured()) throw fail('not_configured', 'Not connected yet. Open ⚙ Settings.');
    if (!validateUrl(cfg.url)) throw fail('bad_url', 'The saved URL is not a Google Apps Script web app URL.');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      // text/plain keeps this a "simple" request, so the browser skips the CORS preflight
      // that Apps Script cannot answer.
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: cfg.token, action, args: args || {}, tz: timeZone() }),
        signal: ctrl.signal
      });
    } catch (e) {
      throw fail('network', e.name === 'AbortError'
        ? 'The request timed out.'
        : 'Could not reach your backend. Check the URL, and that the deployment says "Who has access: Anyone".');
    } finally {
      clearTimeout(timer);
    }

    let body;
    try { body = JSON.parse(await res.text()); }
    catch (_) {
      throw fail('not_json', 'Your backend did not answer with data. Redeploy it with "Execute as: Me" and "Who has access: Anyone".');
    }
    if (!body || !body.ok) throw fail((body && body.code) || 'error', (body && body.error) || 'Something went wrong.');
    return body.data;
  }

  // Duration of each request (queue wait excluded), newest last, kept for the Settings readout.
  const timings = [];
  async function timed(action, args) {
    const t0 = performance.now();
    let ok = true;
    try { return await send(action, args); }
    catch (e) { ok = false; throw e; }
    finally {
      timings.push({ action, ms: Math.round(performance.now() - t0), ok });
      if (timings.length > 40) timings.shift();
    }
  }

  // One request at a time keeps writes in order, so "apply the latest response" is always right.
  function call(action, args) {
    const p = chain.then(() => timed(action, args));
    chain = p.catch(() => {});
    return p;
  }

  return { call, getConfig, setConfig, isDemo, isConfigured, validateUrl, timings: () => timings.slice() };
})();
