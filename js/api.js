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

  let lastServer = null;   // server-side time breakdown from the most recent answer (requests run one at a time)

  // `target` ({url, token}) is for the one call that happens before this device has a saved connection:
  // redeeming a pairing link. Everything else uses the saved connection.
  async function send(action, args, target) {
    lastServer = null;
    if (!target) {
      if (isDemo()) return Mock.call(action, args || {});
      if (!isConfigured()) throw fail('not_configured', 'Not connected yet. Open ⚙ Settings.');
    }
    const url = target ? target.url : cfg.url;
    const token = target ? target.token : cfg.token;
    if (!validateUrl(url)) throw fail('bad_url', 'The saved URL is not a Google Apps Script web app URL.');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      // text/plain keeps this a "simple" request, so the browser skips the CORS preflight
      // that Apps Script cannot answer.
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token, action, args: args || {}, tz: timeZone() }),
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
    lastServer = (body && body.ms && typeof body.ms === 'object') ? body.ms : null;
    if (!body || !body.ok) throw fail((body && body.code) || 'error', (body && body.error) || 'Something went wrong.');
    return body.data;
  }

  // Duration of each request (queue wait excluded), newest last, kept for the Settings readout.
  const timings = [];
  async function timed(action, args, onResult) {
    const t0 = performance.now();
    let ok = true;
    // `args` may be a function so a queued request can pick up ids that were still
    // temporary when it was created (resolved at send time, after earlier requests finish).
    // `onResult` runs before the next queued request is built, so it can record the real id
    // that request needs; plain promise callbacks would run one step too late.
    try {
      const res = await send(action, typeof args === 'function' ? args() : args);
      if (onResult) onResult(res);
      return res;
    }
    catch (e) { ok = false; throw e; }
    finally {
      timings.push({ action, ms: Math.round(performance.now() - t0), ok, server: lastServer });
      if (timings.length > 40) timings.shift();
    }
  }

  // One request at a time keeps writes in order, so "apply the latest response" is always right.
  function call(action, args, onResult) {
    const p = chain.then(() => timed(action, args, onResult));
    chain = p.catch(() => {});
    return p;
  }

  // A call to a given backend with no token, for redeeming a pairing link on a device that has no connection yet.
  function callPublic(url, action, args) {
    const p = chain.then(() => send(action, args, { url, token: '' }));
    chain = p.catch(() => {});
    return p;
  }

  // The deployment id inside a backend URL, and back. Pairing links carry the id so a phone needs nothing else.
  const backendId = u => { const m = /\/s\/([A-Za-z0-9_-]+)\/exec$/.exec(String(u || '')); return m ? m[1] : ''; };
  const backendUrl = id => 'https://script.google.com/macros/s/' + id + '/exec';

  return { call, callPublic, backendId, backendUrl, getConfig, setConfig, isDemo, isConfigured, validateUrl, timings: () => timings.slice() };
})();
