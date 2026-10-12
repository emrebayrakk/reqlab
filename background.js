// ReqLab arka planı:
//  - simgeye tıklanınca uygulamayı ayara göre yan panelde (varsayılan, F12 gibi), sekmede, ayrı pencerede ya da tam ekran açar,
//  - "sayfa kancası" (content/hook.js) ayara göre kaydedilir,
//  - engelle / yönlendir / başlık kuralları declarativeNetRequest dinamik kurallarına çevrilir,
//  - İstemci'den gelen istekleri gönderir (eklenti ya da sayfa bağlamında); tarayıcının yasakladığı
//    başlıklar (Cookie, Origin, Referer, User-Agent…) yalnızca o istek için oturum kuralıyla eklenir.

const APP_URL = chrome.runtime.getURL('app/index.html');
const HOOK_ID = 'reqlab-hook';
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
const DNR_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

// ---------------------------------------------------------------- uygulama sekmesi

// mode: 'tab' | 'window' (adres çubuğu olmayan uygulama penceresi) | 'fullscreen'; verilmezse ayardan.
// src: simgeye tıklanırken etkin olan sekme. Uygulama onun hemen sağında açılır ve listesi o sekmeye odaklanır.
async function openApp(mode, src) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!mode) mode = settings.openMode || 'panel';
  if (mode === 'panel') mode = 'tab'; // yan panel tarayıcının kendi davranışıyla açılır; buraya düşerse sekme
  const web = src && src.id >= 0 && /^(https?|file):/.test(src.url || '') ? src : null;
  const focus = web && settings.focusSource !== false ? web.id : null;
  const url = APP_URL + (focus != null ? '?from=' + focus : '');
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const own = ctxs.find((c) => c.tabId >= 0 && (c.documentUrl || '').startsWith(APP_URL) && !c.documentUrl.includes('panel=1'));
    if (own) {
      // Sekme olarak açıksa bulunduğun sekmenin yanına taşı.
      if (mode === 'tab' && web) {
        const ownWin = await chrome.windows.get(own.windowId).catch(() => null);
        if (ownWin && ownWin.type === 'normal' && web.windowId != null) {
          const srcWin = await chrome.windows.get(web.windowId).catch(() => null);
          if (srcWin && srcWin.type === 'normal') await chrome.tabs.move(own.tabId, { windowId: web.windowId, index: web.index + (own.windowId === web.windowId && (await chrome.tabs.get(own.tabId)).index < web.index ? 0 : 1) }).catch(() => {});
        }
      }
      const tab = await chrome.tabs.update(own.tabId, { active: true });
      const win = await chrome.windows.get(tab.windowId);
      // Zaten açık: öne getir; tam ekran istendiyse ve sekme kendi penceresindeyse pencereyi tam ekrana al.
      const alone = (await chrome.tabs.query({ windowId: win.id })).length === 1;
      const state = mode === 'fullscreen' && alone ? 'fullscreen' : win.state === 'minimized' ? 'normal' : undefined;
      await chrome.windows.update(win.id, { focused: true, ...(state ? { state } : {}) });
      if (mode === 'fullscreen' && !alone) {
        const w = await chrome.windows.create({ tabId: tab.id, type: 'popup', focused: true });
        await chrome.windows.update(w.id, { state: 'fullscreen' }).catch(() => {});
      }
      notifyWin();
      // Yan panelden "Büyüt" ile gelindiyse açık olan uygulama istekleri devralsın.
      setTimeout(() => chrome.runtime.sendMessage({ type: 'reqlab:handoff' }).catch(() => {}), 100);
      if (focus != null) setTimeout(() => chrome.runtime.sendMessage({ type: 'reqlab:focusTab', tabId: focus }).catch(() => {}), 200);
      return;
    }
  } catch { /* yeni aç */ }
  if (mode === 'window' || mode === 'fullscreen') {
    // Önce oluştur, sonra durumunu ver: oluştururken verilen durum her ortamda uygulanmıyor.
    const w = await chrome.windows.create({ url, type: 'popup', focused: true });
    await settle(w.tabs && w.tabs[0] ? w.tabs[0].id : null);
    await chrome.windows.update(w.id, { state: mode === 'fullscreen' ? 'fullscreen' : 'maximized' }).catch(() => {});
  } else if (web) {
    await chrome.tabs.create({ url, windowId: web.windowId, index: web.index + 1, openerTabId: web.id });
  } else await chrome.tabs.create({ url });
  notifyWin();
}

