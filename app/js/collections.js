// Koleksiyonlar: kayıtlı istekler. ReqLab JSON, Postman v2.x koleksiyonu, HAR ve cURL içe aktarılabilir.
import { h, esc, uid, clone, splitUrl, queryRows, download, pickFile, fileStamp, debounce } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast, modal, menu, prompt, confirm } from './ui.js';
import { newSpec, parsedToSpec } from './spec.js';
import { parseCurl } from './codegen.js';
import * as store from './store.js';

export async function getCollections() {
  return store.get('collections', []);
}

// Kaydetme penceresi: var olan koleksiyona ya da yeni koleksiyona. Dönüş: { col, item, name } | null
export function saveDialog(spec) {
  return new Promise(async (resolve) => {
    const cols = await getCollections();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const name = h('input', { class: 'input', value: spec.name || `${spec.method} ${splitUrl(spec.url).path}`.slice(0, 80) });
    const sel = h('select', { class: 'select' },
      cols.map((c) => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, t('newCollectionOpt')));
    const newName = h('input', { class: 'input', placeholder: t('collectionName'), value: cols.length ? '' : t('myCollection') });
    const newRow = h('div', { class: 'field' }, h('label', null, t('collectionName')), newName);
    const sync = () => { newRow.hidden = sel.value !== '__new'; };
    if (!cols.length) sel.value = '__new';
    sel.addEventListener('change', sync);
    sync();
    modal({
      title: t('saveRequest'),
      body: h('div', null, h('div', { class: 'field' }, h('label', null, t('requestName')), name), h('div', { class: 'field' }, h('label', null, t('collection')), sel), newRow),
      actions: [{ label: t('cancel'), kind: 'ghost', onClick: () => finish(null) }, {
        label: t('save'), kind: 'primary', onClick: async () => {
          const item = { ...clone(spec), id: uid(), name: name.value.trim() || spec.url };
          delete item.ui;
          let colId = sel.value;
          await store.update('collections', [], (list) => {
            if (colId === '__new') {
              const c = { id: uid(), name: newName.value.trim() || t('myCollection'), items: [], createdAt: Date.now() };
              list.push(c);
              colId = c.id;
            }
            const c = list.find((x) => x.id === colId);
            c.items.push(item);
            return list;
          });
          toast(t('savedTo', { c: (await getCollections()).find((c) => c.id === colId).name }));
          finish({ col: colId, item: item.id, name: item.name });
        }
      }],
      onClose: () => finish(null)
    });
  });
}

export async function updateSaved(link, spec) {
  let ok = false;
  await store.update('collections', [], (list) => {
    const c = list.find((x) => x.id === link.col);
    const i = c ? c.items.findIndex((x) => x.id === link.item) : -1;
    if (i < 0) return undefined;
    const next = { ...clone(spec), id: link.item };
    delete next.ui;
    c.items[i] = next;
    ok = true;
    return list;
  });
  return ok;
}

// ---------------------------------------------------------------- içe aktarma

function fromPostmanItem(it) {
  const r = it.request || {};
  const url = typeof r.url === 'string' ? r.url : (r.url && r.url.raw) || '';
  const headers = (r.header || []).map((x) => ({ k: x.key, v: x.value, on: !x.disabled }));
  let body = { mode: 'none', text: '', form: [], contentType: '' };
  const b = r.body || {};
  if (b.mode === 'raw') {
    const lang = b.options && b.options.raw && b.options.raw.language;
    body = { mode: lang === 'json' ? 'json' : 'text', text: b.raw || '', form: [], contentType: lang === 'xml' ? 'application/xml' : '' };
  } else if (b.mode === 'urlencoded') body = { mode: 'form', text: '', form: (b.urlencoded || []).map((x) => ({ k: x.key, v: x.value, on: !x.disabled })), contentType: '' };
  else if (b.mode === 'formdata') body = { mode: 'multipart', text: '', form: (b.formdata || []).filter((x) => x.type !== 'file').map((x) => ({ k: x.key, v: x.value, on: !x.disabled })), contentType: '' };
  else if (b.mode === 'graphql' && b.graphql) body = { mode: 'json', text: JSON.stringify({ query: b.graphql.query, variables: b.graphql.variables ? JSON.parse(b.graphql.variables || '{}') : {} }, null, 2), form: [], contentType: '' };
  const auth = { ...newSpec().auth };
  const a = r.auth;
  const val = (arr, k) => ((arr || []).find((x) => x.key === k) || {}).value || '';
  if (a && a.type === 'bearer') Object.assign(auth, { type: 'bearer', token: val(a.bearer, 'token') });
  if (a && a.type === 'basic') Object.assign(auth, { type: 'basic', user: val(a.basic, 'username'), pass: val(a.basic, 'password') });
  if (a && a.type === 'apikey') Object.assign(auth, { type: 'apikey', key: val(a.apikey, 'key'), value: val(a.apikey, 'value'), in: val(a.apikey, 'in') === 'query' ? 'query' : 'header' });
  return newSpec({ id: uid(), name: it.name || url, method: (r.method || 'GET').toUpperCase(), url, params: queryRows(url), headers, body, auth });
}

