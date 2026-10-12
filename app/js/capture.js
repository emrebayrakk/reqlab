// Ağ yakalama: chrome.webRequest ile sayfaların bütün istekleri (belge, fetch/XHR, betik, görsel…),
// sayfa kancasından (content/hook.js) gelen fetch/XHR gövdeleriyle birleştirilir.
// Yakalama bu pencere açıkken çalışır; pencere kapanınca hiçbir şey dinlenmez.

const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

export const TYPE_GROUPS = {
  xhr: ['xmlhttprequest'],
  doc: ['main_frame', 'sub_frame'],
  js: ['script'],
  css: ['stylesheet'],
  img: ['image', 'imageset'],
  media: ['media'],
  font: ['font'],
  ws: ['websocket', 'webtransport'],
  other: ['ping', 'csp_report', 'object', 'other', 'webbundle']
};
export function typeGroup(type) {
  for (const [g, list] of Object.entries(TYPE_GROUPS)) if (list.includes(type)) return g;
  return 'other';
}

function pairs(list) {
  return (list || []).map((x) => [x.name, x.value != null ? x.value : x.binaryValue ? new TextDecoder().decode(new Uint8Array(x.binaryValue)) : '']);
}

function decodeRequestBody(rb, max) {
  if (!rb) return null;
  if (rb.error) return { text: `[${rb.error}]`, binary: true };
  if (rb.formData) {
    const fields = [];
    for (const [k, vs] of Object.entries(rb.formData)) for (const v of vs) fields.push([k, v]);
    return { kind: 'form', fields };
  }
  if (rb.raw) {
    const chunks = [];
    let size = 0;
    let files = 0;
    for (const p of rb.raw) {
      if (p.bytes) { chunks.push(new Uint8Array(p.bytes)); size += p.bytes.byteLength; } else if (p.file) files++;
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    let text = new TextDecoder('utf-8').decode(all.subarray(0, Math.min(size, max)));
    const bad = (text.match(/�/g) || []).length;
    if (bad > 8 && bad > text.length / 50) return { text: `[binary · ${size} B]`, binary: true, size };
    if (files) text += `\n[+${files} file]`;
    return size > max ? { text, truncated: size, size } : { text, size };
  }
  return null;
}

export class Capture extends EventTarget {
  constructor({ ownTabId = null, lockTab = null, maxEntries = 3000, maxBody = 1048576 } = {}) {
    super();
    this.ownTabId = ownTabId;
    this.lockTab = lockTab;
    this.maxEntries = maxEntries;
    this.maxBody = maxBody;
    this.entries = [];
    this.byRid = new Map();
    this.seq = 0;
    this.recording = true;
    this.preserve = false;
    this.version = 0;
    this._queued = false;
    this._beat = 0;
    this.filter = null; // filters.compile(...) — yalnızca "yakalamaya uygula" açıkken
  }

  // Yan panelden "Büyüt" ile gelen istekleri listeye al (kimlikler yeniden verilir).
  importEntries(list) {
    for (const e of list || []) { e.id = ++this.seq; e.rid = 'h-' + e.id; this.entries.push(e); }
    this.changed();
  }

  setFilter(compiled) {
    this.filter = compiled;
    this.changed();
  }

  remove(e) {
    const i = this.entries.lastIndexOf(e);
    if (i >= 0) { this.entries.splice(i, 1); this.changed(); }
    if (this.byRid.get(e.rid) === e) this.byRid.delete(e.rid);
  }

  // İstek bitince filtrenin ikinci aşaması; gövde gerekiyorsa kancanın kaydını en fazla 3 sn bekler.
  postCheck(e) {
    const f = this.filter;
    if (!f || e.state === 'pending') return;
    if (f.needsBody && !e.hook && e.type === 'xmlhttprequest' && !e._waitBody) {
      e._waitBody = true;
      setTimeout(() => this.postCheck(e), 3000);
      return;
    }
    if (!f.post(e)) this.remove(e);
  }

  changed() {
    this.version++;
    if (this._queued) return;
    this._queued = true;
    setTimeout(() => { this._queued = false; this.dispatchEvent(new Event('change')); }, 80);
  }

  skip(d) {
    if (this.lockTab != null && d.tabId !== this.lockTab) return true;
    if (this.ownTabId != null && d.tabId === this.ownTabId) return true;
    if ((d.initiator || '').startsWith(OWN_ORIGIN) || d.url.startsWith(OWN_ORIGIN)) return true;
    if (d.url.startsWith('chrome-extension://') || d.url.startsWith('devtools://')) return true;
    return false;
  }

  start() {
    const filter = { urls: ['<all_urls>'] };
    if (this.lockTab != null) filter.tabId = this.lockTab;
    const wr = chrome.webRequest;
    wr.onBeforeRequest.addListener((d) => this.onBefore(d), filter, ['requestBody']);
    wr.onSendHeaders.addListener((d) => this.onSend(d), filter, ['requestHeaders', 'extraHeaders']);
    wr.onHeadersReceived.addListener((d) => this.onHeaders(d), filter, ['responseHeaders', 'extraHeaders']);
    wr.onBeforeRedirect.addListener((d) => this.onRedirect(d), filter, ['responseHeaders', 'extraHeaders']);
    wr.onCompleted.addListener((d) => this.onDone(d), filter, ['responseHeaders', 'extraHeaders']);
    wr.onErrorOccurred.addListener((d) => this.onError(d), filter);
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === 'reqlab:hook' && sender.tab) this.onHook(msg.data, sender);
      return false;
    });
    this.heartbeat();
    this._beat = setInterval(() => this.heartbeat(), 20000);
  }

  // Sayfalardaki köprüye "pencere açık, gövdeleri gönder" sinyali.
  heartbeat() {
    if (!this.recording) return;
    chrome.storage.local.set({ live: { until: Date.now() + 60000 } }).catch(() => {});
  }

  setRecording(on) {
    this.recording = on;
    if (on) this.heartbeat();
    this.changed();
  }

  add(e) {
    this.entries.push(e);
    if (this.entries.length > this.maxEntries) {
      const drop = this.entries.splice(0, this.entries.length - this.maxEntries);
      for (const x of drop) if (this.byRid.get(x.rid) === x) this.byRid.delete(x.rid);
    }
    this.changed();
    return e;
  }

  clear(tabId) {
    if (tabId == null) { this.entries = []; this.byRid.clear(); }
    else {
      this.entries = this.entries.filter((e) => e.tabId !== tabId);
      for (const [k, e] of this.byRid) if (e.tabId === tabId) this.byRid.delete(k);
    }
    this.dispatchEvent(new Event('clear'));
    this.changed();
  }

  newEntry(d, extra) {
    return {
      id: ++this.seq, rid: d.requestId, tabId: d.tabId, frameId: d.frameId, url: d.url, method: d.method, type: d.type,
      initiator: d.initiator || '', documentUrl: d.documentUrl || '', start: d.timeStamp, tSent: 0, tHeaders: 0, tEnd: 0,
      status: 0, statusText: '', protocol: '', reqHeaders: null, reqBody: null, resHeaders: null, ip: '', fromCache: false,
      error: '', redirectTo: '', hook: null, source: 'net', state: 'pending', ...extra
    };
  }

  onBefore(d) {
    if (this.skip(d)) return;
    if (d.type === 'main_frame' && !this.preserve && d.tabId >= 0) this.clear(d.tabId);
    if (!this.recording) return;
    const prev = this.byRid.get(d.requestId);
    if (prev && prev.state === 'redirected') {
      // Yönlendirmeden sonra aynı istek kimliğiyle yeni adım.
      const e = this.newEntry(d, { redirectFrom: prev.id });
      if (this.filter && !this.filter.pre(e)) { this.byRid.delete(d.requestId); return; }
      this.byRid.set(d.requestId, e);
      this.add(e);
      return;
    }
    const e = this.newEntry(d, { reqBody: decodeRequestBody(d.requestBody, this.maxBody) });
    if (this.filter && !this.filter.pre(e)) return;
    this.byRid.set(d.requestId, e);
    this.add(e);
  }

  onSend(d) {
    const e = this.byRid.get(d.requestId);
    if (!e) return;
    e.reqHeaders = pairs(d.requestHeaders);
    e.tSent = d.timeStamp;
    this.changed();
  }

  applyResponse(e, d) {
    e.status = d.statusCode || e.status;
    const m = /^(\S+)\s+\d+\s*(.*)$/.exec(d.statusLine || '');
    if (m) { e.protocol = m[1]; e.statusText = m[2] || e.statusText; }
    if (d.responseHeaders) e.resHeaders = pairs(d.responseHeaders);
    if (d.ip) e.ip = d.ip;
    if (d.fromCache) e.fromCache = true;
  }

  onHeaders(d) {
    const e = this.byRid.get(d.requestId);
    if (!e) return;
    this.applyResponse(e, d);
    e.tHeaders = d.timeStamp;
    this.changed();
  }

  onRedirect(d) {
    const e = this.byRid.get(d.requestId);
    if (!e) return;
    this.applyResponse(e, d);
    e.redirectTo = d.redirectUrl;
    e.tHeaders = e.tHeaders || d.timeStamp;
    e.tEnd = d.timeStamp;
    e.state = 'redirected';
    this.changed();
    if (this.filter && !this.filter.post(e)) this.remove(e);
  }

  onDone(d) {
    const e = this.byRid.get(d.requestId);
    if (!e) return;
    this.applyResponse(e, d);
    e.tEnd = d.timeStamp;
    e.tHeaders = e.tHeaders || d.timeStamp;
    e.state = 'done';
    this.byRid.delete(d.requestId);
    this.changed();
    this.postCheck(e);
  }

  onError(d) {
    const e = this.byRid.get(d.requestId);
    if (!e) return;
    e.error = d.error || 'error';
    e.tEnd = d.timeStamp;
    e.state = 'error';
    this.byRid.delete(d.requestId);
    this.changed();
    this.postCheck(e);
  }

  // Kancadan gelen fetch/XHR kaydını webRequest kaydıyla eşleştir; eşleşme yoksa (sahte yanıt, servis çalışanı)
  // ayrı bir satır olarak ekle.
  onHook(data, sender) {
    const tabId = sender.tab.id;
    if (this.lockTab != null && tabId !== this.lockTab) return;
    if (this.ownTabId != null && tabId === this.ownTabId) return;
    if (!data || !data.url) return;
    const url = data.url.split('#')[0];
    let best = null;
    if (!data.mocked) {
      for (let i = this.entries.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
        const e = this.entries[i];
        if (e.hook || e.tabId !== tabId || e.method !== data.method) continue;
        if (e.url.split('#')[0] !== url) continue;
        if (e.type !== 'xmlhttprequest' && e.type !== 'other' && e.type !== 'ping') continue;
        const dt = e.start - data.started;
        if (dt < -1500 || dt > 15000) continue;
        if (!best || Math.abs(dt) < Math.abs(best.start - data.started)) best = e;
      }
    }
    if (best) {
      best.hook = data;
      if (!best.status && data.status) best.status = data.status;
      this.changed();
      this.postCheck(best);
      return;
    }
    if (!this.recording) return;
    const start = data.started || Date.now();
    const entry = ({
      id: ++this.seq, rid: 'hook-' + this.seq, tabId, frameId: sender.frameId || 0, url: data.url, method: data.method, type: 'xmlhttprequest',
      initiator: (() => { try { return new URL(sender.url).origin; } catch { return ''; } })(), documentUrl: sender.url || '',
      start, tSent: start, tHeaders: start + (data.duration || 0), tEnd: start + (data.duration || 0),
      status: data.status || 0, statusText: data.statusText || '', protocol: '', reqHeaders: data.reqHeaders || [], reqBody: null,
      resHeaders: data.resHeaders || [], ip: '', fromCache: false, error: data.error || '', redirectTo: '', hook: data,
      source: data.mocked ? 'mock' : 'hook', state: data.error ? 'error' : 'done'
    });
    if (this.filter && !this.filter.all(entry)) return;
    this.add(entry);
  }

  stop() {
    clearInterval(this._beat);
  }
}

