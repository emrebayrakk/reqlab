// İstemci: Postman benzeri istek düzenleyici. Birden çok sekme, ortam değişkenleri, geçmiş, kod üretme.
import { h, esc, uid, clone, fmtBytes, fmtMs, fmtAgo, statusClass, splitUrl, queryRows, withQuery, tryJson, copyText, download, debounce, METHODS } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast, modal, menu, splitter, tabbar, seg, confirm } from './ui.js';
import { kvEditor } from './kv.js';
import { viewer, codeBlock } from './viewer.js';
import { newSpec, resolve, send, headerNote, parsedToSpec } from './spec.js';
import { toCurl, toFetch, toPython, toHttpie, parseCurl } from './codegen.js';
import * as store from './store.js';

const CT_PRESETS = ['text/plain', 'application/json', 'application/xml', 'text/xml', 'text/html', 'application/javascript', 'application/graphql', 'text/csv'];

export function mountClient(root, ctx) {
  let drafts = [];
  let active = null;
  let envs = [];
  let activeEnv = '';
  let history = [];
  const responses = new Map(); // draftId -> { loading, res, req, via, abort, at }
  const persist = debounce(() => store.set('drafts', drafts.map((d) => ({ id: d.id, spec: d.spec, link: d.link || null, dirty: !!d.dirty }))), 400);

  // ---------------------------------------------------------------- iskelet
  const histSearch = h('input', { class: 'input', placeholder: t('searchHistory'), style: { width: '100%' } });
  const histList = h('div', { class: 'slist' });
  const side = h('aside', { class: 'side' },
    h('div', { class: 'shead' }, h('h2', null, t('history')),
      h('button', { class: 'btn ghost sm icon', html: icon('trash'), title: t('clearHistory'), onClick: clearHistory }),
      h('button', { class: 'btn ghost sm icon hclose', html: icon('x'), title: t('close'), onClick: () => wrap.classList.remove('histopen') })),
    h('div', { style: { padding: '0 10px 8px' } }, h('div', { class: 'search' }, h('span', { html: icon('search') }), histSearch)),
    histList);
  histSearch.addEventListener('input', debounce(renderHistory, 120));

  const envSel = h('select', { class: 'select', style: { maxWidth: '190px' }, title: t('environment') });
  envSel.addEventListener('change', () => { activeEnv = envSel.value; store.set('activeEnv', activeEnv); });
  const rtabs = h('div', { class: 'rtabs' });
  const top = h('div', { class: 'row', style: { gap: 0, background: 'var(--bg2)', borderBottom: '1px solid var(--line)' } },
    h('button', { class: 'btn ghost icon', style: { margin: '0 4px' }, html: icon('history'), title: t('toggleHistory'), onClick: () => {
      // Dar alanda geçmiş tam genişlikte açılır/kapanır; genişte yan sütun olarak.
      if (document.body.classList.contains('narrow')) { wrap.classList.toggle('histopen'); return; }
      wrap.classList.toggle('nohist');
      localStorage.setItem('client:hist', wrap.classList.contains('nohist') ? '0' : '1');
    } }),
    h('div', { class: 'grow', style: { minWidth: 0 } }, rtabs),
    h('div', { class: 'envsel', style: { padding: '0 10px' } },
      h('span', { html: icon('layers'), class: 'faint' }), envSel,
      h('button', { class: 'btn ghost sm icon', html: icon('settings'), title: t('manageEnvs'), onClick: manageEnvs })));
  const editorHost = h('div', { class: 'pane', style: { flex: '1' } });
  const main = h('div', { class: 'pane', style: { flex: '1' } }, top, editorHost);
  const wrap = h('div', { class: 'client' + (localStorage.getItem('client:hist') === '0' ? ' nohist' : '') }, side, main);
  root.append(wrap);

  // ---------------------------------------------------------------- sekmeler
  function renderTabs() {
    rtabs.textContent = '';
    for (const d of drafts) {
      const s = d.spec;
      const tab = h('div', { class: 'rtab' + (d.id === active ? ' on' : ''), title: s.url || '', onClick: () => activate(d.id) },
        h('span', { class: 'm m-' + s.method, style: { fontSize: '10px' } }, s.method),
        h('span', { class: 'nm' }, s.name || splitUrl(s.url).name || t('untitled')),
        d.dirty ? h('span', { class: 'dirty', title: t('unsaved') }) : null,
        h('button', { class: 'x', html: icon('x'), title: t('close'), onClick: (ev) => { ev.stopPropagation(); closeDraft(d.id); } }));
      tab.addEventListener('auxclick', (ev) => { if (ev.button === 1) closeDraft(d.id); });
      tab.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        menu(ev.clientX, ev.clientY, [
          { icon: 'copy', label: t('duplicate'), onClick: () => open({ ...clone(d.spec), id: uid(), name: (d.spec.name || '') + ' (2)' }) },
          { icon: 'x', label: t('closeOthers'), onClick: () => { drafts = drafts.filter((x) => x.id === d.id); activate(d.id); persist(); } },
          { icon: 'x', label: t('close'), onClick: () => closeDraft(d.id) }
        ]);
      });
      rtabs.append(tab);
    }
    rtabs.append(h('button', { class: 'btn ghost sm icon add', html: icon('plus'), title: t('newRequest'), onClick: () => open(newSpec()) }));
  }

  function activate(id) {
    active = id;
    localStorage.setItem('client:active', id);
    renderTabs();
    renderEditor();
  }

  // Yeni sekmede aç. opts.send: hemen gönder; opts.link: koleksiyondaki kayda bağla.
  function open(spec, opts = {}) {
    wrap.classList.remove('histopen');
    const cur = drafts.find((d) => d.id === active);
    const reuse = cur && !cur.dirty && !cur.link && !cur.spec.url && !responses.get(cur.id);
    const d = { id: uid(), spec: { ...newSpec(), ...clone(spec) }, link: opts.link || null, dirty: !opts.link };
    if (reuse) drafts.splice(drafts.indexOf(cur), 1, d); else drafts.push(d);
    persist();
    activate(d.id);
    if (opts.send) doSend();
  }

  async function closeDraft(id) {
    const d = drafts.find((x) => x.id === id);
    if (!d) return;
    if (d.dirty && d.spec.url && !(await confirm(t('closeUnsavedTitle'), t('closeUnsavedText'), true))) return;
    const r = responses.get(id);
    if (r && r.abort) r.abort();
    responses.delete(id);
    const i = drafts.indexOf(d);
    drafts.splice(i, 1);
    if (!drafts.length) drafts.push({ id: uid(), spec: newSpec(), link: null, dirty: false });
    persist();
    activate(active === id ? drafts[Math.max(0, i - 1)].id : active);
  }

  // ---------------------------------------------------------------- düzenleyici
  let rtab = localStorage.getItem('client:rtab') || 'params';

  function renderEditor() {
    editorHost.textContent = '';
    const d = drafts.find((x) => x.id === active);
    if (!d) return;
    const s = d.spec;
    const touch = () => { if (!d.dirty) { d.dirty = true; renderTabs(); } persist(); };

    const nameIn = h('input', { value: s.name, placeholder: t('untitled'), spellcheck: 'false' });
    nameIn.addEventListener('input', () => { s.name = nameIn.value; touch(); renderTabs(); });
    const nameRow = h('div', { class: 'reqname' },
      nameIn,
      d.link ? h('span', { class: 'badge info', title: t('linkedHint') }, h('span', { html: icon('folder'), style: { display: 'contents' } }), ' ', ctx.collectionName(d.link.col) || '') : null,
      h('button', { class: 'btn ghost sm', html: icon('code') + `<span>${esc(t('code'))}</span>`, onClick: () => showCode(s) }),
      h('button', { class: 'btn sm', html: icon('save') + `<span>${esc(t('save'))}</span><kbd>Ctrl S</kbd>`, onClick: () => save(d) }));

    const methodSel = h('select', { class: 'm m-' + s.method }, [...new Set([...METHODS, s.method])].map((m) => h('option', { value: m, selected: m === s.method }, m)));
    methodSel.addEventListener('change', () => { s.method = methodSel.value; methodSel.className = 'm m-' + s.method; touch(); renderTabs(); bodyNote(); });
    const urlIn = h('input', { value: s.url, placeholder: 'https://api.example.com/v1/users?page=1 · {{baseUrl}}/users', spellcheck: 'false' });
    urlIn.addEventListener('input', () => {
      s.url = urlIn.value;
      const off = (s.params || []).filter((p) => p.on === false);
      s.params = [...queryRows(s.url), ...off];
      paramsEd.set(s.params);
      touch();
      renderTabs();
    });
    urlIn.addEventListener('paste', (ev) => {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (/^\s*curl\s/i.test(text)) {
        ev.preventDefault();
        try { const p = parsedToSpec(parseCurl(text)); Object.assign(s, { method: p.method, url: p.url, params: p.params, headers: p.headers, body: p.body }); touch(); renderEditor(); toast(t('curlImported')); } catch { toast(t('curlBad'), 'err'); }
      }
    });
    const sendBtn = h('button', { class: 'btn primary', html: icon('send') + `<span>${esc(t('send'))}</span>`, onClick: () => doSend() });
    const viaSel = h('select', { class: 'select', title: t('sendVia') },
      h('option', { value: 'ext', selected: s.opts.via !== 'page' }, t('viaExt')), h('option', { value: 'page', selected: s.opts.via === 'page' }, t('viaPage')));
    viaSel.addEventListener('change', () => { s.opts.via = viaSel.value; touch(); if (rtab === 'settings' || rtab === 'headers') fill(); });
    const bar = h('div', { class: 'reqbar' }, h('div', { class: 'urlbox' }, methodSel, urlIn), viaSel, sendBtn);

    // istek sekmeleri
    const paramsEd = kvEditor({ rows: s.params, keyPh: t('param'), valPh: t('value'), onChange: (rows) => {
      s.params = rows;
      s.url = withQuery(s.url, rows);
      urlIn.value = s.url;
      touch();
    } });
    const headersEd = kvEditor({ rows: s.headers, headers: true, keyPh: t('header'), valPh: t('value'), warn: (k) => { const n = headerNote(k, s.opts.via); return n ? t(n) : null; }, onChange: (rows) => { s.headers = rows; touch(); } });
    const formEd = kvEditor({ rows: s.body.form, keyPh: t('field'), valPh: t('value'), onChange: (rows) => { s.body.form = rows; touch(); } });
    const count = (list) => (list || []).filter((r) => r.on !== false && r.k).length || '';
    const tabs = tabbar([
      { id: 'params', label: t('tabParams'), count: count(s.params) },
      { id: 'headers', label: t('tabHeaders'), count: count(s.headers) },
      { id: 'body', label: t('tabBody'), count: s.body.mode !== 'none' ? '•' : '' },
      { id: 'auth', label: t('tabAuth'), count: s.auth.type !== 'none' ? '•' : '' },
      { id: 'settings', label: t('tabSettings') }
    ], rtab, (id) => { rtab = id; localStorage.setItem('client:rtab', id); fill(); });
    const area = h('div', { class: 'pane-scroll' });
    const noteHost = h('div');
    const bodyNote = () => {
      noteHost.textContent = '';
      if ((s.method === 'GET' || s.method === 'HEAD') && s.body.mode !== 'none') noteHost.append(h('div', { class: 'note warn', style: { margin: '0 0 10px' }, html: icon('alert') + `<span>${esc(t('bodyIgnored'))}</span>` }));
    };

    function fill() {
      area.textContent = '';
      if (rtab === 'params') area.append(h('div', { class: 'pad' }, paramsEd.el));
      else if (rtab === 'headers') {
        area.append(h('div', { class: 'pad' }, headersEd.el,
          h('p', { class: 'faint', style: { fontSize: '12px', margin: '10px 2px 0' } }, s.opts.via === 'page' ? t('hdrHintPage') : t('hdrHintExt'))));
      } else if (rtab === 'body') area.append(bodyPane());
      else if (rtab === 'auth') area.append(authPane());
      else if (rtab === 'settings') area.append(settingsPane());
    }

    function bodyPane() {
      const box = h('div', { class: 'pad', style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } });
      const modes = [{ v: 'none', label: t('bNone') }, { v: 'json', label: 'JSON' }, { v: 'text', label: t('bText') }, { v: 'form', label: 'x-www-form-urlencoded' }, { v: 'multipart', label: 'form-data' }];
      const content = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1' } });
      const draw = () => {
        content.textContent = '';
        bodyNote();
        content.append(noteHost);
        if (s.body.mode === 'none') content.append(h('p', { class: 'faint' }, t('bNoneHint')));
        else if (s.body.mode === 'json' || s.body.mode === 'text') {
          const ta = h('textarea', { spellcheck: 'false', placeholder: s.body.mode === 'json' ? '{\n  "name": "{{user}}"\n}' : '' });
          ta.value = s.body.text || '';
          const err = h('span', { class: 'err', hidden: true });
          const check = () => {
            if (s.body.mode !== 'json' || !ta.value.trim()) { err.hidden = true; return; }
            const r = tryJson(ta.value.replace(/{{\s*[\w.-]+\s*}}/g, '0'));
            err.hidden = r.ok;
            if (!r.ok) err.textContent = t('jsonInvalid', { e: r.error });
          };
          ta.addEventListener('input', () => { s.body.text = ta.value; touch(); check(); });
          ta.addEventListener('keydown', (ev) => {
            if (ev.key === 'Tab') { ev.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); s.body.text = ta.value; touch(); }
          });
          check();
          const tools = h('div', { class: 'row', style: { marginBottom: '8px' } });
          if (s.body.mode === 'json') {
            tools.append(h('button', { class: 'btn sm', html: icon('wand') + `<span>${esc(t('beautify'))}</span>`, onClick: () => {
              const r = tryJson(ta.value);
              if (!r.ok) { toast(t('jsonInvalid', { e: r.error }), 'err'); return; }
              ta.value = JSON.stringify(r.value, null, 2); s.body.text = ta.value; touch(); check();
            } }), h('button', { class: 'btn sm ghost', onClick: () => {
              const r = tryJson(ta.value);
              if (r.ok) { ta.value = JSON.stringify(r.value); s.body.text = ta.value; touch(); }
            } }, t('minify')));
          } else {
            const ctIn = h('input', { class: 'input', list: 'dl-ct', value: s.body.contentType || 'text/plain', style: { width: '240px' }, placeholder: 'Content-Type' });
            ctIn.addEventListener('input', () => { s.body.contentType = ctIn.value; touch(); });
            tools.append(h('span', { class: 'muted' }, 'Content-Type'), ctIn, h('datalist', { id: 'dl-ct' }, CT_PRESETS.map((c) => h('option', { value: c }))));
          }
          tools.append(h('span', { class: 'grow' }), h('span', { class: 'faint', style: { fontSize: '12px' } }, t('varsHint')));
          content.append(tools, h('div', { class: 'editor' }, ta, err));
        } else {
          formEd.set(s.body.form);
          content.append(formEd.el);
          if (s.body.mode === 'multipart') content.append(h('p', { class: 'faint', style: { fontSize: '12px' } }, t('multipartHint')));
        }
      };
      const sg = seg(modes, s.body.mode, (v) => { s.body.mode = v; touch(); draw(); tabs.update(tabList()); });
      box.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, sg.el), content);
      draw();
      return box;
    }

    function authPane() {
      const a = s.auth;
      const box = h('div', { class: 'pad' });
      const grid = h('div', { class: 'form-grid' });
      const field = (label, key, ph, type = 'text') => {
        const inp = h('input', { class: 'input mono', type, value: a[key] || '', placeholder: ph || '', spellcheck: 'false' });
        inp.addEventListener('input', () => { a[key] = inp.value; touch(); });
        grid.append(h('label', null, label), inp);
      };
      const draw = () => {
        grid.textContent = '';
        const typeSel = h('select', { class: 'select' }, [['none', t('authNone')], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key']].map(([v, l]) => h('option', { value: v, selected: a.type === v }, l)));
        typeSel.addEventListener('change', () => { a.type = typeSel.value; touch(); draw(); tabs.update(tabList()); });
        grid.append(h('label', null, t('authType')), typeSel);
        if (a.type === 'bearer') { field('Token', 'token', '{{token}}'); grid.append(h('div', { class: 'hint' }, t('authBearerHint'))); }
        if (a.type === 'basic') { field(t('username'), 'user'); field(t('password'), 'pass', '', 'password'); }
        if (a.type === 'apikey') {
          field(t('keyName'), 'key', 'X-API-Key');
          field(t('value'), 'value', '{{apiKey}}');
          const where = h('select', { class: 'select' }, h('option', { value: 'header', selected: a.in !== 'query' }, t('inHeader')), h('option', { value: 'query', selected: a.in === 'query' }, t('inQuery')));
          where.addEventListener('change', () => { a.in = where.value; touch(); });
          grid.append(h('label', null, t('addTo')), where);
        }
        if (a.type === 'none') grid.append(h('div', { class: 'hint', style: { marginTop: 0 } }, t('authNoneHint')));
      };
      draw();
      box.append(grid);
      return box;
    }

    function settingsPane() {
      const o = s.opts;
      const box = h('div', { class: 'pad' });
      const grid = h('div', { class: 'form-grid' });
      const via = h('select', { class: 'select' }, h('option', { value: 'ext', selected: o.via !== 'page' }, t('viaExtLong')), h('option', { value: 'page', selected: o.via === 'page' }, t('viaPageLong')));
      const tabSel = h('select', { class: 'select' });
      const loadTabs = async () => {
        const tabs = await chrome.tabs.query({}).catch(() => []);
        tabSel.textContent = '';
        tabSel.append(h('option', { value: '' }, t('pickTab')));
        for (const x of tabs) {
          if (!x.url || !/^(https?|file):/.test(x.url)) continue;
          tabSel.append(h('option', { value: String(x.id), selected: o.tabId === x.id }, `${(x.title || '').slice(0, 50)} — ${splitUrl(x.url).host}`));
        }
      };
      loadTabs();
      tabSel.addEventListener('change', () => { o.tabId = tabSel.value ? Number(tabSel.value) : null; touch(); });
      const tabRow = [h('label', null, t('targetTab')), tabSel];
      const syncVia = () => { tabRow.forEach((x) => { x.hidden = o.via !== 'page'; }); };
      via.addEventListener('change', () => { o.via = via.value; viaSel.value = o.via; syncVia(); touch(); });
      const cred = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.credentials !== false, onChange: (ev) => { o.credentials = ev.target.checked; touch(); } }), t('sendCookies'));
      const redir = h('select', { class: 'select' }, [['follow', t('redirFollow')], ['manual', t('redirManual')], ['error', t('redirError')]].map(([v, l]) => h('option', { value: v, selected: o.redirect === v }, l)));
      redir.addEventListener('change', () => { o.redirect = redir.value; touch(); });
      const tmo = h('input', { class: 'input', type: 'number', min: '0', step: '1000', value: o.timeout ?? 30000, style: { width: '140px' } });
      tmo.addEventListener('input', () => { o.timeout = Number(tmo.value) || 0; touch(); });
      grid.append(h('label', null, t('sendVia')), via, h('div', { class: 'hint' }, t('viaHint')), ...tabRow,
        h('label', null, t('cookies')), cred, h('label', null, t('redirects')), redir, h('label', null, t('timeoutMs')), tmo, h('div', { class: 'hint' }, t('timeoutHint')));
      syncVia();
      box.append(grid);
      return box;
    }

    const tabList = () => [
      { id: 'params', label: t('tabParams'), count: count(s.params) },
      { id: 'headers', label: t('tabHeaders'), count: count(s.headers) },
      { id: 'body', label: t('tabBody'), count: s.body.mode !== 'none' ? '•' : '' },
      { id: 'auth', label: t('tabAuth'), count: s.auth.type !== 'none' ? '•' : '' },
      { id: 'settings', label: t('tabSettings') }
    ];

    // yanıt bölmesi
    const respPane = h('div', { class: 'pane', style: { flex: '1' } });
    const reqPane = h('div', { class: 'pane' }, nameRow, bar, tabs.el, area);
    const gutter = h('div', { class: 'gutter' });
    const split = h('div', { class: 'split v' }, reqPane, gutter, respPane);
    editorHost.append(split);
    splitter(split, reqPane, gutter, { vertical: true, key: 'client', initial: 0.48, min: 150 });
    fill();
    renderResponse(d, respPane);
    d.ui = { respPane, urlIn, sendBtn };
    setTimeout(() => { if (!s.url) urlIn.focus(); }, 30);
  }

  // ---------------------------------------------------------------- gönderme
  async function doSend() {
    const d = drafts.find((x) => x.id === active);
    if (!d) return;
    const s = d.spec;
    if (!s.url.trim()) { toast(t('needUrl'), 'warn'); d.ui && d.ui.urlIn.focus(); return; }
    const env = envs.find((e) => e.id === activeEnv);
    const req = resolve(s, env);
    try { new URL(req.url); } catch { toast(t('badUrl'), 'err'); return; }
    if (req.missing.length) toast(t('missingVars', { v: req.missing.join(', ') }), 'warn');
    const via = s.opts.via === 'page' ? 'page' : 'ext';
    let tabId = s.opts.tabId;
    if (via === 'page') {
      if (tabId == null) {
        // Hedef sekme seçilmediyse, adresle aynı kökene sahip açık bir sekme ara.
        const origin = new URL(req.url).origin;
        const tabs = await chrome.tabs.query({}).catch(() => []);
        const hit = tabs.find((x) => x.url && x.url.startsWith(origin));
        tabId = hit ? hit.id : null;
      }
      if (tabId == null) { toast(t('needTab'), 'warn'); return; }
    }
    const prev = responses.get(d.id);
    if (prev && prev.abort) prev.abort();
    const sending = send(req, { via, tabId, maxBody: Math.max(ctx.settings().maxBody * 5, 5 * 1048576) });
    const r = { loading: true, req, via, abort: sending.abort, at: Date.now() };
    responses.set(d.id, r);
    if (active === d.id && d.ui) renderResponse(d, d.ui.respPane);
    let res;
    try { res = await sending.promise; } catch (e) { res = { ok: false, error: String(e.message || e) }; }
    if (responses.get(d.id) !== r) return;
    r.loading = false;
    r.abort = null;
    r.res = res || { ok: false, error: 'noResponse' };
    if (active === d.id && d.ui) renderResponse(d, d.ui.respPane);
    addHistory(s, r.res, via, req.url);
  }

  function renderResponse(d, pane) {
    pane.textContent = '';
    const r = responses.get(d.id);
    if (!r) {
      pane.append(h('div', { class: 'resp' }, h('div', { class: 'empty' }, h('div', null,
        h('div', { class: 'ico', html: icon('send') }), h('h3', null, t('respEmptyTitle')),
        h('p', null, t('respEmptyText')),
        h('p', { style: { marginTop: '12px' } }, h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'Enter'))))));
      return;
    }
    if (r.loading) {
      pane.append(h('div', { class: 'resp' }, h('div', { class: 'empty' }, h('div', null,
        h('div', { class: 'spinner', style: { margin: '0 auto 12px', width: '26px', height: '26px' } }),
        h('h3', null, t('sending')), h('p', { class: 'mono ellipsis', style: { maxWidth: '520px' } }, `${r.req.method} ${r.req.url}`),
        h('button', { class: 'btn', style: { marginTop: '12px' }, html: icon('stop') + `<span>${esc(t('cancel'))}</span>`, onClick: () => { if (r.abort) r.abort(); } })))));
      return;
    }
    const res = r.res;
    const resp = h('div', { class: 'resp' });
    pane.append(resp);
    if (!res.ok) {
      const hint = r.via === 'page' ? t('errHintPage') : /Failed to fetch|NetworkError/i.test(res.error) ? t('errHintNet') : '';
      resp.append(h('div', { class: 'resphead' }, h('span', { class: 'pill err' }, res.error === 'timeout' ? t('timeout') : res.error === 'aborted' ? t('aborted') : t('failed')),
        h('span', { class: 'stat' }, t('time'), h('b', null, fmtMs(res.time)))),
      h('div', { class: 'note err', html: icon('alert') + `<div><b>${esc(res.error)}</b>${hint ? `<div style="margin-top:4px;color:var(--muted)">${esc(hint)}</div>` : ''}</div>` }),
      sentInfo(r));
      return;
    }
    const sc = res.type === 'opaqueredirect' ? 's3' : statusClass(res.status);
    const bodyObj = { text: res.body, base64: res.base64, size: res.size, contentType: res.contentType, truncated: res.truncated };
    let rt = localStorage.getItem('client:resptab') || 'body';
    const area = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: 0 } });
    const fillResp = () => {
      area.textContent = '';
      if (rt === 'body') {
        if (res.type === 'opaqueredirect') area.append(h('div', { class: 'note', html: icon('info') + `<span>${esc(t('opaqueRedirect'))}</span>` }));
        area.append(viewer(bodyObj, { name: (splitUrl(r.req.url).name || 'response').replace(/[^\w.-]+/g, '_') }));
      } else if (rt === 'headers') {
        area.append(h('div', { class: 'pane-scroll pad' }, h('div', { class: 'kvlist' }, (res.headers || []).map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])),
          h('p', { class: 'faint', style: { fontSize: '12px', marginTop: '12px' } }, t('setCookieHidden'))));
      } else area.append(h('div', { class: 'pane-scroll' }, sentInfo(r)));
    };
    const tb = tabbar([{ id: 'body', label: t('tabBody') }, { id: 'headers', label: t('tabHeaders'), count: (res.headers || []).length }, { id: 'info', label: t('tabRequestSent') }], rt,
      (id) => { rt = id; localStorage.setItem('client:resptab', id); fillResp(); });
    resp.append(h('div', { class: 'resphead' },
      h('span', { class: 'pill ' + sc }, res.type === 'opaqueredirect' ? t('redirect') : `${res.status} ${res.statusText || ''}`.trim()),
      h('span', { class: 'stat' }, t('time'), h('b', null, fmtMs(res.time))),
      res.ttfb != null ? h('span', { class: 'stat', title: 'Time to first byte' }, 'TTFB', h('b', null, fmtMs(res.ttfb))) : null,
      h('span', { class: 'stat' }, t('size'), h('b', null, fmtBytes(res.size))),
      res.redirected ? h('span', { class: 'badge info', title: res.url }, t('redirected')) : null,
      h('span', { class: 'badge' }, r.via === 'page' ? t('viaPage') : t('viaExt')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', html: icon('zap') + `<span>${esc(t('mockFromResp'))}</span>`, title: t('mockFromRespHint'), onClick: () => ctx.addRule({
        action: 'mock', match: 'equals', pattern: r.req.url.split('#')[0], method: r.req.method, status: res.status || 200,
        contentType: (res.contentType || 'application/json').split(';')[0], body: res.body || '', headers: [], name: t('mockName', { name: splitUrl(r.req.url).name })
      }) })),
    tb.el, area);
    fillResp();
  }

  function sentInfo(r) {
    const req = r.req;
    const notes = (r.res && r.res.notes) || {};
    const box = h('div', { class: 'pad' });
    box.append(h('div', { class: 'kvlist', style: { marginBottom: '14px' } },
      h('div', { class: 'k' }, t('gMethod')), h('div', { class: 'v' }, req.method),
      h('div', { class: 'k' }, 'URL'), h('div', { class: 'v' }, req.url),
      h('div', { class: 'k' }, t('sendVia')), h('div', { class: 'v' }, r.via === 'page' ? `${t('viaPage')} (${notes.origin || ''})` : t('viaExt'))));
    if (notes.forced && notes.forced.length) box.append(h('div', { class: 'note', style: { margin: '0 0 10px' }, html: icon('info') + `<span>${esc(t('forcedNote', { h: notes.forced.join(', ') }))}</span>` }));
    if (notes.forcedError) box.append(h('div', { class: 'note warn', style: { margin: '0 0 10px' }, html: icon('alert') + `<span>${esc(t('forcedErr', { e: notes.forcedError }))}</span>` }));
    if (notes.dropped && notes.dropped.length) box.append(h('div', { class: 'note warn', style: { margin: '0 0 10px' }, html: icon('alert') + `<span>${esc(t('droppedNote', { h: notes.dropped.join(', ') }))}</span>` }));
    if (req.missing && req.missing.length) box.append(h('div', { class: 'note warn', style: { margin: '0 0 10px' }, html: icon('alert') + `<span>${esc(t('missingVars', { v: req.missing.join(', ') }))}</span>` }));
    box.append(h('h4', { class: 'muted', style: { margin: '6px 0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em' } }, t('secReqHeaders')),
      req.headers.length ? h('div', { class: 'kvlist' }, req.headers.map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])) : h('div', { class: 'faint' }, t('noHeaders')));
    if (req.body && req.body.type !== 'none') {
      box.append(h('h4', { class: 'muted', style: { margin: '14px 0 6px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em' } }, t('secReqBody')),
        req.body.fields ? h('div', { class: 'kvlist' }, req.body.fields.map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])) : codeBlock(req.body.text || '', 'text'));
    }
    return box;
  }

  // ---------------------------------------------------------------- geçmiş
  async function addHistory(spec, res, via, sentUrl) {
    const limit = ctx.settings().historyLimit || 200;
    const item = { id: uid(), at: Date.now(), spec: clone(spec), url: sentUrl, status: res.ok ? res.status : 0, error: res.ok ? '' : res.error, time: res.time, size: res.size, via };
    delete item.spec.ui;
    history = await store.update('history', [], (list) => [item, ...list].slice(0, limit));
    renderHistory();
  }

  function renderHistory() {
    const q = histSearch.value.trim().toLowerCase();
    histList.textContent = '';
    const items = history.filter((x) => !q || (x.url || x.spec.url).toLowerCase().includes(q) || (x.spec.name || '').toLowerCase().includes(q) || x.spec.method.toLowerCase() === q);
    if (!items.length) { histList.append(h('p', { class: 'faint', style: { padding: '10px', fontSize: '12px' } }, q ? t('noMatch') : t('historyEmpty'))); return; }
    let lastDay = '';
    for (const x of items) {
      const day = new Date(x.at).toLocaleDateString();
      if (day !== lastDay) { histList.append(h('div', { class: 'group' }, day === new Date().toLocaleDateString() ? t('today') : day)); lastDay = day; }
      const u = splitUrl(x.url || x.spec.url);
      const it = h('div', { class: 'hitem', title: x.url || x.spec.url, onClick: () => open(x.spec) },
        h('span', { class: 'm m-' + x.spec.method }, x.spec.method),
        h('div', { class: 'u' }, x.spec.name || u.path || x.spec.url, h('small', null, [u.host, fmtAgo(x.at, t)].filter(Boolean).join(' · '))),
        h('span', { class: 'st ' + statusClass(x.status, x.error) }, x.error ? '✕' : x.status));
      it.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        menu(ev.clientX, ev.clientY, [
          { icon: 'edit', label: t('openInTab'), onClick: () => open(x.spec) },
          { icon: 'send', label: t('openAndSend'), onClick: () => open(x.spec, { send: true }) },
          { icon: 'save', label: t('saveToCollection'), onClick: () => ctx.saveSpec(x.spec) },
          { icon: 'code', label: t('copyCurl'), onClick: async () => { await copyText(toCurl(resolve(x.spec, envs.find((e) => e.id === activeEnv)))); toast(t('copied')); } },
          '-',
          { icon: 'trash', label: t('remove'), danger: true, onClick: async () => { history = await store.update('history', [], (l) => l.filter((y) => y.id !== x.id)); renderHistory(); } }
        ]);
      });
      histList.append(it);
    }
  }

  async function clearHistory() {
    if (!history.length || !(await confirm(t('clearHistory'), t('clearHistoryText')))) return;
    history = [];
    await store.set('history', []);
    renderHistory();
  }

  // ---------------------------------------------------------------- kaydet, kod, ortamlar
  async function save(d) {
    if (d.link) {
      const ok = await ctx.updateSaved(d.link, d.spec);
      if (ok) { d.dirty = false; renderTabs(); persist(); toast(t('savedTo', { c: ctx.collectionName(d.link.col) })); return; }
    }
    const link = await ctx.saveSpec(d.spec);
    if (link) { d.link = link; d.spec.name = link.name || d.spec.name; d.dirty = false; renderTabs(); renderEditor(); persist(); }
  }

  function showCode(spec) {
    const req = resolve(spec, envs.find((e) => e.id === activeEnv));
    const gen = { curl: toCurl, fetch: toFetch, python: toPython, httpie: toHttpie };
    let cur = localStorage.getItem('client:code') || 'curl';
    const area = h('div', { style: { maxHeight: '60vh', overflow: 'auto', borderRadius: '8px', border: '1px solid var(--line)' } });
    const draw = () => { area.textContent = ''; area.append(codeBlock(gen[cur](req), 'text')); };
    const s = seg([{ v: 'curl', label: 'cURL' }, { v: 'fetch', label: 'JavaScript fetch' }, { v: 'python', label: 'Python requests' }, { v: 'httpie', label: 'HTTPie' }], cur, (v) => { cur = v; localStorage.setItem('client:code', v); draw(); });
    draw();
    modal({
      title: t('codeTitle'), wide: true,
      body: h('div', null, h('div', { class: 'row', style: { marginBottom: '10px' } }, s.el), area,
        req.missing.length ? h('p', { class: 'faint', style: { fontSize: '12px' } }, t('missingVars', { v: req.missing.join(', ') })) : null),
      actions: [{ label: t('close'), kind: 'ghost' }, { label: t('copy'), kind: 'primary', onClick: async () => { await copyText(gen[cur](req)); toast(t('copied')); } }]
    });
  }

  function renderEnvSel() {
    envSel.textContent = '';
    envSel.append(h('option', { value: '' }, t('noEnv')));
    for (const e of envs) envSel.append(h('option', { value: e.id, selected: e.id === activeEnv }, e.name));
    envSel.value = envs.some((e) => e.id === activeEnv) ? activeEnv : '';
  }

  function manageEnvs() {
    let list = clone(envs);
    let cur = list.find((e) => e.id === activeEnv) || list[0] || null;
    const left = h('div', { style: { width: '200px', borderRight: '1px solid var(--line)', padding: '10px', display: 'flex', flexDirection: 'column', gap: '4px' } });
    const right = h('div', { style: { flex: '1', padding: '14px', minWidth: 0 } });
    const draw = () => {
      left.textContent = '';
      for (const e of list) {
        left.append(h('div', { class: 'hitem' + (cur && cur.id === e.id ? ' on' : ''), style: { gridTemplateColumns: '1fr auto' }, onClick: () => { cur = e; draw(); } },
          h('span', { class: 'u' }, e.name), h('span', { class: 'faint', style: { fontSize: '11px' } }, (e.vars || []).length)));
      }
      left.append(h('button', { class: 'btn sm', style: { marginTop: '6px' }, html: icon('plus') + `<span>${esc(t('newEnv'))}</span>`, onClick: () => {
        const e = { id: uid(), name: t('envDefaultName', { n: list.length + 1 }), vars: [{ k: 'baseUrl', v: 'https://api.example.com', on: true }] };
        list.push(e); cur = e; draw();
      } }));
      right.textContent = '';
      if (!cur) { right.append(h('p', { class: 'muted' }, t('envEmpty'))); return; }
      const nm = h('input', { class: 'input', value: cur.name, style: { flex: '1', height: '34px' } });
      nm.addEventListener('input', () => { cur.name = nm.value; });
      const ed = kvEditor({ rows: cur.vars, keyPh: t('variable'), valPh: t('value'), onChange: (rows) => { cur.vars = rows; } });
      right.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, nm,
        h('button', { class: 'btn danger sm', html: icon('trash'), title: t('remove'), onClick: () => { list = list.filter((x) => x !== cur); cur = list[0] || null; draw(); } })),
      ed.el, h('p', { class: 'faint', style: { fontSize: '12px', marginTop: '10px' } }, t('envHint')));
    };
    draw();
    modal({
      title: t('manageEnvs'), wide: true, flush: true,
      body: h('div', { style: { display: 'flex', minHeight: '360px' } }, left, right),
      actions: [{ label: t('cancel'), kind: 'ghost' }, { label: t('save'), kind: 'primary', onClick: async () => {
        envs = list;
        await store.set('envs', envs);
        if (cur && !activeEnv) { activeEnv = cur.id; await store.set('activeEnv', activeEnv); }
        renderEnvSel();
        toast(t('saved'));
      } }]
    });
  }

  function importCurl() {
    const ta = h('textarea', { class: 'textarea', rows: 10, style: { width: '100%' }, placeholder: "curl 'https://api.example.com/users' -H 'Authorization: Bearer …'" });
    modal({
      title: t('importCurl'), wide: true, body: ta,
      actions: [{ label: t('cancel'), kind: 'ghost' }, { label: t('import'), kind: 'primary', onClick: () => {
        try { open(parsedToSpec(parseCurl(ta.value))); toast(t('curlImported')); } catch (e) { toast(t('curlBad'), 'err'); return false; }
        return true;
      } }]
    });
  }

  // ---------------------------------------------------------------- kısayollar ve açılış
  document.addEventListener('keydown', (ev) => {
    if (!root.classList.contains('on') || document.querySelector('.modal-back')) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); doSend(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); const d = drafts.find((x) => x.id === active); if (d) save(d); }
  });

  (async () => {
    const saved = await store.get('drafts', []);
    drafts = (saved || []).map((d) => ({ id: d.id, spec: { ...newSpec(), ...d.spec }, link: d.link, dirty: d.dirty }));
    if (!drafts.length) drafts.push({ id: uid(), spec: newSpec(), link: null, dirty: false });
    envs = await store.get('envs', []);
    activeEnv = await store.get('activeEnv', '');
    history = await store.get('history', []);
    renderEnvSel();
    renderHistory();
    const want = localStorage.getItem('client:active');
    activate(drafts.some((d) => d.id === want) ? want : drafts[0].id);
  })();
  store.on('envs', (v) => { envs = v || []; renderEnvSel(); });

  return { open, importCurl, send: doSend, unlink: (link) => { for (const d of drafts) if (d.link && d.link.item === link.item) { d.link = null; d.dirty = true; } renderTabs(); persist(); } };
}