// Yeni pencerenin sayfası yüklenene kadar (en fazla 1,5 sn) bekle; hemen verilen durum yok sayılabiliyor.
function settle(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) { setTimeout(resolve, 300); return; }
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, 1500);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// Uygulama sayfası pencere durumunu (tam ekran mı) yeniden okusun.
function notifyWin() {
  setTimeout(() => chrome.runtime.sendMessage({ type: 'reqlab:win' }).catch(() => {}), 150);
}

// Yan panel modunda simge tıklamasını tarayıcı karşılar; buraya yalnızca diğer modlarda (ya da panel desteklenmiyorsa) düşer.
chrome.action.onClicked.addListener((tab) => {
  if ((modeCache || 'panel') === 'panel' && panelSupported()) { openPanelNow(tab).catch(() => openApp('tab', tab)); return; }
  openApp(undefined, tab);
});

// Açılış biçimi "yan panel" ise simgeye tıklamak paneli tarayıcının kendisi açar (onClicked çalışmaz).
const panelSupported = () => !!(chrome.sidePanel && typeof chrome.sidePanel.open === 'function' && typeof chrome.sidePanel.setPanelBehavior === 'function');

// Açılış biçimi önbelleği: kısayol olayında paneli açmak için beklemeden (kullanıcı hareketi kaybolmadan) bilinmeli.
let modeCache;
chrome.storage.local.get('settings').then(({ settings = {} }) => { modeCache = settings.openMode || 'panel'; });

async function syncPanel() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  modeCache = settings.openMode || 'panel';
  // Yan paneli desteklemeyen tarayıcıda simge tıklaması sekmede açar (onClicked).
  const panel = modeCache === 'panel' && panelSupported();
  await chrome.sidePanel.setOptions({ path: 'app/index.html?panel=1', enabled: true }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}

// Klavye kısayolları. Yan panel kullanıcı hareketiyle açılabildiği için önce (beklemeden) denenir; olmazsa sekme.
function openPanelNow(tab) {
  if (!panelSupported() || !tab) return Promise.reject(new Error('noPanel'));
  return tab.id >= 0 ? chrome.sidePanel.open({ tabId: tab.id }) : chrome.sidePanel.open({ windowId: tab.windowId });
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-panel') {
    openPanelNow(tab).catch(() => openApp('tab', tab));
  } else if (command === 'open-tab') {
    openApp('tab', tab);
  }
});

// Simgeye sağ tık: açılış biçimini o an seç.
const MENU = [['open-panel', 'menuOpenPanel', 'panel'], ['open-tab', 'menuOpenTab', 'tab'], ['open-window', 'menuOpenWindow', 'window'], ['open-fullscreen', 'menuOpenFullscreen', 'fullscreen']];
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, msg] of MENU) chrome.contextMenus.create({ id, title: chrome.i18n.getMessage(msg) || id, contexts: ['action'] });
  });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Yan panel yalnızca kullanıcı hareketiyle açılabilir: başka bir await'ten önce çağrılmalı.
  if (info.menuItemId === 'open-panel') {
    openPanelNow(tab).catch(() => openApp('tab', tab));
    return;
  }
  const m = MENU.find(([id]) => id === info.menuItemId);
  if (m) openApp(m[2], tab);
});

// ---------------------------------------------------------------- sayfa kancası

async function syncHook() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const want = settings.hook !== false;
  const got = await chrome.scripting.getRegisteredContentScripts({ ids: [HOOK_ID] }).catch(() => []);
  if (want && !got.length) {
    await chrome.scripting.registerContentScripts([{
      id: HOOK_ID, js: ['content/hook.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', allFrames: true, persistAcrossSessions: true
    }]).catch((e) => console.warn('[reqlab] hook', e));
  } else if (!want && got.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] }).catch(() => {});
  }
}

