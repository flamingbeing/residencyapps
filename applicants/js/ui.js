// Small UI helpers for the app's screens (app.js). The look comes from the NUHS app kit (design.anawj.com/v1/: the .a-*
// classes, sheets, alerts, toasts) and style.css (the .e-* pieces).

// The app kit's theme (app-ui @core/theme, one exact version; sw.js keeps it offline): look A unless this device picks
// another under Account, NUHS navy as the accent, light / dark following the phone unless picked. import() so a
// blocked core.anawj.com leaves the NUHS kit's own light look.
export const KIT = 'https://core.anawj.com/ui/1.0.0-rc.22/';
export const theme = typeof document === 'undefined' ? Promise.resolve(null)
  : import(KIT + 'theme/index.js').then(t => { t.applyTheme({ accent: '#002f6c' }); return t; }).catch(() => null);

// h('p', { class: 'x', onclick }, 'text', child): one element; null and false children are skipped
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
// replaceChildren, skipping null/false (replaceChildren would print them as text)
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// One toast at a time: the app kit's once it has loaded, else the page's own #toast.
export function toast(msg, { ms = 4500 } = {}) {
  if (typeof window !== 'undefined' && window.aToast) { window.aToast(msg, { ms }); return; }
  const t = document.getElementById('toast');
  if (!t) return;
  fill(t, h('span', {}, msg));
  t.classList.add('show', 'is-shown');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show', 'is-shown'), ms);
}

export function download(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A bottom sheet (the kit's aSheet once loaded; a plain dialog before). Returns { el, close }.
const kitSheet = () => (typeof window !== 'undefined' && window.aSheet) || null;
export function modal(title, body) {
  // the title takes the initial focus, so phones don't pop a keyboard on open
  const el = h('dialog', { class: 'a-sheet e-dialog' },
    h('div', { class: 'a-sheet-head' }, h('span'), h('h2', { tabindex: '-1', autofocus: true }, title), h('span')),
    h('div', { class: 'a-sheet-body e-dialog__body' }, body));
  el.addEventListener('close', () => el.remove());
  document.body.append(el);
  const kit = kitSheet();
  if (kit) kit.open(el);
  else { el.addEventListener('click', e => { if (e.target === el) el.close(); }); el.showModal(); }
  return { el, close: () => (kit ? kit.close(el) : el.close()) };
}
// the phone's Back button closes an open sheet rather than leaving it over the page it went back to
if (typeof window !== 'undefined') window.addEventListener('popstate', () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });

// A yes/no question: the kit's centred alert (Cancel, then the answer; red when it destroys something).
export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    let ok = false;
    const kit = kitSheet();
    const close = () => (kit ? kit.close(el) : el.close());
    const el = h('dialog', { class: 'a-alert e-confirm', 'aria-labelledby': 'e-confirm-title' },
      h('h2', { id: 'e-confirm-title', tabindex: '-1', autofocus: true }, title),
      h('p', {}, text),
      h('div', { class: 'a-alert-actions' },
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { type: 'button', class: danger ? 'is-default is-danger' : 'is-default', onclick: () => { ok = true; close(); } }, okLabel)));
    el.addEventListener('close', () => { el.remove(); resolve(ok); });
    document.body.append(el);
    if (kit) kit.open(el); else el.showModal();
  });
}

// Plain words for the errors people actually meet; the code stays in brackets for support.
export function errText(e) {
  const code = String(e?.code || '').replace(/^firestore\//, '');
  const msg = {
    'permission-denied': 'You can’t change this any more (the round may be closed).',
    'unavailable': 'No connection. Check your signal and try again.',
    'auth/network-request-failed': 'No connection. Check your signal and try again.',
    'auth/popup-closed-by-user': 'The sign-in window was closed before it finished. Try again.',
    'auth/cancelled-popup-request': 'The sign-in window was closed before it finished. Try again.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Try again, or allow pop-ups for this site.',
    'auth/web-storage-unsupported': 'This browser blocks sign-in (private mode or blocked cookies). Open the link in Chrome or Safari.',
  }[code];
  if (msg) return msg;
  if (e instanceof Error && !e.code && e.message) return e.message;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'No connection. Check your signal and try again.';
  return `Something went wrong. Try again${code ? ` (${code})` : ''}.`;
}

// 'Dr Demo Faculty' -> 'DF'
export function initials(name) {
  const s = String(name || '').split('@')[0].replace(/[._-]+/g, ' ');
  const words = s.split(/\s+/).filter(w => w && !/^(dr|prof|mr|mrs|ms|miss|a\/prof|assoc)\.?$/i.test(w));
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const CLIPBOARD = 'M9 4h6v3H9zM9 5.5H6v15h12v-15h-3M9 12h6M9 16h4';
function clipboardIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'e-ico e-empty__icon'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', CLIPBOARD);
  svg.append(path);
  return svg;
}
export const empty = (title, text, action) => h('div', { class: 'a-empty e-empty' },
  clipboardIcon(), h('p', { class: 'e-empty__title' }, title), text ? h('p', {}, text) : null, action || null);

// Segment control: segment([{ id, label }], current, onpick)
export function segment(items, current, onpick) {
  return h('div', { class: 'a-seg e-segment', role: 'tablist' }, items.map(it => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(it.id === current), onclick: () => onpick(it.id),
  }, it.label)));
}
