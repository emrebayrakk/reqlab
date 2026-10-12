// Kayıtlar: yakalanan istekleri adlandırılmış bir kayıt olarak saklama, dışa aktarma (HAR, ReqLab JSON, CSV,
// cURL betiği, Postman koleksiyonu) ve içe aktarma (HAR, ReqLab JSON).
// Depolama: recordingsIndex = [{ id, name, createdAt, count, size, domains, bodies }], 'rec:<id>' = istek kayıtları.
import { h, esc, uid, fmtBytes, fmtAgo, splitUrl, download, pickFile, fileStamp, tryJson } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast, modal, menu, prompt, confirm, seg } from './ui.js';
import { toHar, duration, responseSize, contentType } from './capture.js';
import { entryToSpec, resolve } from './spec.js';
import { toCurl } from './codegen.js';
import * as store from './store.js';

export const FORMATS = [
  { v: 'har', ext: 'har', mime: 'application/json', icon: 'file' },
  { v: 'json', ext: 'reqlab.json', mime: 'application/json', icon: 'box' },
  { v: 'csv', ext: 'csv', mime: 'text/csv', icon: 'layers' },
  { v: 'curl', ext: 'sh', mime: 'text/x-shellscript', icon: 'code' },
  { v: 'postman', ext: 'postman_collection.json', mime: 'application/json', icon: 'send' }
];

const version = () => chrome.runtime.getManifest().version;

// Depolanabilir kopya; istenirse yanıt gövdeleri atılır (istek gövdeleri yeniden gönderim için kalır).
export function cleanEntries(entries, { bodies = true } = {}) {
  return entries.map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    if (!bodies) {
      if (c.hook) delete c.hook.resBody;
      delete c.fetched;
    }
    return c;
  });
}