function flattenPostman(items, prefix = '') {
  const out = [];
  for (const it of items || []) {
    if (it.item) out.push(...flattenPostman(it.item, prefix + it.name + ' / '));
    else if (it.request) { const s = fromPostmanItem(it); s.name = prefix + s.name; out.push(s); }
  }
  return out;
}

function fromHar(har) {
  return (har.log.entries || []).map((e) => {
    const r = e.request;
    const headers = (r.headers || []).filter((x) => !/^:/.test(x.name)).map((x) => ({ k: x.name, v: x.value, on: !/^(sec-|accept-encoding|connection|host|content-length)/i.test(x.name) }));
    let body = { mode: 'none', text: '', form: [], contentType: '' };
    if (r.postData) {
      const mt = r.postData.mimeType || '';
      if (r.postData.params && r.postData.params.length) body = { mode: /multipart/.test(mt) ? 'multipart' : 'form', text: '', form: r.postData.params.map((p) => ({ k: p.name, v: p.value || '', on: true })), contentType: mt };
      else body = { mode: /json/.test(mt) ? 'json' : 'text', text: r.postData.text || '', form: [], contentType: mt };
    }
    return newSpec({ id: uid(), name: `${r.method} ${splitUrl(r.url).path}`.slice(0, 80), method: r.method, url: r.url, params: queryRows(r.url), headers, body });
  });
}

export function importText(text, fileName = '') {
  const s = text.trim();
  if (/^curl\s/i.test(s)) {
    const specs = s.split(/\n(?=\s*curl\s)/i).map((c) => ({ ...parsedToSpec(parseCurl(c)), id: uid() }));
    return { name: t('importedName'), items: specs };
  }
  const j = JSON.parse(s);
  if (j && j.reqlab && j.collections) return { many: j.collections };
  if (j && j.reqlab && j.collection) return { name: j.collection.name, items: j.collection.items };
  if (j && j.info && j.item) return { name: j.info.name || t('importedName'), items: flattenPostman(j.item) };
  if (j && j.log && j.log.entries) return { name: fileName.replace(/\.har$/i, '') || 'HAR', items: fromHar(j) };
  throw new Error('unknownFormat');
}

// ---------------------------------------------------------------- görünüm