// ---------------------------------------------------------------- kurallar -> declarativeNetRequest

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function urlCondition(r) {
  const p = String(r.pattern || '').trim();
  if (!p) return { error: 'emptyPattern' };
  if (r.match === 'regex') return { regexFilter: p };
  if (r.match === 'equals') return { regexFilter: '^' + escRe(p.split('#')[0]) + '$' };
  if (r.match === 'wildcard') return /^\*+$/.test(p) ? {} : { urlFilter: (p.includes('://') ? '|' : '') + p };
  return /[*^|]/.test(p) ? { regexFilter: escRe(p) } : { urlFilter: p };
}

function toDnr(r, id) {
  const cond = urlCondition(r);
  if (cond.error) return cond;
  const condition = { ...cond, resourceTypes: ALL_TYPES, isUrlFilterCaseSensitive: false };
  const m = String(r.method || 'ANY').toLowerCase();
  if (m !== 'any') condition.requestMethods = [DNR_METHODS.has(m) ? m : 'other'];
  let action;
  if (r.action === 'block') action = { type: 'block' };
  else if (r.action === 'redirect') {
    const to = String(r.redirectUrl || '').trim();
    if (!to) return { error: 'emptyRedirect' };
    action = { type: 'redirect', redirect: r.match === 'regex' && /\\\d/.test(to) ? { regexSubstitution: to } : { url: to } };
  } else if (r.action === 'reqHeaders' || r.action === 'resHeaders') {
    const list = (r.headers || []).filter((h) => h && h.k && h.on !== false).map((h) => {
      const op = h.op === 'remove' ? 'remove' : h.op === 'append' && r.action === 'resHeaders' ? 'append' : 'set';
      return op === 'remove' ? { header: h.k.trim(), operation: op } : { header: h.k.trim(), operation: op, value: String(h.v || '') };
    });
    if (!list.length) return { error: 'emptyHeaders' };
    action = { type: 'modifyHeaders', [r.action === 'reqHeaders' ? 'requestHeaders' : 'responseHeaders']: list };
  } else return null;
  return { id, priority: r.action === 'block' ? 3 : r.action === 'redirect' ? 2 : 1, action, condition };
}

let rulesBusy = Promise.resolve();
function syncRules() {
  rulesBusy = rulesBusy.then(async () => {
    const { rules = [] } = await chrome.storage.local.get('rules');
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    const errors = {};
    const add = [];
    let n = 1;
    for (const r of rules) {
      if (!r || r.enabled === false) continue;
      const d = toDnr(r, n++);
      if (!d) continue;
      if (d.error) { errors[r.id] = d.error; continue; }
      if (d.condition.regexFilter) {
        const ok = await chrome.declarativeNetRequest.isRegexSupported({ regex: d.condition.regexFilter }).catch(() => ({ isSupported: false }));
        if (!ok.isSupported) { errors[r.id] = 'badRegex'; continue; }
      }
      d.__src = r.id;
      add.push(d);
    }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((x) => x.id) }).catch(() => {});
    // Tek tek eklenir: hatalı bir kural diğerlerini düşürmesin.
    for (const d of add) {
      const src = d.__src;
      delete d.__src;
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [d] }).catch((e) => { errors[src] = String((e && e.message) || e).slice(0, 160); });
    }
    await chrome.storage.local.set({ ruleErrors: errors });
  }).catch((e) => console.warn('[reqlab] rules', e));
  return rulesBusy;
}

// ---------------------------------------------------------------- istek gönderme

