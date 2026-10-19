'use strict';
// queue.js — changes made in this browser that have not reached the sheet yet.
//
// Every change to a goal, task or log entry is written here first and sent from here, one at a time and in
// order. If the connection drops (or the page is closed) the changes stay in this browser and go out when it
// can. Each one carries its own random id (`ref`); the script uses it to recognise a change it already
// applied, so one whose answer got lost is not applied twice.
//
// Kept per connection, like the saved dashboard, and only ever sent to the sheet it was made for.

const Queue = (() => {
  const PREFIX = 'learnerbot.queue.v1:';
  const MAX = 200;                              // most changes kept waiting
  const LINK_KEYS = ['id', 'goalId', 'parentId']; // the arguments that can name a not-yet-saved item
  let memory = {};                              // used when this browser will not store anything
  let stored = true;                            // the last write reached storage

  const key = () => PREFIX + Api.connectionKey();

  const valid = r => !!r && typeof r === 'object' && typeof r.ref === 'string' && typeof r.action === 'string'
    && !!r.args && typeof r.args === 'object';

  function read() {
    if (!stored) return memory[key()] || [];
    try {
      const list = JSON.parse(localStorage.getItem(key()));
      return Array.isArray(list) ? list.filter(valid) : [];
    } catch (_) { return memory[key()] || []; }
  }
  function write(list) {
    memory[key()] = list;
    try {
      if (list.length) localStorage.setItem(key(), JSON.stringify(list)); else localStorage.removeItem(key());
      stored = true;
    } catch (_) { stored = false; }
  }

  /** A random id for one change (16 hex characters; the script only accepts that shape). */
  function newRef() {
    try {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      let s = '';
      for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
      return s;
    }
  }

  const all = () => read();
  const size = () => read().length;

  /** Adds a change at the end. `rec` is { action, args, what, label, tmp, ref }; the queue adds the bookkeeping. */
  function add(rec) {
    const item = { ref: rec.ref || newRef(), action: rec.action, args: rec.args || {}, what: rec.what || '', label: rec.label || '',
      tmp: rec.tmp || '', tries: 0, fails: 0, at: Date.now() };
    write(read().concat(item));
    return item;
  }

  /** Changes bookkeeping on one waiting change and answers with it (or null if it has gone). */
  function touch(ref, patch) {
    let out = null;
    write(read().map(r => (r.ref === ref ? (out = { ...r, ...patch }) : r)));
    return out;
  }

  function remove(ref) {
    const list = read();
    if (list.some(r => r.ref === ref)) write(list.filter(r => r.ref !== ref));
  }

  /** A temporary id has become a real one: later changes that named the temporary one now name the real one. */
  function rewrite(tmp, real) {
    let changed = false;
    const list = read().map(r => {
      if (!LINK_KEYS.some(k => r.args[k] === tmp)) return r;
      changed = true;
      const args = { ...r.args };
      LINK_KEYS.forEach(k => { if (args[k] === tmp) args[k] = String(real); });
      return { ...r, args };
    });
    if (changed) write(list);
  }

  /** A change that created something was refused, so the changes that name that thing cannot be sent. Answers with them. */
  function dropDependents(tmp) {
    let list = read();
    const gone = [tmp], dropped = [];
    for (;;) {
      const hit = list.find(r => LINK_KEYS.some(k => gone.includes(r.args[k])));
      if (!hit) break;
      list = list.filter(r => r !== hit);
      dropped.push(hit);
      if (hit.tmp) gone.push(hit.tmp);
    }
    if (dropped.length) write(list);
    return dropped;
  }

  function clear() { write([]); }

  return { MAX, newRef, all, size, add, touch, remove, rewrite, dropDependents, clear, durable: () => stored };
})();