// ---------------------------------------------------------------- kayıt yardımcıları

export const duration = (e) => (e.tEnd && e.start ? e.tEnd - e.start : e.hook && e.hook.duration != null ? e.hook.duration : null);

export function responseSize(e) {
  const cl = (e.resHeaders || []).find(([k]) => k.toLowerCase() === 'content-length');
  if (cl && !isNaN(Number(cl[1]))) return Number(cl[1]);
  const b = e.hook && e.hook.resBody;
  if (b) return b.size != null ? b.size : b.truncated || (b.text ? new Blob([b.text]).size : null);
  return null;
}

export function contentType(e) {
  const h = (e.resHeaders || []).find(([k]) => k.toLowerCase() === 'content-type');
  return h ? h[1] : '';
}

// İstek gövdesi: kancadaki (daha doğru) yoksa webRequest'teki.
export function requestBody(e) {
  const hb = e.hook && e.hook.reqBody;
  if (hb && (hb.text != null || hb.fields)) return hb;
  return e.reqBody;
}

export function responseBody(e) {
  const b = e.hook && e.hook.resBody;
  if (!b) return null;
  return { ...b, contentType: contentType(e) || ((e.hook.resHeaders || []).find(([k]) => k === 'content-type') || [])[1] || '' };
}

export function toHar(entries, version) {
  const hdr = (list) => (list || []).map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'ReqLab', version },
      pages: [],
      entries: entries.map((e) => {
        const qs = (() => { try { return [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; } })();
        const rb = requestBody(e);
        const resb = responseBody(e);
        const ct = (e.reqHeaders || []).find(([k]) => k.toLowerCase() === 'content-type');
        const total = duration(e) || 0;
        const wait = e.tHeaders && e.tSent ? e.tHeaders - e.tSent : 0;
        const req = {
          method: e.method, url: e.url, httpVersion: e.protocol || 'HTTP/1.1', headers: hdr(e.reqHeaders), queryString: qs,
          cookies: [], headersSize: -1, bodySize: rb && rb.text ? rb.text.length : 0
        };
        if (rb) {
          req.postData = rb.fields
            ? { mimeType: ct ? ct[1] : 'application/x-www-form-urlencoded', params: rb.fields.map(([name, value]) => ({ name, value })), text: new URLSearchParams(rb.fields).toString() }
            : { mimeType: ct ? ct[1] : '', text: rb.text || '' };
        }
        const content = { size: responseSize(e) || 0, mimeType: contentType(e) || 'x-unknown' };
        if (resb && resb.text && !resb.binary) content.text = resb.text;
        return {
          startedDateTime: new Date(e.start).toISOString(), time: total, request: req,
          response: {
            status: e.status || 0, statusText: e.statusText || '', httpVersion: e.protocol || 'HTTP/1.1', headers: hdr(e.resHeaders),
            cookies: [], content, redirectURL: e.redirectTo || '', headersSize: -1, bodySize: -1, _error: e.error || undefined
          },
          cache: {},
          timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: Math.max(0, wait), receive: Math.max(0, total - Math.max(0, wait)) },
          serverIPAddress: e.ip || undefined,
          _resourceType: e.type
        };
      })
    }
  };
}
