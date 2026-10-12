// İstek modeli (spec) ve gönderim.
// spec = { id, name, method, url, params: [{k,v,on}], headers: [{k,v,on}],
//          body: { mode: 'none'|'json'|'text'|'form'|'multipart', text, form: [{k,v,on}], contentType },
//          auth: { type: 'none'|'bearer'|'basic'|'apikey', token, user, pass, key, value, in: 'header'|'query' },
//          opts: { via: 'ext'|'page', tabId, credentials, redirect: 'follow'|'manual', timeout } }
import { uid, queryRows, withQuery, tryJson, headerValue } from './util.js';
import { requestBody } from './capture.js';

export function newSpec(p = {}) {
  return {
    id: uid(), name: '', method: 'GET', url: '', params: [], headers: [],
    body: { mode: 'none', text: '', form: [], contentType: '' },
    auth: { type: 'none', token: '', user: '', pass: '', key: 'X-API-Key', value: '', in: 'header' },
    opts: { via: 'ext', tabId: null, credentials: true, redirect: 'follow', timeout: 30000 },
    ...p
  };
}

// Tarayıcının yönettiği başlıklar: yeniden gönderirken varsayılan olarak kapalı gelir.
const BROWSER_MANAGED = /^(sec-|accept-encoding$|connection$|host$|content-length$|priority$|upgrade-insecure-requests$|cache-control$|pragma$|keep-alive$|te$|user-agent$)/i;
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|user-agent|sec-.*|proxy-.*)$/i;
const NOT_SETTABLE = /^(connection|content-length|host|keep-alive|te|trailer|transfer-encoding|upgrade|expect|date|via|cookie2)$/i;

export const headerNote = (k, via) => {
  if (!k || !FORBIDDEN.test(k.trim())) return null;
  if (NOT_SETTABLE.test(k.trim())) return 'hdrDropped';
  return via === 'page' ? 'hdrPageDropped' : 'hdrForced';
};

export function entryToSpec(e) {
  const rb = requestBody(e);
  const ct = headerValue(e.reqHeaders || (e.hook && e.hook.reqHeaders) || [], 'content-type') || '';
  const headers = (e.reqHeaders && e.reqHeaders.length ? e.reqHeaders : (e.hook && e.hook.reqHeaders) || [])
    .filter(([k]) => !/^:/.test(k))
    .map(([k, v]) => ({ k, v, on: !BROWSER_MANAGED.test(k) }));
  let body = { mode: 'none', text: '', form: [], contentType: ct };
  if (rb && e.method !== 'GET' && e.method !== 'HEAD') {
    if (rb.fields) body = { mode: /multipart/i.test(ct) ? 'multipart' : 'form', text: '', form: rb.fields.map(([k, v]) => ({ k, v, on: true })), contentType: ct };
    else if (rb.text != null && !rb.binary) {
      const j = /json/i.test(ct) || tryJson(rb.text).ok;
      if (/x-www-form-urlencoded/i.test(ct)) body = { mode: 'form', text: '', form: queryRows('?' + rb.text), contentType: ct };
      else body = { mode: j ? 'json' : 'text', text: j && tryJson(rb.text).ok ? JSON.stringify(JSON.parse(rb.text), null, 2) : rb.text, form: [], contentType: ct };
    }
  }
  // Form/multipart gövdede tarayıcı sınırı kendi üretir: eski Content-Type başlığını kapat.
  if (body.mode === 'multipart') for (const h of headers) if (/^content-type$/i.test(h.k)) h.on = false;
  let name = e.url;
  try { const u = new URL(e.url); name = u.pathname.split('/').filter(Boolean).pop() || u.host; } catch { /* yok say */ }
  return newSpec({
    name: `${e.method} ${name}`.slice(0, 80), method: e.method, url: e.url, params: queryRows(e.url), headers, body,
    opts: { via: 'ext', tabId: e.tabId >= 0 ? e.tabId : null, credentials: true, redirect: 'follow', timeout: 30000 }
  });
}

