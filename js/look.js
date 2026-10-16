'use strict';
// look.js: how the site looks (theme, colors, font, text size).
//
// Loaded first in <head>, so the saved look is applied before the page is drawn and nothing flashes.
// Theme, colors and font are saved in the person's own sheet (app.js does that) and cached here, so every
// device matches; text size is only ever kept on this device, because a phone and a computer want different sizes.
//
// Every color the page uses comes from the variables set here, so a theme is one object below. The Custom theme
// builds the same object from two colors the person picks: a primary (the page background) and a secondary
// (the accent, used for buttons and highlights). Colors are adjusted so text always stays readable on them
// (tests/look.test.js checks it for many colors).

const Look = (() => {
  const KEY = 'learnerbot.look.v1';

  // ---- themes ---------------------------------------------------
  // `dark` is also written out in style.css as the fallback; a test keeps the two identical.
  const THEMES = {
    dark: { label: 'Dark', scheme: 'dark', accent: '#6ea8fe',
      bg: '#0f1115', panel: '#181b22', panel2: '#1f232c', border: '#2a2f3a', text: '#e6e9ef', muted: '#9aa3b2',
      green: '#7ee787', warn: '#ffb454', red: '#ff6b6b',
      focusFrom: '#1b2330', focusBorder: '#2d3a52', redLine: '#662222', warnLine: '#665533', okLine: '#22cc44',
      postLine: '#44484f', busyLine: '#2d3a52', errFg: '#ffb3b3', backdrop: 'rgba(5,7,10,.7)', tagBg: 12, tagFg: 65, tagBd: 28 },
    light: { label: 'Light', scheme: 'light', accent: '#2563eb',
      bg: '#f4f6f9', panel: '#ffffff', panel2: '#eef1f5', border: '#d3d9e2', text: '#1a202c', muted: '#566176',
      green: '#157a38', warn: '#a15c07', red: '#c62828',
      focusFrom: '#eaf1fd', focusBorder: '#c5d6f3', redLine: '#e4a9a9', warnLine: '#e1c188', okLine: '#8fd0a5',
      postLine: '#c4c9d2', busyLine: '#bcd0f2', errFg: '#a31515', backdrop: 'rgba(20,25,35,.45)', tagBg: 92, tagFg: 28, tagBd: 72 },
    contrast: { label: 'High contrast', scheme: 'dark', accent: '#ffd60a',
      bg: '#000000', panel: '#0a0a0a', panel2: '#151515', border: '#9a9a9a', text: '#ffffff', muted: '#d4d4d4',
      green: '#66ff88', warn: '#ffc247', red: '#ff8080',
      focusFrom: '#111111', focusBorder: '#bdbdbd', redLine: '#ff8080', warnLine: '#ffc247', okLine: '#66ff88',
      postLine: '#bdbdbd', busyLine: '#bdbdbd', errFg: '#ffb3b3', backdrop: 'rgba(0,0,0,.8)', tagBg: 10, tagFg: 78, tagBd: 55 }
  };

  // ---- fonts: stacks of fonts already on the device, so nothing is downloaded ------
  const FONTS = {
    system:   { label: 'System',   stack: '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif' },
    humanist: { label: 'Humanist', stack: 'Seravek,"Gill Sans Nova","Gill Sans",Calibri,"Trebuchet MS",Ubuntu,sans-serif' },
    serif:    { label: 'Serif',    stack: 'Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Times New Roman",serif' },
    wide:     { label: 'Wide and clear', stack: 'Verdana,Geneva,"DejaVu Sans",sans-serif' },
    mono:     { label: 'Monospace', stack: 'ui-monospace,"SF Mono",Consolas,Menlo,"DejaVu Sans Mono",monospace' },
    rounded:  { label: 'Rounded',  stack: 'ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold","Hiragino Maru Gothic ProN",Quicksand,"Segoe UI",sans-serif' }
  };

  // ---- text size (this device only) -----------------------------
  const SIZES = { small: { label: 'Small', scale: 0.92 }, medium: { label: 'Medium', scale: 1 }, large: { label: 'Large', scale: 1.18 } };

  // Starting colors for the accent picker; each is adjusted to read well on the active theme.
  const SWATCHES = [
    { label: 'Blue', color: '#4f8cff' }, { label: 'Teal', color: '#1fb5a8' }, { label: 'Green', color: '#3fb950' },
    { label: 'Amber', color: '#f0a020' }, { label: 'Orange', color: '#f26a1b' }, { label: 'Red', color: '#f85149' },
    { label: 'Pink', color: '#ec4899' }, { label: 'Purple', color: '#a371f7' }
  ];

  // Page colors offered for the Custom theme, and ready-made pairs of primary + secondary.
  const PRIMARIES = [
    { label: 'Navy', color: '#142747' }, { label: 'Forest', color: '#12281d' }, { label: 'Plum', color: '#291a33' },
    { label: 'Slate', color: '#1e2933' }, { label: 'Sand', color: '#f3ead8' }, { label: 'Cloud', color: '#e8eef6' }
  ];
  const SCHEMES = [
    { label: 'LearnerBot', primary: '#142747', accent: '#ffcc33' },
    { label: 'Forest', primary: '#12281d', accent: '#7fd68a' },
    { label: 'Plum', primary: '#291a33', accent: '#ff9ad5' },
    { label: 'Ocean', primary: '#0b2a35', accent: '#4fd1c5' },
    { label: 'Sand', primary: '#f3ead8', accent: '#b4561b' },
    { label: 'Cloud', primary: '#e8eef6', accent: '#3366cc' }
  ];
  const DEFAULT_PRIMARY = '#142747';

  const DEFAULT = { theme: 'dark', primary: '', accent: '', font: 'system', size: 'medium' };
  const HEX = /^#[0-9a-f]{6}$/i;

  // ---- colour maths ---------------------------------------------
  const toRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const toHex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = toRgb(a), y = toRgb(b); return toHex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
  function luminance(hex) {
    const [r, g, b] = toRgb(hex).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function toHsl(hex) {
    const [r, g, b] = toRgb(hex).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function fromHsl(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));

  /** Nudges a color's lightness (hue and strength kept) until it has `need`:1 contrast on every one of `bgs`. */
  function fitColor(hex, bgs, scheme, need) {
    need = need || 4.5;
    const worst = c => Math.min.apply(null, bgs.map(bg => contrast(c, bg)));
    let color = hex;
    if (worst(color) < need) {
      const [h, s, l0] = toHsl(color), step = scheme === 'dark' ? 0.01 : -0.01;
      let l = l0;
      for (let i = 0; i < 100 && worst(fromHsl(h, s, l)) < need; i++) l = clamp01(l + step);
      color = fromHsl(h, s, l);
    }
    return color;
  }

  // ---- the Custom theme: a whole palette from one background color -------------
  function customPalette(primary) {
    const base = HEX.test(primary || '') ? primary.toLowerCase() : DEFAULT_PRIMARY;
    const [h, s0, l0] = toHsl(base);
    const dark = contrast(base, '#ffffff') >= contrast(base, '#000000');   // light text on this color, or dark text?
    const sp = Math.min(s0, 0.6);                                          // cards and borders stay calmer than a vivid page
    const text = fromHsl(h, Math.min(s0, dark ? 0.25 : 0.3), dark ? 0.93 : 0.10);
    const c = (l, sat) => fromHsl(h, sat, clamp01(l));
    const surfaces = l => dark
      ? { bg: c(l, s0), panel: c(l + 0.05, sp), panel2: c(l + 0.09, sp), border: c(l + 0.17, sp) }
      : { bg: c(l, s0), panel: c(Math.min(1, l + 0.05), sp), panel2: c(Math.min(1, l + 0.05) - 0.045, sp), border: c(l - 0.13, sp) };
    // Keep the chosen color, moving it away from mid-gray only as far as needed for 7:1 text on every surface.
    // A pure-white page would leave the white cards nothing to stand out from, so a very light page is eased down a little.
    let l = dark ? l0 : Math.min(l0, 0.965), sf = surfaces(l);
    const worstText = f => Math.min(contrast(text, f.bg), contrast(text, f.panel), contrast(text, f.panel2));
    for (let i = 0; i < 100 && worstText(sf) < 7; i++) { l = clamp01(l + (dark ? -0.01 : 0.01)); sf = surfaces(l); }
    const scheme = dark ? 'dark' : 'light', base2 = THEMES[scheme];
    const bgs = [sf.bg, sf.panel, sf.panel2];
    const pick = k => fitColor(base2[k], bgs, scheme);
    const green = pick('green'), warn = pick('warn'), red = pick('red');
    const muted = fitColor(mix(text, sf.bg, 0.4), bgs, scheme);
    return {
      label: 'Custom', custom: true, scheme: scheme, accent: base2.accent,
      bg: sf.bg, panel: sf.panel, panel2: sf.panel2, border: sf.border, text: text, muted: muted,
      green: green, warn: warn, red: red,
      focusFrom: base2.focusFrom, focusBorder: base2.focusBorder,     // replaced by blends with the accent in apply()
      redLine: mix(red, sf.bg, 0.5), warnLine: mix(warn, sf.bg, 0.5), okLine: mix(green, sf.bg, 0.5),
      postLine: mix(muted, sf.bg, 0.55), busyLine: base2.busyLine,
      errFg: fitColor(base2.errFg, bgs, scheme), backdrop: base2.backdrop,
      tagBg: base2.tagBg, tagFg: base2.tagFg, tagBd: base2.tagBd
    };
  }
  THEMES.custom = customPalette(DEFAULT_PRIMARY);   // the entry people see in the picker; the real palette is built from their color

  /** The palette a look uses. */
  function palette(look) {
    return look.theme === 'custom' ? customPalette(look.primary) : (THEMES[look.theme] || THEMES.dark);
  }

  /**
   * An accent that is readable on the theme: its lightness is nudged (hue and strength kept) until it has
   * at least 4.5:1 contrast against the page and the cards. `on` is the text color for buttons made in it.
   * `themeOrPalette` is a theme name or a palette from palette().
   */
  function fitAccent(hex, themeOrPalette) {
    const t = typeof themeOrPalette === 'string' ? (THEMES[themeOrPalette] || THEMES.dark) : themeOrPalette;
    const color = fitColor(HEX.test(hex || '') ? hex.toLowerCase() : t.accent, [t.bg, t.panel, t.panel2], t.scheme);
    const dark = '#0b0f1a', light = '#ffffff';
    return { color, on: contrast(color, dark) >= contrast(color, light) ? dark : light };
  }

  // ---- stored look ----------------------------------------------
  /** Anything unknown (a tampered or old value) becomes the default, so a bad value can never reach the page. */
  function clean(x) {
    x = x && typeof x === 'object' ? x : {};
    return {
      theme: Object.prototype.hasOwnProperty.call(THEMES, x.theme) ? x.theme : DEFAULT.theme,
      primary: typeof x.primary === 'string' && HEX.test(x.primary) ? x.primary.toLowerCase() : '',
      accent: typeof x.accent === 'string' && HEX.test(x.accent) ? x.accent.toLowerCase() : '',
      font: Object.prototype.hasOwnProperty.call(FONTS, x.font) ? x.font : DEFAULT.font,
      size: Object.prototype.hasOwnProperty.call(SIZES, x.size) ? x.size : DEFAULT.size,
      dirty: x.dirty === true
    };
  }

  function get() {
    try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch (_) { return clean(null); }
  }
  function store(look) {
    try { localStorage.setItem(KEY, JSON.stringify(look)); } catch (_) { /* private mode: it lasts for this visit only */ }
  }

  /** The four things saved in the sheet. */
  const payload = look => ({ theme: look.theme, primary: look.primary, accent: look.accent, font: look.font });
  const isDefault = look => look.theme === DEFAULT.theme && !look.accent && look.font === DEFAULT.font;
  const SYNCED = ['theme', 'primary', 'accent', 'font'];

  function apply(look) {
    if (typeof document === 'undefined') return;
    look = clean(look);
    const t = palette(look), a = fitAccent(look.accent || t.accent, t);
    // The Custom theme tints the highlighted card and the busy chip with the accent.
    const focusFrom = t.custom ? mix(t.bg, a.color, 0.10) : t.focusFrom;
    const focusBorder = t.custom ? mix(t.border, a.color, 0.35) : t.focusBorder;
    const busyLine = t.custom ? mix(a.color, t.bg, 0.5) : t.busyLine;
    const vars = {
      '--bg': t.bg, '--panel': t.panel, '--panel2': t.panel2, '--border': t.border, '--text': t.text, '--muted': t.muted,
      '--green': t.green, '--warn': t.warn, '--red': t.red, '--accent': a.color, '--on-accent': a.on,
      '--focus-from': focusFrom, '--focus-border': focusBorder, '--red-line': t.redLine, '--warn-line': t.warnLine,
      '--ok-line': t.okLine, '--post-line': t.postLine, '--busy-line': busyLine, '--err-fg': t.errFg, '--backdrop': t.backdrop,
      '--tag-bg-l': t.tagBg + '%', '--tag-fg-l': t.tagFg + '%', '--tag-bd-l': t.tagBd + '%',
      '--font': FONTS[look.font].stack, '--fs': String(SIZES[look.size].scale)
    };
    const root = document.documentElement;
    Object.keys(vars).forEach(k => root.style.setProperty(k, vars[k]));
    root.dataset.theme = look.theme;
    root.style.colorScheme = t.scheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
  }

  /**
   * Changes the look on this device. A change to theme, colors or font is marked "not yet saved in the sheet"
   * (dirty) until app.js has saved it there; a change to size never is, because size stays on the device.
   */
  function set(part) {
    const cur = get(), next = clean(Object.assign({}, cur, part));
    next.dirty = cur.dirty || SYNCED.some(k => next[k] !== cur[k]);
    store(next);
    apply(next);
    return next;
  }

  /** The sheet's saved look wins over the cached one (unless a newer change here has not been saved yet). */
  function adopt(saved) {
    const cur = get(), next = clean(Object.assign({}, cur, saved));
    next.dirty = false;
    store(next);
    apply(next);
    return next;
  }
  function markSaved() { const cur = get(); cur.dirty = false; store(cur); return cur; }

  const api = { THEMES, FONTS, SIZES, SWATCHES, PRIMARIES, SCHEMES, DEFAULT, DEFAULT_PRIMARY, SYNCED, clean, get, set, adopt, markSaved, apply,
    palette, customPalette, payload, isDefault, fitAccent, contrast, luminance };
  if (typeof module === 'object' && module.exports) module.exports = api;
  return api;
})();

try { Look.apply(Look.get()); } catch (_) { /* the page still works in its default look */ }