// fetch'in sessizce attığı başlıklar. Bunların bir kısmı oturum kuralıyla ayarlanabilir.
const FORBIDDEN = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent']);
const NOT_SETTABLE = new Set(['connection', 'content-length', 'host', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect', 'date', 'via', 'cookie2']);
const isForbidden = (k) => FORBIDDEN.has(k) || k.startsWith('sec-') || k.startsWith('proxy-');
const TEXT_TYPE = /(json|text|xml|javascript|ecmascript|html|css|csv|graphql|x-www-form-urlencoded|yaml|svg)/i;

const aborts = new Map();
let sessionRuleId = 900000;
let forcedLock = Promise.resolve();

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function buildBody(req) {
  const b = req.body || {};
  if (b.type === 'form') return new URLSearchParams(b.fields || []);
  if (b.type === 'multipart') {
    const fd = new FormData();
    for (const [k, v] of b.fields || []) fd.append(k, v);
    return fd;
  }
  if (b.type === 'base64') {
    const bin = atob(b.text || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return b.type === 'text' ? String(b.text || '') : undefined;
}

async function decodeResponse(res, buf, limit) {
  const type = res.headers.get('content-type') || '';
  const out = { size: buf.byteLength, contentType: type };
  let text = null;
  if (!type || TEXT_TYPE.test(type)) {
    try { text = new TextDecoder('utf-8', { fatal: !type }).decode(buf); } catch { text = null; }
  }
  if (text != null) {
    if (text.length > limit) { out.truncated = text.length; text = text.slice(0, limit); }
    out.body = text;
  } else if (buf.byteLength <= 3 * 1048576) {
    out.base64 = b64(buf);
  }
  return out;
}

async function addForcedHeaders(url, method, forced) {
  const regex = '^' + escRe(url.split('#')[0]) + '$';
  if (regex.length > 1800) return { error: 'urlTooLong' };
  const sup = await chrome.declarativeNetRequest.isRegexSupported({ regex }).catch(() => ({ isSupported: false }));
  if (!sup.isSupported) return { error: 'urlTooComplex' };
  const id = ++sessionRuleId;
  const m = method.toLowerCase();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id, priority: 100,
      action: { type: 'modifyHeaders', requestHeaders: forced.map(([k, v]) => ({ header: k, operation: 'set', value: v })) },
      condition: { regexFilter: regex, tabIds: [chrome.tabs.TAB_ID_NONE], requestMethods: [DNR_METHODS.has(m) ? m : 'other'], resourceTypes: ['xmlhttprequest', 'other'] }
    }]
  });
  return { id };
}

async function sendRequest(msg) {
  const req = msg.req || {};
  const id = msg.id;
  const method = String(req.method || 'GET').toUpperCase();
  const headers = new Headers();
  const forced = [];
  const dropped = [];
  for (const [k0, v] of req.headers || []) {
    const k = String(k0 || '').trim();
    if (!k) continue;
    const lk = k.toLowerCase();
    if (isForbidden(lk)) {
      if (NOT_SETTABLE.has(lk)) { dropped.push(k); continue; }
      // Aynı yasaklı başlık iki kez yazıldıysa sonuncusu geçerli (ağ kuralı yinelenen başlıkta ilkini alır).
      const i = forced.findIndex(([x]) => x === lk);
      if (i >= 0) forced.splice(i, 1);
      forced.push([lk, String(v)]);
      continue;
    }
    try { headers.append(k, String(v)); } catch { dropped.push(k); }
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : buildBody(req);
  const ctl = new AbortController();
  aborts.set(id, ctl);
  const timeout = Math.max(0, Number(req.timeout) || 0);
  const timer = timeout ? setTimeout(() => ctl.abort('timeout'), timeout) : 0;
  const notes = { dropped };

  const run = async () => {
    let rule = null;
    if (forced.length) {
      rule = await addForcedHeaders(req.url, method, forced).catch((e) => ({ error: String(e.message || e) }));
      if (rule.error) { notes.forcedError = rule.error; rule = null; } else notes.forced = forced.map(([k]) => k);
    }
    const t0 = performance.now();
    try {
      const res = await fetch(req.url, {
        method, headers, body, signal: ctl.signal, cache: 'no-store',
        credentials: req.credentials === false ? 'omit' : 'include',
        redirect: req.redirect === 'manual' ? 'manual' : req.redirect === 'error' ? 'error' : 'follow'
      });
      const ttfb = performance.now() - t0;
      const buf = await res.arrayBuffer();
      const time = performance.now() - t0;
      return {
        ok: true, status: res.status, statusText: res.statusText, type: res.type, url: res.url, redirected: res.redirected,
        headers: [...res.headers], time, ttfb, notes, ...(await decodeResponse(res, buf, Number(req.maxBody) || 5 * 1048576))
      };
    } catch (e) {
      const time = performance.now() - t0;
      const reason = ctl.signal.aborted ? (ctl.signal.reason === 'timeout' ? 'timeout' : 'aborted') : String((e && e.message) || e);
      return { ok: false, error: reason, time, notes };
    } finally {
      if (rule && rule.id) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id] }).catch(() => {});
    }
  };

  try {
    if (!forced.length) return await run();
    // Aynı adrese aynı anda iki zorlanmış başlıklı istek gitmesin diye sıraya al.
    const p = forcedLock.then(run, run);
    forcedLock = p.catch(() => {});
    return await p;
  } finally {
    clearTimeout(timer);
    aborts.delete(id);
  }
}