export function mountCollections(root, ctx) {
  let cols = [];
  let q = '';
  const search = h('input', { class: 'input', placeholder: t('searchCollections'), style: { width: '260px' } });
  search.addEventListener('input', debounce(() => { q = search.value.trim().toLowerCase(); render(); }, 120));
  const page = h('div', { class: 'grid-page' });
  root.append(
    h('div', { class: 'vtitle' },
      h('div', { class: 'grow' }, h('h1', null, t('navCollections')), h('p', null, t('collectionsSub'))),
      h('div', { class: 'search' }, h('span', { html: icon('search') }), search),
      h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: importFlow }),
      h('button', { class: 'btn', html: icon('download') + `<span>${esc(t('exportAll'))}</span>`, onClick: exportAll }),
      h('button', { class: 'btn primary', html: icon('plus') + `<span>${esc(t('newCollection'))}</span>`, onClick: createCol })),
    page);

  async function createCol() {
    const name = await prompt(t('newCollection'), '', t('collectionName'));
    if (!name) return;
    await store.update('collections', [], (list) => [...list, { id: uid(), name, items: [], createdAt: Date.now() }]);
  }

  async function importFlow() {
    const ta = h('textarea', { class: 'textarea', rows: 9, style: { width: '100%' }, placeholder: t('importPh') });
    modal({
      title: t('import'), wide: true,
      body: h('div', null,
        h('p', { class: 'muted', style: { marginTop: 0 } }, t('importText')),
        h('button', { class: 'btn', style: { marginBottom: '10px' }, html: icon('file') + `<span>${esc(t('chooseFile'))}</span>`, onClick: async () => {
          const f = await pickFile('.json,.har,.txt,.sh,.curl');
          if (f) { ta.value = f.text; ta.dataset.name = f.name; }
        } }), ta),
      actions: [{ label: t('cancel'), kind: 'ghost' }, { label: t('import'), kind: 'primary', onClick: async () => {
        let r;
        try { r = importText(ta.value, ta.dataset.name || ''); } catch (e) { toast(t('importFailed', { e: e.message === 'unknownFormat' ? t('unknownFormat') : e.message }), 'err'); return false; }
        const add = r.many ? r.many.map((c) => ({ ...c, id: uid(), items: c.items.map((i) => ({ ...i, id: uid() })) })) : [{ id: uid(), name: r.name, items: r.items, createdAt: Date.now() }];
        await store.update('collections', [], (list) => [...list, ...add]);
        toast(t('imported', { n: add.reduce((a, c) => a + c.items.length, 0) }));
        return true;
      } }]
    });
  }

  function exportCol(c) {
    download(`${c.name.replace(/[^\w.-]+/g, '_')}.reqlab.json`, JSON.stringify({ reqlab: 1, collection: c }, null, 2));
  }

  function exportAll() {
    if (!cols.length) { toast(t('nothingToExport'), 'warn'); return; }
    download(`reqlab-collections-${fileStamp()}.json`, JSON.stringify({ reqlab: 1, collections: cols }, null, 2));
  }

  function render() {
    page.textContent = '';
    if (!cols.length) {
      page.append(h('div', { class: 'empty', style: { height: '100%' } }, h('div', null,
        h('div', { class: 'ico', html: icon('folder') }), h('h3', null, t('colEmptyTitle')), h('p', null, t('colEmptyText')),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
          h('button', { class: 'btn primary', html: icon('plus') + `<span>${esc(t('newCollection'))}</span>`, onClick: createCol }),
          h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: importFlow })))));
      return;
    }
    const cards = h('div', { class: 'cards' });
    for (const c of cols) {
      const items = c.items.filter((i) => !q || (i.name || '').toLowerCase().includes(q) || i.url.toLowerCase().includes(q));
      if (q && !items.length && !c.name.toLowerCase().includes(q)) continue;
      const collapsed = localStorage.getItem('col:closed:' + c.id) === '1' && !q;
      const card = h('div', { class: 'card' },
        h('div', { class: 'chead' },
          h('button', { class: 'btn ghost sm icon', html: icon(collapsed ? 'chevR' : 'chevD'), onClick: () => { localStorage.setItem('col:closed:' + c.id, collapsed ? '0' : '1'); render(); } }),
          h('div', { class: 'folder-ico', html: icon('folder') }),
          h('div', null, h('h3', null, c.name), h('div', { class: 'meta' }, t(c.items.length === 1 ? 'nRequest' : 'nRequests', { n: c.items.length }))),
          h('div', { class: 'tools' },
            h('button', { class: 'btn sm', html: icon('plus') + `<span>${esc(t('addRequest'))}</span>`, onClick: async () => {
              const s = newSpec({ name: t('newRequest') });
              await store.update('collections', [], (list) => { list.find((x) => x.id === c.id).items.push(s); return list; });
              ctx.openSpec(s, { link: { col: c.id, item: s.id, name: s.name } });
            } }),
            h('button', { class: 'btn ghost sm icon', html: icon('more'), onClick: (ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              menu(r.left - 180, r.bottom + 4, [
                { icon: 'edit', label: t('rename'), onClick: async () => {
                  const name = await prompt(t('rename'), c.name);
                  if (name) await store.update('collections', [], (list) => { list.find((x) => x.id === c.id).name = name; return list; });
                } },
                { icon: 'download', label: t('export'), onClick: () => exportCol(c) },
                { icon: 'play', label: t('openAll'), onClick: () => { for (const i of c.items.slice(0, 12)) ctx.openSpec(i, { link: { col: c.id, item: i.id, name: i.name } }); } },
                '-',
                { icon: 'trash', label: t('deleteCollection'), danger: true, onClick: async () => {
                  if (!(await confirm(t('deleteCollection'), t('deleteCollectionText', { name: c.name, n: c.items.length })))) return;
                  await store.update('collections', [], (list) => list.filter((x) => x.id !== c.id));
                } }
              ]);
            } }))));
      if (!collapsed) {
        const box = h('div', { class: 'citems' });
        if (!items.length) box.append(h('div', { class: 'citem', style: { cursor: 'default', gridTemplateColumns: '1fr' } }, h('span', { class: 'faint' }, t('colNoItems'))));
        for (const it of items) {
          const row = h('div', { class: 'citem', onClick: () => ctx.openSpec(it, { link: { col: c.id, item: it.id, name: it.name } }) },
            h('span', { class: 'm m-' + it.method }, it.method),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'nm ellipsis' }, it.name || splitUrl(it.url).path), h('div', { class: 'u' }, it.url)),
            h('div', { class: 'tools' },
              h('button', { class: 'btn ghost sm icon', html: icon('send'), title: t('openAndSend'), onClick: (ev) => { ev.stopPropagation(); ctx.openSpec(it, { send: true, link: { col: c.id, item: it.id, name: it.name } }); } }),
              h('button', { class: 'btn ghost sm icon', html: icon('more'), onClick: (ev) => { ev.stopPropagation(); itemMenu(ev, c, it); } })));
          row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); itemMenu(ev, c, it); });
          box.append(row);
        }
        card.append(box);
      }
      cards.append(card);
    }
    page.append(cards);
  }

  function itemMenu(ev, c, it) {
    menu(ev.clientX, ev.clientY, [
      { icon: 'edit', label: t('openInTab'), onClick: () => ctx.openSpec(it, { link: { col: c.id, item: it.id, name: it.name } }) },
      { icon: 'copy', label: t('duplicate'), onClick: () => store.update('collections', [], (list) => {
        const col = list.find((x) => x.id === c.id);
        const i = col.items.findIndex((x) => x.id === it.id);
        col.items.splice(i + 1, 0, { ...clone(it), id: uid(), name: (it.name || '') + ' (2)' });
        return list;
      }) },
      { icon: 'edit', label: t('rename'), onClick: async () => {
        const name = await prompt(t('rename'), it.name || '');
        if (name) await store.update('collections', [], (list) => { list.find((x) => x.id === c.id).items.find((x) => x.id === it.id).name = name; return list; });
      } },
      cols.length > 1 ? { icon: 'folder', label: t('moveTo'), onClick: () => moveItem(c, it) } : null,
      '-',
      { icon: 'trash', label: t('remove'), danger: true, onClick: async () => {
        await store.update('collections', [], (list) => { const col = list.find((x) => x.id === c.id); col.items = col.items.filter((x) => x.id !== it.id); return list; });
        ctx.unlink({ col: c.id, item: it.id });
      } }
    ]);
  }

  function moveItem(c, it) {
    const sel = h('select', { class: 'select', style: { width: '100%', height: '34px' } }, cols.filter((x) => x.id !== c.id).map((x) => h('option', { value: x.id }, x.name)));
    modal({
      title: t('moveTo'), body: sel,
      actions: [{ label: t('cancel'), kind: 'ghost' }, { label: t('ok'), kind: 'primary', onClick: () => store.update('collections', [], (list) => {
        const from = list.find((x) => x.id === c.id);
        from.items = from.items.filter((x) => x.id !== it.id);
        list.find((x) => x.id === sel.value).items.push(it);
        return list;
      }) }]
    });
  }

  const load = async () => { cols = await getCollections(); render(); };
  store.on('collections', (v) => { cols = v || []; render(); });
  load();
  return { names: () => cols };
}
