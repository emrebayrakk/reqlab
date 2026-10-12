// Ortak yardımcılar: DOM kurucu, biçimlendirme, URL/başlık işlemleri.

// h('div', { class: 'x', onClick: fn, html: '<b>' }, child, 'metin', [diziler], null)
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' kB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function fmtAgo(ts, t) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('agoNow');
  if (s < 3600) return t('agoMin', { n: Math.floor(s / 60) });
  if (s < 86400) return t('agoHour', { n: Math.floor(s / 3600) });
  return new Date(ts).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function statusClass(status, error) {
  if (error) return 'err';
  if (!status) return 'pend';
  return 's' + String(status)[0];
}

export function splitUrl(u) {
  try {
    const x = new URL(u);
    const name = (x.pathname.split('/').filter(Boolean).pop() || x.pathname || '/') + x.search;
    return { host: x.host, path: x.pathname + x.search, name, origin: x.origin, protocol: x.protocol };
  } catch {
    return { host: '', path: u, name: u, origin: '', protocol: '' };
  }
}

// "a=1&b=2" kısmını tabloya çevir (sıra ve tekrarlar korunur).
export function queryRows(url) {
  const i = url.indexOf('?');
  if (i < 0) return [];
  const q = url.slice(i + 1).split('#')[0];
  if (!q) return [];
  return q.split('&').map((part) => {
    const j = part.indexOf('=');
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
    return { k: dec(j < 0 ? part : part.slice(0, j)), v: j < 0 ? '' : dec(part.slice(j + 1)), on: true };
  });
}

// Tablodaki açık parametrelerle URL'nin sorgu kısmını yeniden yaz. {{değişken}} kodlanmaz.
export function withQuery(url, rows) {
  const base = url.split('#')[0].split('?')[0];
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  const enc = (s) => String(s).split(/({{[^}]*}})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');
  const q = rows.filter((r) => r.on !== false && (r.k || r.v)).map((r) => enc(r.k) + (r.v !== '' || r.k === '' ? '=' + enc(r.v) : '')).join('&');
  return base + (q ? '?' + q : '') + hash;
}

export const headerValue = (list, name) => {
  const n = name.toLowerCase();
  const h = (list || []).find((x) => String(x[0] ?? x.k).toLowerCase() === n);
  return h ? (h[1] ?? h.v) : undefined;
};

export function tryJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; }
}

export function guessLang(contentType, text) {
  const ct = String(contentType || '').toLowerCase();
  if (/json/.test(ct)) return 'json';
  if (/html/.test(ct)) return 'html';
  if (/xml|svg/.test(ct)) return 'xml';
  if (/javascript|ecmascript/.test(ct)) return 'js';
  if (/css/.test(ct)) return 'css';
  const s = String(text || '').trimStart();
  if (/^[[{]/.test(s) && tryJson(s).ok) return 'json';
  if (/^<!doctype html|^<html/i.test(s)) return 'html';
  if (/^<\?xml|^<[a-z]/i.test(s)) return 'xml';
  return 'text';
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = String(text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function download(name, data, mime = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      f.text().then((text) => resolve({ name: f.name, text }), () => resolve(null));
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

export function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