// Sayfanın içinde (MAIN dünya) çalışır: sayfanın kökeni, çerezleri ve CORS kurallarıyla gönderir.
async function pageFetch(req) {
  const t0 = performance.now();
  const opts = { method: req.method, headers: req.headers, credentials: req.credentials === false ? 'omit' : 'include', redirect: req.redirect || 'follow', cache: 'no-store' };
  const b = req.body || {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (b.type === 'form') opts.body = new URLSearchParams(b.fields || []);
    else if (b.type === 'multipart') { const fd = new FormData(); for (const [k, v] of b.fields || []) fd.append(k, v); opts.body = fd; }
    else if (b.type === 'text') opts.body = b.text || '';
  }
  const ctl = new AbortController();
  const timer = req.timeout ? setTimeout(() => ctl.abort(), req.timeout) : 0;
  opts.signal = ctl.signal;
  try {
    const res = await fetch(req.url, opts);
    const ttfb = performance.now() - t0;
    const buf = await res.arrayBuffer();
    const time = performance.now() - t0;
    const type = res.headers.get('content-type') || '';
    const out = { ok: true, status: res.status, statusText: res.statusText, type: res.type, url: res.url, redirected: res.redirected, headers: [...res.headers], time, ttfb, size: buf.byteLength, contentType: type, notes: { origin: location.origin } };
    let text = null;
    if (!type || /(json|text|xml|javascript|html|css|csv|graphql|urlencoded|yaml|svg)/i.test(type)) {
      try { text = new TextDecoder('utf-8', { fatal: !type }).decode(buf); } catch { text = null; }
    }
    const limit = req.maxBody || 5 * 1048576;
    if (text != null) { if (text.length > limit) { out.truncated = text.length; text = text.slice(0, limit); } out.body = text; } else if (buf.byteLength <= 3 * 1048576) {
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      out.base64 = btoa(s);
    }
    return out;
  } catch (e) {
    return { ok: false, error: ctl.signal.aborted ? 'timeout' : String((e && e.message) || e), time: performance.now() - t0, notes: { origin: location.origin } };
  } finally {
    clearTimeout(timer);
  }
}

async function sendInPage(msg) {
  const req = msg.req || {};
  const headers = {};
  for (const [k, v] of req.headers || []) if (k) headers[k] = v;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: Number(msg.tabId) }, world: 'MAIN', func: pageFetch,
      args: [{ ...req, method: String(req.method || 'GET').toUpperCase(), headers }]
    });
    return r && r.result ? r.result : { ok: false, error: 'noResult' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------- mesajlar

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'reqlab:send') {
    (msg.via === 'page' ? sendInPage(msg) : sendRequest(msg)).then(respond, (e) => respond({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'reqlab:abort') {
    const c = aborts.get(msg.id);
    if (c) c.abort('aborted');
    respond({ ok: !!c });
    return false;
  }
  if (msg.type === 'reqlab:open') {
    const src = msg.srcTabId != null ? chrome.tabs.get(msg.srcTabId).catch(() => null) : Promise.resolve(null);
    src.then((tab) => openApp(msg.mode, tab || undefined)).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (msg.type === 'reqlab:syncRules') {
    syncRules().then(() => respond({ ok: true }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.rules) syncRules();
  if (ch.settings) { syncHook(); syncPanel(); }
});

async function init() {
  buildMenus();
  await syncPanel();
  await syncHook();
  await syncRules();
  // Önceki oturumdan kalmış geçici başlık kuralları.
  const s = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  if (s.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: s.map((r) => r.id) }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => { init(); });
chrome.runtime.onStartup.addListener(() => { init(); });
