// Uygulama girişi: ayarlar, tema/dil, yakalama motoru ve görünümler.
import { h } from './util.js';
import { toast } from './ui.js';
import { icon } from './icons.js';
import { t, setLang } from './i18n.js';
import * as store from './store.js';
import { Capture } from './capture.js';
import { mountNetwork } from './network.js';
import { mountClient } from './client.js';
import { mountCollections, saveDialog, updateSaved } from './collections.js';
import { mountRules } from './rules.js';
import { mountSettings } from './settings.js';
import { mountRecordings } from './recordings.js';

const VIEWS = [
  { id: 'network', icon: 'activity', label: 'navNetwork' },
  { id: 'client', icon: 'send', label: 'navClient' },
  { id: 'collections', icon: 'folder', label: 'navCollections' },
  { id: 'recordings', icon: 'archive', label: 'navRecordings' },
  { id: 'rules', icon: 'sliders', label: 'navRules' }
];

let settings = { ...store.DEFAULT_SETTINGS };

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

async function boot() {
  settings = await store.getSettings();
  setLang(settings.lang);
  applyTheme();

  const devtools = !!(chrome.devtools && chrome.devtools.inspectedWindow);
  const lockTab = devtools ? chrome.devtools.inspectedWindow.tabId : null;
  if (devtools) document.body.classList.add('embed');
  const params = new URLSearchParams(location.search);
  const panel = params.get('panel') === '1' && !devtools;
  if (panel) document.body.classList.add('panel');
  // Dar alan (yan panel ya da küçük pencere): düzen sadeleşir.
  const syncNarrow = () => document.body.classList.toggle('narrow', innerWidth < 760);
  syncNarrow();
  addEventListener('resize', syncNarrow);
  const own = await chrome.tabs.getCurrent().catch(() => null);

  const capture = new Capture({ ownTabId: own ? own.id : null, lockTab, maxEntries: settings.maxEntries, maxBody: settings.maxBody });
  capture.start();
  // Yan panelden "Büyüt" ile açıldıysak oradaki istekleri devral.
  const takeHandoff = async () => {
    const { handoff } = await chrome.storage.session.get('handoff').catch(() => ({}));
    if (handoff && Date.now() - handoff.at < 60000 && Array.isArray(handoff.entries)) {
      await chrome.storage.session.remove('handoff').catch(() => {});
      capture.importEntries(handoff.entries);
    }
  };
  if (!panel && !devtools && chrome.storage.session) {
    await takeHandoff();
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'reqlab:handoff') takeHandoff(); return false; });
  }
  // Yan panelde: panelin durduğu penceredeki etkin sekmeyi izle.
  const panelWin = panel ? await chrome.windows.getCurrent().catch(() => null) : null;
  const activeTab = async () => (panelWin ? (await chrome.tabs.query({ active: true, windowId: panelWin.id }).catch(() => []))[0] : null);

  // ---------------------------------------------------------------- menü
  const rail = document.getElementById('rail');
  const navs = {};
  rail.append(h('div', { class: 'logo', title: 'ReqLab' }, h('img', { src: '../icons/icon48.png', alt: '' })));
  for (const v of VIEWS) {
    navs[v.id] = h('button', { class: 'nav', 'data-tip': t(v.label), html: icon(v.icon), onClick: () => show(v.id) });
    rail.append(navs[v.id]);
  }
  rail.append(h('div', { class: 'spacer' }));
  const themeBtn = h('button', { class: 'nav', 'data-tip': t('toggleTheme'), onClick: async () => {
    settings = await store.patchSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
    applyTheme();
    themeBtn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
  } });
  themeBtn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
  navs.settings = h('button', { class: 'nav', 'data-tip': t('navSettings'), html: icon('settings'), onClick: () => show('settings') });
  // Tam ekran: sayfa tam ekranı (Esc ile çıkılır); uygulama tam ekran pencerede açıldıysa pencere durumu değiştirilir.
  // DevTools panelinde bunun yerine uygulamayı sekmede açan düğme var.
  let winState = '';
  const readWin = () => chrome.windows && chrome.windows.getCurrent ? chrome.windows.getCurrent().then((w) => { winState = w.state; syncFs(); }, () => {}) : null;
  const fsBtn = h('button', { class: 'nav' });
  const isFull = () => !!document.fullscreenElement || winState === 'fullscreen';
  const syncFs = () => {
    fsBtn.innerHTML = icon(devtools || panel ? 'external' : isFull() ? 'minimize' : 'maximize');
    fsBtn.dataset.tip = panel ? t('enlarge') : devtools ? t('openInTabApp') : isFull() ? t('exitFullscreen') : t('enterFullscreen');
  };
  // Yan paneldeki istekleri tam görünüme taşı: oturum deposuna bırak, sayfanın yanında sekme aç, paneli kapat.
  const enlarge = async () => {
    const tab = await activeTab();
    const entries = capture.entries.slice(-2000);
    const put = (list) => chrome.storage.session.set({ handoff: { at: Date.now(), entries: list } });
    await put(entries).catch(() => put(JSON.parse(JSON.stringify(entries)).map((e) => { if (e.hook) delete e.hook.resBody; return e; })).catch(() => {}));
    await chrome.runtime.sendMessage({ type: 'reqlab:open', mode: 'tab', srcTabId: tab ? tab.id : null }).catch(() => {});
    window.close();
  };
  const toggleFs = () => {
    if (panel) { enlarge(); return; }
    if (devtools) { chrome.runtime.sendMessage({ type: 'reqlab:open', mode: 'tab' }); return; }
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (winState === 'fullscreen') { chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'maximized' })).then(readWin); return; }
    document.documentElement.requestFullscreen().catch(() => {});
  };
  fsBtn.addEventListener('click', toggleFs);
  document.addEventListener('fullscreenchange', syncFs);
  if (!devtools && !panel) {
    addEventListener('resize', readWin);
    addEventListener('focus', readWin);
    // Pencere tam ekrana alınıp çıkarılınca (görüntü alanı değişmese bile) durum güncellensin.
    if (chrome.windows && chrome.windows.onBoundsChanged) chrome.windows.onBoundsChanged.addListener(() => readWin());
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'reqlab:win') readWin(); return false; });
  }
  syncFs();
  if (!devtools && !panel) readWin();
  rail.append(fsBtn, themeBtn, navs.settings);

  let current = '';
  function show(id) {
    if (!document.getElementById('view-' + id)) id = 'network';
    current = id;
    for (const [k, b] of Object.entries(navs)) b.classList.toggle('on', k === id);
    for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('on', sec.id === 'view-' + id);
    localStorage.setItem('view', id);
    if (id === 'settings' && settingsView) settingsView.render();
  }

  // ---------------------------------------------------------------- görünümler
  let client;
  let settingsView;
  let collections;
  let rules;
  const fromParam = Number(params.get('from'));
  const firstTab = panel ? await activeTab() : null;
  const ctx = {
    capture,
    lockTab,
    panel,
    initialTab: panel ? (firstTab && settings.focusSource !== false ? firstTab.id : null)
      : settings.focusSource !== false && Number.isInteger(fromParam) && fromParam > 0 ? fromParam : null,
    ownTabId: own ? own.id : null,
    settings: () => settings,
    openSpec: (spec, opts) => { show('client'); client.open(spec, opts); },
    saveSpec: (spec) => saveDialog(spec),
    updateSaved,
    collectionName: (id) => { const c = collections.names().find((x) => x.id === id); return c ? c.name : ''; },
    unlink: (link) => client.unlink(link),
    addRule: (partial) => { show('rules'); rules.edit(partial); },
    showRules: () => show('rules'),
    openRecording: (rec, entries) => { show('network'); net.viewRecording(rec, entries); },
    saveCurrent: () => net.saveCurrent(),
    recordingDeleted: (id) => { if (net.currentRecording() === id) net.showLive(); },
    applySettings: async () => {
      settings = await store.getSettings();
      applyTheme();
      capture.maxEntries = settings.maxEntries;
      capture.maxBody = settings.maxBody;
    }
  };
  const net = mountNetwork(document.getElementById('view-network'), ctx);
  client = mountClient(document.getElementById('view-client'), ctx);
  collections = mountCollections(document.getElementById('view-collections'), ctx);
  rules = mountRules(document.getElementById('view-rules'), ctx);
  mountRecordings(document.getElementById('view-recordings'), ctx);
  settingsView = mountSettings(document.getElementById('view-settings'), ctx);

  store.on('settings', async () => { settings = await store.getSettings(); applyTheme(); });
  // Uzantı kısayolu atanmamışsa (başka uzantı / tarayıcı kullanıyorsa) bir kez uyar.
  if (!devtools && !sessionStorage.getItem('keysChecked')) {
    sessionStorage.setItem('keysChecked', '1');
    chrome.commands.getAll().then((cmds) => {
      const open = cmds.filter((c) => c.name === '_execute_action' || c.name === 'open-panel');
      if (open.length && open.every((c) => !c.shortcut)) toast(t('kMissingToast'), 'warn');
    }).catch(() => {});
  }

  // Yan panel, etkin sekme değiştikçe listeyi o sekmeye odaklar (F12 gibi).
  if (panel && panelWin) {
    chrome.tabs.onActivated.addListener((i) => { if (i.windowId === panelWin.id && settings.focusSource !== false) net.focusTab(i.tabId, { silent: true }); });
  }

  // Konsoldan inceleme için (yalnızca bu eklenti sayfasında).
  window.__reqlab = { capture, ctx };

  // Hata veren kural varsa menüde işaret.
  const markRules = (errs) => {
    const has = errs && Object.keys(errs).length > 0;
    let dot = navs.rules.querySelector('.dot');
    if (has && !dot) navs.rules.append(h('span', { class: 'dot' }));
    if (!has && dot) dot.remove();
  };
  markRules(await store.get('ruleErrors', {}));
  store.on('ruleErrors', markRules);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if (e.key === '/' && !typing && current === 'network') { e.preventDefault(); net.focusSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); fsBtn.click(); }
  });

  const hash = location.hash.slice(1);
  // Yan panel F12 gibi her zaman Ağ ile açılır; sekmede en son ekran hatırlanır.
  show(hash || (panel ? 'network' : localStorage.getItem('view')) || 'network');
  document.title = devtools ? 'ReqLab' : t('appTitle');
}

boot().catch((e) => {
  console.error(e);
  document.body.append(h('pre', { style: { color: 'tomato', padding: '20px', whiteSpace: 'pre-wrap' } }, String(e && e.stack || e)));
});
