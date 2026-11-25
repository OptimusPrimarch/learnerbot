// ============================================================
// Pairing.js \u2014 connect a phone without copying the long-lived token
//
// On the computer (the "master" connection) you create a one-time pairing link. Opening it on a
// phone swaps the one-time code for that phone's OWN device token. The master token never leaves
// the computer, and each phone can be revoked on its own.
//
//   * A code is ~120 random bits, lives 10 minutes and works once.
//   * Wrong codes are throttled: 10 failures lock redeeming for 10 minutes.
//   * Device tokens are stored only as SHA-256 hashes.
//   * Only the master connection can create links, email them, list or revoke devices.
//   * The pairing email goes only to the account that owns this script.
// ============================================================

const PAIR_TTL_SECONDS    = 600;
const PAIR_MAX_FAILS      = 10;
const PAIR_MAKE_PER_HOUR  = 10;
const PAIR_MAIL_PER_HOUR  = 5;
const MAX_DEVICES         = 10;
const DEVICE_USED_REFRESH_MS = 3600 * 1000;

/** Actions that work without a token. Everything else needs the master or a device token. */
const PUBLIC_ACTIONS = ['redeemPairing'];

// https://<site>/<path>#pair=<deployment id>.<code>
const PAIR_LINK_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/%+-]*#pair=(AKfycb[A-Za-z0-9_-]{40,200})\.([0-9a-f]{20,64})$/;

// Which kind of connection made this request: 'master', 'device' or null. Set by _authorize.
let _role = null;

function _needMaster() {
  if (_role !== 'master') throw _err('forbidden', 'Only your main connection (the computer you pasted the token into) can do that.');
}

// ---- Small helpers ------------------------------------------

function _sha256Hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))
    .map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('');
}

/** 30 random hex characters per UUID (its fixed version and variant digits are dropped). */
function _randomHex(uuids) {
  let out = '';
  for (let i = 0; i < uuids; i++) {
    const h = Utilities.getUuid().replace(/-/g, '');
    out += h.slice(0, 12) + h.slice(13, 16) + h.slice(17);
  }
  return out;
}

function _rateLimit(key, max, message) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0);
  if (n >= max) throw _err('rate_limited', message);
  cache.put(key, String(n + 1), 3600);
}

function _pairKey(code) { return 'pair_' + _sha256Hex(code); }

function _cleanDeviceName(n) {
  const s = String(n == null ? '' : n).replace(/[^A-Za-z0-9 ._,+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'Phone';
}

// ---- Device list (Script Properties, hashes only) -----------

function _devices() {
  let list = [];
  try { list = JSON.parse(_props().getProperty('DEVICES') || '[]'); } catch (_) { list = []; }
  return Array.isArray(list) ? list.filter(d => d && d.id && d.hash) : [];
}

function _saveDevices(list) { _props().setProperty('DEVICES', JSON.stringify(list)); }

function _deviceView(d) { return { id: d.id, name: d.name, created: d.created, used: d.used || '' }; }

function _deviceForToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const hash = _sha256Hex(token);
  return _devices().find(d => d.hash === hash) || null;
}

/** Remember when a phone was last used, at most once an hour (every write costs time). */
function _touchDevice(dev) {
  const last = dev.used ? Date.parse(dev.used) : 0;
  if (last && Date.now() - last < DEVICE_USED_REFRESH_MS) return;
  withLock(() => {
    const list = _devices();
    const d = list.find(x => x.id === dev.id);
    if (d) { d.used = new Date().toISOString(); _saveDevices(list); }
  });
}

// ---- Master-only actions ------------------------------------

function createPairing() {
  _needMaster();
  _rateLimit('pair_made', PAIR_MAKE_PER_HOUR, 'Too many pairing links this hour. Try again later.');
  const code = _randomHex(1);
  CacheService.getScriptCache().put(_pairKey(code), '1', PAIR_TTL_SECONDS);
  return { code: code, expiresInSeconds: PAIR_TTL_SECONDS };
}

function listDevices() {
  _needMaster();
  return { devices: _devices().map(_deviceView) };
}

function revokeDevice(a) {
  _needMaster();
  return withLock(() => {
    const list = _devices();
    const left = list.filter(d => d.id !== String(a && a.id));
    if (left.length === list.length) throw _err('not_found', 'That phone is not connected any more.');
    _saveDevices(left);
    return { devices: left.map(_deviceView) };
  });
}

function revokeAllDevices() {
  _needMaster();
  _props().deleteProperty('DEVICES');
  return { devices: [] };
}

function emailPairingLink(a) {
  _needMaster();
  const link = String((a && a.link) || '').trim();
  const m = link.length <= 400 ? PAIR_LINK_RE.exec(link) : null;
  if (!m || !CacheService.getScriptCache().get(_pairKey(m[3]))) {
    throw _err('bad_request', 'That is not a live pairing link. Create a new one first.');
  }
  _rateLimit('pair_mail', PAIR_MAIL_PER_HOUR, 'Pairing emails are limited to ' + PAIR_MAIL_PER_HOUR + ' an hour.');
  const to = _ownerEmail();
  if (!to) throw _err('no_email', 'Google did not give this script an address to send to.');
  _sendMail('Connect your phone to LearnerBot',
    '<h2 style="font-family:sans-serif">Connect your phone</h2>' +
    '<p style="font-family:sans-serif">Open this on your phone within 10 minutes. It works once.</p>' +
    '<p style="font-family:sans-serif"><a href="' + _h(link) + '" style="background:#6ea8fe;color:#08101f;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Connect this phone</a></p>' +
    '<p style="font-family:sans-serif;color:#888;font-size:12px">You asked for this from LearnerBot (\u2699 \u2192 Add your phone). If you did not, ignore it: the link expires by itself. Phones can be revoked there at any time.</p>');
  return { sent: true, to: to };
}

// ---- Public action: swap a one-time code for a device token ----

function redeemPairing(a) {
  if (!_props().getProperty('API_TOKEN')) throw _err('not_configured', 'This backend is not set up yet.');
  const cache = CacheService.getScriptCache();
  return withLock(() => {   // the lock makes "works once" hold even for two simultaneous requests
    const fails = Number(cache.get('pair_fail') || 0);
    if (fails >= PAIR_MAX_FAILS) {
      throw _err('rate_limited', 'Too many wrong attempts. Wait ten minutes, then create a new pairing link on your computer.');
    }
    const code = String((a && a.code) || '');
    const valid = /^[0-9a-f]{20,64}$/.test(code) && !!cache.get(_pairKey(code));
    if (!valid) {
      cache.put('pair_fail', String(fails + 1), 600);
      throw _err('bad_code', 'That pairing link has expired or was already used. On your computer, open \u2699 \u2192 Add your phone and create a new one.');
    }
    const list = _devices();
    if (list.length >= MAX_DEVICES) {
      throw _err('too_many_devices', 'This backend already has ' + MAX_DEVICES + ' connected phones. Revoke one on your computer, then try the same link again.');
    }
    cache.remove(_pairKey(code));
    const token = _randomHex(2);
    list.push({ id: _randomHex(1).slice(0, 12), name: _cleanDeviceName(a && a.name), hash: _sha256Hex(token), created: new Date().toISOString(), used: '' });
    _saveDevices(list);
    return { token: token };
  });
}