// cURL ayrıştırıcısının çıktısından spec.
export function parsedToSpec(r) {
  const ct = (r.headers.find(([k]) => /^content-type$/i.test(k)) || [])[1] || '';
  let body = { mode: 'none', text: '', form: [], contentType: ct };
  if (r.body.type === 'multipart') body = { mode: 'multipart', text: '', form: r.body.fields.map(([k, v]) => ({ k, v, on: true })), contentType: '' };
  else if (r.body.type === 'text') {
    if (/x-www-form-urlencoded/i.test(ct)) body = { mode: 'form', text: '', form: queryRows('?' + r.body.text), contentType: ct };
    else {
      const j = tryJson(r.body.text);
      body = { mode: j.ok && (/json/i.test(ct) || !ct) ? 'json' : 'text', text: j.ok ? JSON.stringify(j.value, null, 2) : r.body.text, form: [], contentType: ct };
    }
  }
  return newSpec({
    name: `${r.method} ${(() => { try { return new URL(r.url).pathname; } catch { return r.url; } })()}`.slice(0, 80),
    method: r.method, url: r.url, params: queryRows(r.url),
    headers: r.headers.map(([k, v]) => ({ k, v, on: !(body.mode === 'multipart' && /^content-type$/i.test(k)) })), body
  });
}

// {{değişken}} yerleştirme. Bulunamayan değişkenler olduğu gibi kalır ve listelenir.
export function substitute(str, vars, missing) {
  return String(str ?? '').replace(/{{\s*([\w.-]+)\s*}}/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (missing) missing.add(name);
    return m;
  });
}

export function envVars(env) {
  const out = {};
  for (const v of (env && env.vars) || []) if (v.on !== false && v.k) out[v.k] = v.v ?? '';
  return out;
}

// spec -> gönderilecek çözümlenmiş istek.
export function resolve(spec, env) {
  const vars = envVars(env);
  const missing = new Set();
  const S = (s) => substitute(s, vars, missing);
  const method = S(spec.method || 'GET').toUpperCase();
  let url = S(spec.url).trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  const headers = (spec.headers || []).filter((h) => h.on !== false && h.k).map((h) => [S(h.k).trim(), S(h.v)]);
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  const a = spec.auth || {};
  if (a.type === 'bearer' && a.token) headers.push(['Authorization', 'Bearer ' + S(a.token)]);
  else if (a.type === 'basic' && (a.user || a.pass)) headers.push(['Authorization', 'Basic ' + btoa(unescape(encodeURIComponent(S(a.user) + ':' + S(a.pass))))]);
  else if (a.type === 'apikey' && a.key) {
    if (a.in === 'query') url += (url.includes('?') ? '&' : '?') + encodeURIComponent(S(a.key)) + '=' + encodeURIComponent(S(a.value));
    else headers.push([S(a.key), S(a.value)]);
  }
  const b = spec.body || {};
  let body = { type: 'none' };
  if (method !== 'GET' && method !== 'HEAD') {
    if (b.mode === 'json') { body = { type: 'text', text: S(b.text) }; if (!has('content-type')) headers.push(['Content-Type', 'application/json']); }
    else if (b.mode === 'text') { body = { type: 'text', text: S(b.text) }; if (!has('content-type') && b.contentType) headers.push(['Content-Type', b.contentType]); }
    else if (b.mode === 'form') { body = { type: 'form', fields: (b.form || []).filter((r) => r.on !== false && r.k).map((r) => [S(r.k), S(r.v)]) }; if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']); }
    else if (b.mode === 'multipart') body = { type: 'multipart', fields: (b.form || []).filter((r) => r.on !== false && r.k).map((r) => [S(r.k), S(r.v)]) };
  }
  const o = spec.opts || {};
  return {
    method, url, headers, body, missing: [...missing],
    credentials: o.credentials !== false, redirect: o.redirect || 'follow', timeout: Number(o.timeout) || 0
  };
}

export function send(req, { via = 'ext', tabId = null, maxBody } = {}) {
  const id = uid();
  const p = chrome.runtime.sendMessage({ type: 'reqlab:send', id, via, tabId, req: { ...req, maxBody } });
  return { id, promise: p, abort: () => chrome.runtime.sendMessage({ type: 'reqlab:abort', id }).catch(() => {}) };
}

export { withQuery, queryRows };
