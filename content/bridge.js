// İçerik betiği (izole dünya): sayfa kancası (hook.js) ile eklenti arasında köprü.
// - ReqLab penceresi açıkken ("live" kaydı taze) kancaya yakalamayı açtırır, gelen kayıtları pencereye iletir,
// - sahte yanıt / gecikme kurallarını kancaya bildirir.
(function () {
  'use strict';
  if (window.__reqlabBridge) return;
  window.__reqlabBridge = true;

  let live = null;
  let rules = [];
  let maxBody = 1048576;
  let offTimer = 0;
  let loaded = false; // depo okunmadan kancaya yanlış ("kapalı") ayar gönderilmesin

  const capturing = () => !!(live && live.until > Date.now());

  function push() {
    if (!loaded) return;
    const cfg = { capture: capturing(), maxBody, rules };
    document.dispatchEvent(new CustomEvent('reqlab:config', { detail: JSON.stringify(cfg) }));
    clearTimeout(offTimer);
    if (cfg.capture) offTimer = setTimeout(push, live.until - Date.now() + 50);
  }

  function pageRules(list) {
    return (list || []).filter((r) => r && r.enabled !== false && (r.action === 'mock' || r.action === 'delay')).map((r) => ({
      id: r.id, action: r.action, match: r.match, pattern: r.pattern, method: r.method || 'ANY',
      status: r.status, statusText: r.statusText, contentType: r.contentType, body: r.body, delay: r.delay,
      headers: (r.headers || []).filter((h) => h && h.k && h.on !== false).map((h) => [h.k, h.v || ''])
    }));
  }

  function load(o, initial) {
    if (initial) loaded = true;
    if ('live' in o) live = o.live || null;
    if ('rules' in o) rules = pageRules(o.rules);
    if ('settings' in o) maxBody = Math.max(1024, Number((o.settings || {}).maxBody) || 1048576);
    push();
  }

  try {
    chrome.storage.local.get(['live', 'rules', 'settings']).then((o) => load(o, true), () => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      const o = {};
      for (const k of ['live', 'rules', 'settings']) if (ch[k]) o[k] = ch[k].newValue;
      if (Object.keys(o).length) load(o);
    });
  } catch { return; }

  document.addEventListener('reqlab:hello', push);
  document.addEventListener('reqlab:hook', (e) => {
    if (!capturing()) return;
    let data;
    try { data = JSON.parse(e.detail); } catch { return; }
    try {
      chrome.runtime.sendMessage({ type: 'reqlab:hook', data, frameUrl: location.href }).catch(() => {});
    } catch { /* eklenti yeniden yüklendi */ }
  });
})();