function domains(entries) {
  const count = new Map();
  for (const e of entries) {
    const host = splitUrl(e.url).host;
    if (host) count.set(host, (count.get(host) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
}

// ---------------------------------------------------------------- biçimler

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toCsv(entries) {
  const head = ['started', 'method', 'status', 'url', 'type', 'mime', 'size_bytes', 'duration_ms', 'initiator', 'error', 'source'];
  const rows = entries.map((e) => [
    new Date(e.start).toISOString(), e.method, e.status || '', e.url, e.type, (contentType(e) || '').split(';')[0],
    responseSize(e) ?? '', duration(e) != null ? Math.round(duration(e)) : '', e.initiator || '', e.error || '', e.source || 'net'
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toCurlScript(entries, name) {
  const lines = ['#!/usr/bin/env bash', `# ReqLab · ${name || ''} · ${entries.length} requests · ${new Date().toISOString()}`, ''];
  for (const e of entries) {
    lines.push(`# ${e.method} ${e.url}  →  ${e.error || e.status || '?'}`);
    lines.push(toCurl(resolve(entryToSpec(e))), '');
  }
  return lines.join('\n');
}

export function toPostman(entries, name) {
  return {
    info: { name: name || 'ReqLab', _postman_id: uid(), schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: entries.map((e) => {
      const s = entryToSpec(e);
      const req = { method: s.method, header: s.headers.filter((x) => x.on !== false && x.k).map((x) => ({ key: x.k, value: x.v })), url: { raw: s.url } };
      const b = s.body;
      if (b.mode === 'json' || b.mode === 'text') req.body = { mode: 'raw', raw: b.text || '', options: { raw: { language: b.mode === 'json' ? 'json' : 'text' } } };
      else if (b.mode === 'form') req.body = { mode: 'urlencoded', urlencoded: b.form.map((x) => ({ key: x.k, value: x.v })) };
      else if (b.mode === 'multipart') req.body = { mode: 'formdata', formdata: b.form.map((x) => ({ key: x.k, value: x.v, type: 'text' })) };
      return { name: s.name, request: req, response: [] };
    })
  };
}

export function toReqlabJson(entries, name) {
  return { reqlab: 1, recording: { name: name || 'ReqLab', createdAt: Date.now(), version: version(), entries } };
}

export function build(entries, format, name) {
  switch (format) {
    case 'har': return JSON.stringify(toHar(entries, version()), null, 2);
    case 'csv': return toCsv(entries);
    case 'curl': return toCurlScript(entries, name);
    case 'postman': return JSON.stringify(toPostman(entries, name), null, 2);
    default: return JSON.stringify(toReqlabJson(entries, name), null, 2);
  }
}

export function exportEntries(entries, format, name, opts = {}) {
  const f = FORMATS.find((x) => x.v === format) || FORMATS[0];
  const list = cleanEntries(entries, opts);
  const base = (name || 'reqlab').replace(/[^\w.\-çğıöşüÇĞİÖŞÜ]+/g, '_').slice(0, 60) || 'reqlab';
  const file = `${base}-${fileStamp()}.${f.ext}`;
  download(file, build(list, format, name), f.mime);
  return file;
}

// ---------------------------------------------------------------- içe aktarma

function guessType(mime, rt) {
  if (rt) return { document: 'main_frame', xhr: 'xmlhttprequest', fetch: 'xmlhttprequest', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', media: 'media', websocket: 'websocket' }[rt] || rt;
  const m = String(mime || '').toLowerCase();
  if (/html/.test(m)) return 'main_frame';
  if (/json|xml/.test(m)) return 'xmlhttprequest';
  if (/javascript|ecmascript/.test(m)) return 'script';
  if (/css/.test(m)) return 'stylesheet';
  if (/^image\//.test(m)) return 'image';
  if (/font/.test(m)) return 'font';
  if (/^(audio|video)\//.test(m)) return 'media';
  return 'other';
}

export function harToEntries(har) {
  let n = 0;
  return (har.log.entries || []).map((he) => {
    const req = he.request || {};
    const res = he.response || {};
    const start = Date.parse(he.startedDateTime) || Date.now();
    const total = Number(he.time) || 0;
    const tm = he.timings || {};
    const pre = ['blocked', 'dns', 'connect', 'send'].reduce((a, k) => a + Math.max(0, Number(tm[k]) || 0), 0);
    const wait = Math.max(0, Number(tm.wait) || 0);
    const pairs = (list) => (list || []).map((x) => [x.name, x.value]);
    let reqBody = null;
    if (req.postData) reqBody = req.postData.params && req.postData.params.length
      ? { kind: 'form', fields: req.postData.params.map((p) => [p.name, p.value || '']) }
      : { text: req.postData.text || '' };
    const content = res.content || {};
    let resBody = null;
    if (content.text != null) {
      if (content.encoding === 'base64') {
        resBody = /^image\//i.test(content.mimeType || '')
          ? { text: '', dataUrl: `data:${content.mimeType.split(';')[0]};base64,${content.text}`, size: content.size, binary: true }
          : { text: `[${content.mimeType || 'binary'} · ${content.size || 0} B]`, binary: true, size: content.size };
      } else resBody = { text: content.text, size: content.size };
    }
    const error = res._error || (!res.status ? 'net::ERR_FAILED' : '');
    return {
      id: ++n, rid: 'imp-' + n, tabId: -1, frameId: 0, url: req.url, method: (req.method || 'GET').toUpperCase(),
      type: guessType(content.mimeType, he._resourceType), initiator: '', documentUrl: '',
      start, tSent: start + pre, tHeaders: start + pre + wait, tEnd: start + total,
      status: res.status || 0, statusText: res.statusText || '', protocol: res.httpVersion || req.httpVersion || '',
      reqHeaders: pairs(req.headers), reqBody, resHeaders: pairs(res.headers), ip: he.serverIPAddress || '', fromCache: false,
      error: res.status ? '' : error, redirectTo: res.redirectURL || '', hook: resBody ? { kind: 'import', resBody } : null,
      source: 'import', state: res.status ? 'done' : 'error'
    };
  });
}

export function importRecordingText(text, fileName = '') {
  const j = tryJson(text);
  if (!j.ok) throw new Error('unknownFormat');
  const v = j.value;
  if (v && v.reqlab && v.recording && Array.isArray(v.recording.entries)) return { name: v.recording.name, entries: v.recording.entries };
  if (v && v.log && Array.isArray(v.log.entries)) return { name: fileName.replace(/\.(har|json)$/i, '') || 'HAR', entries: harToEntries(v) };
  throw new Error('unknownFormat');
}

// ---------------------------------------------------------------- depolama

export async function listRecordings() {
  return store.get('recordingsIndex', []);
}

export async function loadRecording(id) {
  return store.get('rec:' + id, []);
}

export async function saveRecording(name, entries, { bodies = true } = {}) {
  const list = cleanEntries(entries, { bodies });
  const json = JSON.stringify(list);
  const rec = { id: uid(), name: name || t('recUntitled'), createdAt: Date.now(), count: list.length, size: json.length, domains: domains(list), bodies };
  await store.set('rec:' + rec.id, list);
  await store.update('recordingsIndex', [], (idx) => [rec, ...idx]);
  return rec;
}

export async function deleteRecording(id) {
  await chrome.storage.local.remove('rec:' + id);
  await store.update('recordingsIndex', [], (idx) => idx.filter((r) => r.id !== id));
}

// ---------------------------------------------------------------- pencereler

function defaultName(entries) {
  const d = domains(entries)[0] || 'ReqLab';
  const now = new Date();
  return `${d} · ${now.toLocaleDateString()} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// scopes: { visible: [], selected: [], all: [] } — boş olanlar gösterilmez.
function scopePicker(scopes, initial) {
  const opts = [];
  if (scopes.selected && scopes.selected.length) opts.push({ v: 'selected', label: t('scopeSelected', { n: scopes.selected.length }) });
  if (scopes.visible && scopes.visible.length) opts.push({ v: 'visible', label: t('scopeVisible', { n: scopes.visible.length }) });
  if (scopes.all && scopes.all.length) opts.push({ v: 'all', label: t('scopeAll', { n: scopes.all.length }) });
  let cur = opts.some((o) => o.v === initial) ? initial : opts[0] ? opts[0].v : 'all';
  const s = seg(opts, cur, (v) => { cur = v; });
  return { el: s.el, get: () => scopes[cur] || [], empty: !opts.length };
}

export function saveDialog(scopes, { onSaved } = {}) {
  const pick = scopePicker(scopes, scopes.selected && scopes.selected.length > 1 ? 'selected' : 'visible');
  if (pick.empty) { toast(t('nothingToSave'), 'warn'); return; }
  const name = h('input', { class: 'input', value: defaultName(scopes.visible && scopes.visible.length ? scopes.visible : scopes.all) });
  const bodies = h('input', { type: 'checkbox', checked: true });
  modal({
    title: t('saveRecTitle'),
    body: h('div', null,
      h('div', { class: 'field' }, h('label', null, t('recName')), name),
      h('div', { class: 'field' }, h('label', null, t('scope')), h('div', null, pick.el)),
      h('label', { class: 'check', style: { marginTop: '4px' } }, bodies, t('includeBodies')),
      h('p', { class: 'faint', style: { fontSize: '12px', margin: '8px 0 0' } }, t('saveRecHint'))),
    actions: [{ label: t('cancel'), kind: 'ghost' }, {
      label: t('save'), kind: 'primary', onClick: async () => {
        const list = pick.get();
        if (!list.length) { toast(t('nothingToSave'), 'warn'); return false; }
        const rec = await saveRecording(name.value.trim(), list, { bodies: bodies.checked });
        toast(t('recSaved', { name: rec.name, n: rec.count }));
        if (onSaved) onSaved(rec);
      }
    }]
  });
}

export function exportDialog(scopes, name) {
  const pick = scopePicker(scopes, scopes.selected && scopes.selected.length > 1 ? 'selected' : 'visible');
  if (pick.empty) { toast(t('nothingToExport'), 'warn'); return; }
  let fmt = localStorage.getItem('export:fmt') || 'har';
  const grid = h('div', { class: 'fmtgrid' });
  const drawFmt = () => {
    grid.textContent = '';
    for (const f of FORMATS) {
      grid.append(h('button', { class: 'fmt' + (f.v === fmt ? ' on' : ''), onClick: () => { fmt = f.v; localStorage.setItem('export:fmt', fmt); drawFmt(); } },
        h('span', { class: 'fi', html: icon(f.icon) }),
        h('span', { class: 'ft' }, h('b', null, t('fmt_' + f.v)), h('span', null, t('fmtDesc_' + f.v))),
        h('span', { class: 'fx' }, '.' + f.ext.split('.').pop())));
    }
  };
  drawFmt();
  const bodies = h('input', { type: 'checkbox', checked: true });
  modal({
    title: t('exportTitle'), wide: true,
    body: h('div', null,
      h('div', { class: 'field' }, h('label', null, t('format')), grid),
      h('div', { class: 'field' }, h('label', null, t('scope')), h('div', null, pick.el)),
      h('label', { class: 'check' }, bodies, t('includeBodies'))),
    actions: [{ label: t('cancel'), kind: 'ghost' }, {
      label: t('export'), kind: 'primary', onClick: () => {
        const list = pick.get();
        if (!list.length) { toast(t('nothingToExport'), 'warn'); return false; }
        exportEntries(list, fmt, name || defaultName(list), { bodies: bodies.checked });
        toast(t('exported', { n: list.length, f: t('fmt_' + fmt) }));
      }
    }]
  });
}

// ---------------------------------------------------------------- görünüm

export function mountRecordings(root, ctx) {
  let index = [];
  const page = h('div', { class: 'grid-page' });
  root.append(
    h('div', { class: 'vtitle' },
      h('div', { class: 'grow' }, h('h1', null, t('navRecordings')), h('p', null, t('recordingsSub'))),
      h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: importFlow }),
      h('button', { class: 'btn primary', html: icon('save') + `<span>${esc(t('saveCurrent'))}</span>`, onClick: () => ctx.saveCurrent() })),
    page);

  async function importFlow() {
    const f = await pickFile('.har,.json');
    if (!f) return;
    let r;
    try { r = importRecordingText(f.text, f.name); } catch { toast(t('importFailed', { e: t('unknownFormat') }), 'err'); return; }
    if (!r.entries.length) { toast(t('importFailed', { e: t('noEntries') }), 'err'); return; }
    const rec = await saveRecording(r.name, r.entries, { bodies: true });
    toast(t('recImported', { n: rec.count }));
  }

  async function open(rec) {
    const entries = await loadRecording(rec.id);
    ctx.openRecording(rec, entries);
  }

  async function exportRec(rec, format) {
    const entries = await loadRecording(rec.id);
    exportEntries(entries, format, rec.name, { bodies: true });
    toast(t('exported', { n: entries.length, f: t('fmt_' + format) }));
  }

  function render() {
    page.textContent = '';
    if (!index.length) {
      page.append(h('div', { class: 'empty', style: { height: '100%' } }, h('div', null,
        h('div', { class: 'ico', html: icon('archive') }), h('h3', null, t('recEmptyTitle')), h('p', null, t('recEmptyText')),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
          h('button', { class: 'btn primary', html: icon('save') + `<span>${esc(t('saveCurrent'))}</span>`, onClick: () => ctx.saveCurrent() }),
          h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: importFlow })))));
      return;
    }
    const cards = h('div', { class: 'cards' });
    for (const rec of index) {
      const card = h('div', { class: 'card rec', onClick: () => open(rec) },
        h('div', { class: 'chead' },
          h('div', { class: 'folder-ico', html: icon('archive') }),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('h3', { class: 'ellipsis' }, rec.name),
            h('div', { class: 'meta' }, [t(rec.count === 1 ? 'nRequest' : 'nRequests', { n: rec.count }), fmtBytes(rec.size), fmtAgo(rec.createdAt, t), rec.bodies === false ? t('noBodiesTag') : null].filter(Boolean).join(' · ')),
            rec.domains && rec.domains.length ? h('div', { class: 'row', style: { gap: '4px', marginTop: '6px', flexWrap: 'wrap' } }, rec.domains.map((d) => h('span', { class: 'badge' }, d))) : null),
          h('div', { class: 'tools', onClick: (ev) => ev.stopPropagation() },
            h('button', { class: 'btn sm', html: icon('activity') + `<span>${esc(t('openInNetwork'))}</span>`, onClick: () => open(rec) }),
            h('button', { class: 'btn sm', html: icon('download') + `<span>${esc(t('export'))}</span>`, onClick: (ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              menu(r.left - 60, r.bottom + 4, FORMATS.map((f) => ({ icon: f.icon, label: t('fmt_' + f.v), key: '.' + f.ext.split('.').pop(), onClick: () => exportRec(rec, f.v) })));
            } }),
            h('button', { class: 'btn ghost sm icon', html: icon('more'), onClick: (ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              menu(r.left - 170, r.bottom + 4, [
                { icon: 'edit', label: t('rename'), onClick: async () => {
                  const name = await prompt(t('rename'), rec.name);
                  if (name) await store.update('recordingsIndex', [], (idx) => idx.map((x) => (x.id === rec.id ? { ...x, name } : x)));
                } },
                '-',
                { icon: 'trash', label: t('deleteRec'), danger: true, onClick: async () => {
                  if (await confirm(t('deleteRec'), t('deleteRecText', { name: rec.name, n: rec.count }))) {
                    await deleteRecording(rec.id);
                    ctx.recordingDeleted(rec.id);
                  }
                } }
              ]);
            } }))));
      cards.append(card);
    }
    page.append(cards);
  }

  store.on('recordingsIndex', (v) => { index = v || []; render(); });
  listRecordings().then((v) => { index = v; render(); });
  return { render };
}

