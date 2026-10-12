// Ayarlar: dil, tema, yakalama, veri yedekleme ve kısayollar.
import { h, esc, download, pickFile, fileStamp, tryJson, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { t, LANGS } from './i18n.js';
import { toast, confirm, seg, switchEl } from './ui.js';
import * as store from './store.js';

const BACKUP_KEYS = ['settings', 'collections', 'envs', 'activeEnv', 'rules', 'history', 'drafts'];

export function mountSettings(root, ctx) {
  const page = h('div', { class: 'grid-page' });
  root.append(h('div', { class: 'vtitle' }, h('div', { class: 'grow' }, h('h1', null, t('navSettings')), h('p', null, t('settingsSub')))), page);

  async function render() {
    const s = await store.getSettings();
    const usage = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
    page.textContent = '';
    const row = (title, sub, control) => h('div', { class: 'srow' }, h('div', { class: 'lbl' }, h('b', null, title), sub ? h('span', null, sub) : null), control);
    const select = (value, options, onChange) => {
      const el = h('select', { class: 'select' }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const patch = async (p, reload) => { await store.patchSettings(p); ctx.applySettings(); if (reload) location.reload(); else render(); };

    const wrap = h('div', { class: 'settings' });
    wrap.append(h('div', { class: 'sgroup' }, h('h2', null, t('sAppearance')),
      row(t('sLanguage'), t('sLanguageSub'), select(s.lang, [['auto', t('langAuto')], ...LANGS.map((l) => [l.id, l.name])], (v) => patch({ lang: v }, true))),
      row(t('sOpenMode'), t('sOpenModeSub'), select(s.openMode || 'panel', [['panel', t('openPanel')], ['tab', t('openTab')], ['window', t('openWindow')], ['fullscreen', t('openFullscreen')]], (v) => patch({ openMode: v }))),
      row(t('sFocusSource'), t('sFocusSourceSub'), switchEl(s.focusSource !== false, (on) => patch({ focusSource: on }))),
      row(t('sTheme'), null, seg([{ v: 'dark', label: t('themeDark') }, { v: 'light', label: t('themeLight') }, { v: 'system', label: t('themeSystem') }], s.theme, (v) => patch({ theme: v })).el)));

    wrap.append(h('div', { class: 'sgroup' }, h('h2', null, t('sCapture')),
      row(t('sHook'), t('sHookSub'), switchEl(s.hook !== false, (on) => patch({ hook: on }))),
      row(t('sMaxBody'), t('sMaxBodySub'), select(s.maxBody, [[262144, '256 kB'], [1048576, '1 MB'], [5242880, '5 MB'], [20971520, '20 MB']], (v) => patch({ maxBody: Number(v) }))),
      row(t('sMaxEntries'), t('sMaxEntriesSub'), select(s.maxEntries, [[1000, '1 000'], [3000, '3 000'], [10000, '10 000'], [30000, '30 000']], (v) => patch({ maxEntries: Number(v) }))),
      row(t('sHistory'), t('sHistorySub'), select(s.historyLimit, [[50, '50'], [200, '200'], [1000, '1 000']], (v) => patch({ historyLimit: Number(v) })))));

    wrap.append(h('div', { class: 'sgroup' }, h('h2', null, t('sData')),
      row(t('sBackup'), t('sBackupSub'), h('div', { class: 'row' },
        h('button', { class: 'btn', html: icon('download') + `<span>${esc(t('export'))}</span>`, onClick: backup }),
        h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: restore }))),
      row(t('sUsage'), t('sUsageSub'), h('span', { class: 'mono muted' }, fmtBytes(usage))),
      row(t('sReset'), t('sResetSub'), h('button', { class: 'btn danger', html: icon('trash') + `<span>${esc(t('resetAll'))}</span>`, onClick: resetAll }))));

    const kb = (keys, label) => h('div', { class: 'srow' }, h('div', { class: 'lbl' }, h('b', null, label)), h('div', { class: 'row', style: { gap: '4px' } }, keys.map((k) => h('span', { class: 'kbd' }, k))));
    // Tarayıcının gerçekten atadığı uzantı kısayolları (çakışma varsa boş gelir).
    const cmds = await chrome.commands.getAll().catch(() => []);
    const CMD_LABEL = { _execute_action: t('kOpen'), 'open-panel': t('kOpenPanel'), 'open-tab': t('kOpenTab') };
    const cmdRow = (c) => h('div', { class: 'srow' }, h('div', { class: 'lbl' }, h('b', null, CMD_LABEL[c.name] || c.description || c.name),
      c.shortcut ? null : h('span', null, c.name === 'open-tab' ? t('kOptional') : t('kMissing'))),
      c.shortcut ? h('div', { class: 'row', style: { gap: '4px' } }, c.shortcut.split('+').map((k) => h('span', { class: 'kbd' }, k)))
        : h('span', { class: 'badge ' + (c.name === 'open-tab' ? '' : 'warn') }, t('kNotSet')));
    wrap.append(h('div', { class: 'sgroup' }, h('h2', null, t('sShortcuts')),
      cmds.filter((c) => CMD_LABEL[c.name]).map(cmdRow),
      h('div', { class: 'srow' }, h('div', { class: 'lbl' }, h('span', null, t('kChange'))),
        h('button', { class: 'btn sm primary', onClick: openShortcuts }, t('kChangeBtn'))),
      kb(['Ctrl', 'Shift', 'F'], t('kFullscreen')), kb(['Ctrl', 'Enter'], t('kSend')), kb(['Ctrl', 'S'], t('kSave')),
      kb(['/'], t('kFilter')), kb(['↑', '↓', 'Enter'], t('kList'))));

    const m = chrome.runtime.getManifest();
    wrap.append(h('div', { class: 'sgroup' }, h('h2', null, t('sAbout')),
      h('div', { class: 'srow' }, h('div', { class: 'lbl' }, h('b', null, `ReqLab ${m.version}`), h('span', null, t('aboutText'))))));
    page.append(wrap);
  }

  // Kayıtlar 'rec:<id>' anahtarlarında durur.
  const recKeys = async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k === 'recordingsIndex' || k.startsWith('rec:'));

  function openShortcuts() {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => toast(t('kOpenManually'), 'warn'));
  }

  async function backup() {
    const data = await chrome.storage.local.get([...BACKUP_KEYS, ...(await recKeys())]);
    download(`reqlab-backup-${fileStamp()}.json`, JSON.stringify({ reqlab: 1, backup: data }, null, 2));
  }

  async function restore() {
    const f = await pickFile('.json');
    if (!f) return;
    const j = tryJson(f.text);
    if (!j.ok || !j.value.backup) { toast(t('importFailed', { e: t('unknownFormat') }), 'err'); return; }
    if (!(await confirm(t('restoreTitle'), t('restoreText'), false))) return;
    const data = {};
    for (const k of Object.keys(j.value.backup)) if (BACKUP_KEYS.includes(k) || k === 'recordingsIndex' || k.startsWith('rec:')) data[k] = j.value.backup[k];
    await chrome.storage.local.set(data);
    toast(t('restored'));
    setTimeout(() => location.reload(), 500);
  }

  async function resetAll() {
    if (!(await confirm(t('resetAll'), t('resetText')))) return;
    await chrome.storage.local.remove([...BACKUP_KEYS, 'ruleErrors', ...(await recKeys())]);
    location.reload();
  }

  render();
  return { render };
}
