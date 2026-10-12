// Sayfanın kendi dünyasında (MAIN) çalışır; ayarlarda "sayfa kancası" açıkken arka plan tarafından kaydedilir.
// fetch ve XMLHttpRequest'i sarar:
//  - yakalama açıksa (ReqLab penceresi açıkken) istek/yanıt gövdelerini köprüye iletir,
//  - eşleşen "sahte yanıt" kuralı varsa ağa çıkmadan yanıt verir, "gecikme" kuralı varsa bekletir.
// Köprüyle (content/bridge.js) yalnızca metin taşıyan CustomEvent'lerle konuşur.
(function () {
  'use strict';
  if (window.__reqlabHook) return;
  window.__reqlabHook = true;

  let cfg = { capture: false, maxBody: 1048576, rules: [] };
  // Köprüden ayar gelene kadar (sayfanın ilk istekleri) kayıtlar kuyrukta bekler; ilk fetch/XHR'lar
  // sahte yanıt kuralları uygulanabilsin diye ayarı en fazla 250 ms bekler.
  let known = false;
  const queue = [];
  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  let settled = false;
  ready.then(() => { settled = true; });
  setTimeout(() => markReady(), 250);
  const capturing = () => !known || cfg.capture;
  const TEXT_TYPE = /(json|text|xml|javascript|ecmascript|html|css|csv|graphql|x-www-form-urlencoded|yaml|svg)/i;

  document.addEventListener('reqlab:config', (e) => {
    try { cfg = { ...cfg, ...JSON.parse(e.detail) }; } catch { /* yok say */ }
    if (!known) {
      known = true;
      markReady();
      const q = queue.splice(0);
      if (cfg.capture) q.forEach(emit);
    }
  });
  const emit = (data) => {
    try { document.dispatchEvent(new CustomEvent('reqlab:hook', { detail: JSON.stringify(data) })); } catch { /* yok say */ }
  };
  const report = (data) => {
    if (!known) { if (queue.length < 300) queue.push(data); return; }
    if (cfg.capture) emit(data);
  };
  document.dispatchEvent(new CustomEvent('reqlab:hello'));

  const abs = (u) => { try { return new URL(String(u), location.href).href; } catch { return String(u); } };
  const noHash = (u) => u.split('#')[0];

  function wildcard(p) {
    return new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  }

  function matches(rule, method, url) {
    if (rule.method && rule.method !== 'ANY' && rule.method !== method) return false;
    const v = rule.pattern || '';
    try {
      if (rule.match === 'regex') return new RegExp(v, 'i').test(url);
      if (rule.match === 'equals') return noHash(url) === noHash(abs(v));
      if (rule.match === 'wildcard') return wildcard(v).test(url);
    } catch { return false; }
    return url.toLowerCase().includes(v.toLowerCase());
  }

  const findRule = (method, url) => (cfg.rules || []).find((r) => matches(r, method, url)) || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

  function clip(text) {
    const max = cfg.maxBody || 1048576;
    return text.length > max ? { text: text.slice(0, max), truncated: text.length } : { text };
  }

  // İstek gövdesini okunabilir metne çevir.
  function describeBody(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return clip(body);
      if (body instanceof URLSearchParams) return { ...clip(body.toString()), kind: 'urlencoded' };
      if (body instanceof FormData) {
        const fields = [];
        for (const [k, v] of body.entries()) fields.push([k, typeof v === 'string' ? v : `[file ${v.name || 'blob'} · ${v.size} B]`]);
        return { kind: 'form', fields };
      }
      if (body instanceof Blob) return { text: `[blob ${body.type || ''} · ${body.size} B]`, binary: true };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return clip(new TextDecoder().decode(bytes));
      }
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return { text: '[stream]', binary: true };
    } catch { /* yok say */ }
    return { text: String(body) };
  }

  const headerPairs = (h) => {
    const out = [];
    try { new Headers(h || {}).forEach((v, k) => out.push([k, v])); } catch { /* yok say */ }
    return out;
  };

  async function readResponse(res) {
    const type = res.headers.get('content-type') || '';
    if (/event-stream/i.test(type)) return { text: '[event-stream]', binary: true };
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > 20 * 1048576) return { text: `[${len} B]`, binary: true };
    if (!type || TEXT_TYPE.test(type)) return clip(await res.text());
    const blob = await res.blob();
    if (/^image\//i.test(type) && blob.size <= 262144) {
      const url = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(''); fr.readAsDataURL(blob); });
      return { text: '', dataUrl: url, size: blob.size, binary: true };
    }
    return { text: `[${type} · ${blob.size} B]`, size: blob.size, binary: true };
  }

  // ------------------------------------------------------------------ fetch

  const realFetch = window.fetch;
  if (realFetch) {
    const handle = function (input, init) {
      let method = 'GET';
      let url = '';
      try {
        method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        url = abs(input instanceof Request ? input.url : input);
      } catch { /* yok say */ }
      const rule = findRule(method, url);
      if (!rule && !capturing()) return realFetch.apply(this, arguments);

      const started = Date.now();
      const t0 = performance.now();
      const reqHeaders = headerPairs((init && init.headers) || (input instanceof Request ? input.headers : null));
      const reqBody = init && 'body' in init ? describeBody(init.body) : null;
      const base = { kind: 'fetch', method, url, started, reqHeaders, reqBody };

      if (rule && rule.action === 'mock') {
        const headers = new Headers(rule.headers || []);
        if (rule.contentType && !headers.has('content-type')) headers.set('content-type', rule.contentType);
        const status = Number(rule.status) || 200;
        const p = sleep(rule.delay).then(() => new Response([101, 204, 205, 304].includes(status) ? null : (rule.body || ''), { status, statusText: rule.statusText || '', headers }));
        if (capturing()) p.then((res) => report({ ...base, status, resHeaders: headerPairs(headers), resBody: clip(rule.body || ''), duration: performance.now() - t0, mocked: rule.id }));
        return p;
      }

      const args = arguments;
      const self = this;
      const go = () => realFetch.apply(self, args);
      const p = rule && rule.action === 'delay' ? sleep(rule.delay).then(go) : go();
      if (!capturing()) return p;
      p.then((res) => {
        const done = (resBody) => report({
          ...base, status: res.status, statusText: res.statusText, resHeaders: headerPairs(res.headers), resBody,
          responseUrl: res.url, redirected: res.redirected, duration: performance.now() - t0, delayed: rule ? rule.id : undefined
        });
        let clone;
        try { clone = res.clone(); } catch { done(null); return; }
        readResponse(clone).then(done, () => done(null));
      }, (err) => report({ ...base, error: String((err && err.message) || err), duration: performance.now() - t0 }));
      return p;
    };
    const wrapped = function fetch(input, init) {
      if (settled) return handle.apply(this, arguments);
      const self = this;
      const args = arguments;
      return ready.then(() => handle.apply(self, args));
    };
    try { Object.defineProperty(wrapped, 'toString', { value: () => realFetch.toString() }); } catch { /* yok say */ }
    window.fetch = wrapped;
  }

  // ------------------------------------------------------------------ XMLHttpRequest

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    const setHeader = XHR.setRequestHeader;

    XHR.open = function (method, url) {
      try { this.__reqlab = { method: String(method).toUpperCase(), url: abs(url), headers: [], async: arguments[2] !== false }; } catch { /* yok say */ }
      return open.apply(this, arguments);
    };
    XHR.setRequestHeader = function (k, v) {
      if (this.__reqlab) this.__reqlab.headers.push([String(k), String(v)]);
      return setHeader.apply(this, arguments);
    };

    function parseRawHeaders(raw) {
      return String(raw || '').trim().split(/[\r\n]+/).filter(Boolean).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
      });
    }

    function xhrBody(xhr) {
      try {
        const t = xhr.responseType;
        if (t === '' || t === 'text') return clip(xhr.responseText || '');
        if (t === 'json') return clip(JSON.stringify(xhr.response));
        if (t === 'document') return clip(xhr.response && xhr.response.documentElement ? xhr.response.documentElement.outerHTML : '');
        if (t === 'arraybuffer') return { text: `[arraybuffer · ${xhr.response ? xhr.response.byteLength : 0} B]`, binary: true };
        if (t === 'blob') return { text: `[blob · ${xhr.response ? xhr.response.size : 0} B]`, binary: true };
      } catch { /* yok say */ }
      return null;
    }

    // Sahte yanıt: ağa çıkmadan XHR'ın yanıt alanlarını doldur ve olayları sırayla tetikle.
    function mockXhr(xhr, info, rule, t0) {
      const status = Number(rule.status) || 200;
      const headers = (rule.headers || []).map(([k, v]) => [String(k).toLowerCase(), String(v)]);
      if (rule.contentType && !headers.some(([k]) => k === 'content-type')) headers.push(['content-type', rule.contentType]);
      const raw = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
      const body = rule.body || '';
      const def = (k, v) => { try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch { /* yok say */ } };
      setTimeout(() => {
        let response = body;
        if (xhr.responseType === 'json') { try { response = JSON.parse(body); } catch { response = null; } }
        def('readyState', 4); def('status', status); def('statusText', rule.statusText || 'OK');
        def('responseURL', info.url); def('responseText', body); def('response', response);
        xhr.getAllResponseHeaders = () => raw + (raw ? '\r\n' : '');
        xhr.getResponseHeader = (n) => { const h = headers.find(([k]) => k === String(n).toLowerCase()); return h ? h[1] : null; };
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new ProgressEvent('load', { loaded: body.length, total: body.length }));
        xhr.dispatchEvent(new ProgressEvent('loadend', { loaded: body.length, total: body.length }));
        if (capturing()) report({ ...info, kind: 'xhr', status, resHeaders: headers, resBody: clip(body), duration: performance.now() - t0, mocked: rule.id });
      }, Math.max(0, Number(rule.delay) || 0));
    }

    XHR.send = function (body) {
      const info = this.__reqlab;
      if (!info) return send.apply(this, arguments);
      if (!settled && info.async) {
        const args = arguments;
        ready.then(() => { try { XHR.send.apply(this, args); } catch { /* sayfa isteği iptal etti */ } });
        return undefined;
      }
      const rule = findRule(info.method, info.url);
      if (!rule && !capturing()) return send.apply(this, arguments);
      const t0 = performance.now();
      const base = { kind: 'xhr', method: info.method, url: info.url, started: Date.now(), reqHeaders: info.headers.slice(), reqBody: describeBody(body) };
      if (rule && rule.action === 'mock') { mockXhr(this, base, rule, t0); return undefined; }
      if (capturing()) {
        this.addEventListener('loadend', () => {
          report({
            ...base, status: this.status, statusText: this.statusText, resHeaders: parseRawHeaders(this.getAllResponseHeaders()),
            resBody: xhrBody(this), responseUrl: this.responseURL, duration: performance.now() - t0,
            error: this.status === 0 ? 'network' : undefined, delayed: rule ? rule.id : undefined
          });
        });
      }
      if (rule && rule.action === 'delay') {
        const args = arguments;
        setTimeout(() => { try { send.apply(this, args); } catch { /* yok say */ } }, Math.max(0, Number(rule.delay) || 0));
        return undefined;
      }
      return send.apply(this, arguments);
    };
  }
})();
