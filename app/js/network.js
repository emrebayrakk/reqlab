// Ağ görünümü: canlı istek listesi (sanal kaydırma), filtreler ve ayrıntı paneli.
import { h, esc, fmtBytes, fmtMs, fmtClock, statusClass, splitUrl, queryRows, copyText, debounce } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast, menu, splitter, tabbar, seg } from './ui.js';
import { viewer, codeBlock } from './viewer.js';
import { typeGroup, duration, responseSize, contentType, requestBody, responseBody } from './capture.js';
import { saveDialog, exportDialog } from './recordings.js';
import { filterPanel, compile, normalize, count as filterCount, isEmpty, TYPES } from './filters.js';
import { entryToSpec, resolve, send } from './spec.js';
import { toCurl, toFetch, toPython, toHttpie } from './codegen.js';

const ROW = 30;
const TYPE_ICON = { xhr: '{}', doc: 'H', js: 'JS', css: '#', img: 'IM', media: '▶', font: 'Aa', ws: 'WS', other: '•' };

function typeLabel(e) {
  if (e.type === 'xmlhttprequest') return e.hook ? e.hook.kind : 'fetch/xhr';
  if (e.type === 'main_frame') return 'document';
  if (e.type === 'sub_frame') return 'iframe';
  return e.type;
}

// "method:POST status:4xx domain:api -bar is:error" gibi filtre ifadesi.
function parseFilter(q) {
  const out = { inc: [], exc: [], method: null, status: null, domain: null, type: null, is: [] };
  for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(-?)(method|status|domain|type|is):(.+)$/i.exec(raw);
    if (m) {
      const key = m[2].toLowerCase();
      const val = m[3].toLowerCase();
      if (key === 'is') out.is.push(val); else out[key] = { val, neg: !!m[1] };
    } else if (raw.startsWith('-') && raw.length > 1) out.exc.push(raw.slice(1).toLowerCase());
    else out.inc.push(raw.toLowerCase());
  }
  return out;
}

function matchFilter(e, f) {
  const url = e.url.toLowerCase();
  for (const s of f.inc) if (!url.includes(s)) return false;
  for (const s of f.exc) if (url.includes(s)) return false;
  const test = (cond, ok) => !cond || (cond.neg ? !ok : ok);
  if (!test(f.method, e.method.toLowerCase() === (f.method && f.method.val))) return false;
  if (f.status) {
    const v = f.status.val;
    const st = String(e.status || '');
    const ok = /^\dxx$/.test(v) ? st[0] === v[0] : st === v;
    if (!test(f.status, ok)) return false;
  }
  if (f.domain) {
    let host = '';
    try { host = new URL(e.url).host.toLowerCase(); } catch { /* yok say */ }
    if (!test(f.domain, host.includes(f.domain.val))) return false;
  }
  if (f.type && !test(f.type, typeGroup(e.type) === f.type.val || e.type === f.type.val)) return false;
  for (const w of f.is) {
    if (w === 'error' && !(e.error || e.status >= 400)) return false;
    if (w === 'mock' && e.source !== 'mock') return false;
    if (w === 'pending' && e.state !== 'pending') return false;
    if (w === 'cached' && !e.fromCache) return false;
  }
  return true;
}

export function mountNetwork(root, ctx) {
  const cap = ctx.capture;
  const savedAdv = (() => { try { return JSON.parse(localStorage.getItem('net:adv') || 'null'); } catch { return null; } })();
  const state = {
    q: '', tab: ctx.lockTab != null ? String(ctx.lockTab) : ctx.initialTab != null ? String(ctx.initialTab) : 'all', sel: null, sort: { key: 'start', dir: 1 },
    layout: localStorage.getItem('net:layout') || 'right', dtab: 'headers', code: 'curl', adv: normalize(savedAdv)
  };
  let advC = compile(state.adv);
  let view = [];
  let stick = true;
  // Kaynak: null = canlı yakalama, yoksa saklanmış bir kayıt { rec, entries }.
  let source = null;
  const all = () => (source ? source.entries : cap.entries);
  const findEntry = (id) => all().find((x) => x.id === id);
  // Çoklu seçim (Ctrl/Shift + tık); state.sel ayrıntısı gösterilen istektir.
  let multi = new Set();
  let anchor = null;
  const selectedEntries = () => view.filter((e) => multi.has(e.id));
  const scopes = () => ({ selected: multi.size > 1 ? selectedEntries() : [], visible: view, all: all() });
  let tabsMeta = new Map();

  // ---------------------------------------------------------------- araç çubuğu
  const recBtn = h('button', { class: 'btn icon rec', html: icon('record'), onClick: () => { cap.setRecording(!cap.recording); syncRec(); } });
  const syncRec = () => {
    recBtn.classList.toggle('paused', !cap.recording);
    recBtn.title = cap.recording ? t('pauseRec') : t('resumeRec');
    liveDot.classList.toggle('off', !cap.recording);
    liveText.textContent = cap.recording ? (cap.filter ? t('recordingFiltered') : t('recording')) : t('paused');
  };
  const search = h('input', { class: 'input', placeholder: t('netFilterPh'), spellcheck: 'false' });
  search.addEventListener('input', debounce(() => { state.q = search.value; refresh(); }, 120));

  // Tür çipleri (çoklu seçim) ve ayrıntılı filtre paneli aynı filtre durumunu paylaşır.
  const chips = h('div', { class: 'chips' });
  const renderChips = () => {
    chips.textContent = '';
    const types = state.adv.types;
    chips.append(h('button', { class: 'chip' + (!types.length ? ' on' : ''), onClick: () => setAdv({ ...state.adv, types: [] }) }, t('grp_all')));
    for (const g of TYPES) chips.append(h('button', {
      class: 'chip' + (types.includes(g) ? ' on' : ''), title: t('chipMultiHint'),
      onClick: (ev) => {
        const multiSel = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        const next = multiSel ? (types.includes(g) ? types.filter((x) => x !== g) : [...types, g]) : (types.length === 1 && types[0] === g ? [] : [g]);
        setAdv({ ...state.adv, types: next });
      }
    }, t('grp_' + g)));
  };
  const panel = filterPanel(state.adv, (f) => setAdv(f, true));
  const panelBox = h('div', { class: 'fbox', hidden: localStorage.getItem('net:fopen') !== '1' }, panel.el);
  const fBadge = h('span', { class: 'fcount' });
  const filterBtn = h('button', { class: 'btn', title: t('filters'), onClick: () => {
    panelBox.hidden = !panelBox.hidden;
    localStorage.setItem('net:fopen', panelBox.hidden ? '0' : '1');
    filterBtn.classList.toggle('on', !panelBox.hidden);
  } }, h('span', { html: icon('sliders'), style: { display: 'contents' } }), h('span', { class: 'fbtn-label' }, t('filters')), fBadge);
  filterBtn.classList.toggle('on', !panelBox.hidden);
  const capBadge = h('span', { class: 'badge warn', title: t('fCaptureOn') }, h('span', { html: icon('sliders'), style: { display: 'contents' } }), ' ', t('capFiltered'));
  const summary = h('div', { class: 'row', style: { gap: '6px' } });
  function syncFilterUi() {
    const n = filterCount(state.adv);
    fBadge.textContent = n ? String(n) : '';
    fBadge.hidden = !n;
    capBadge.hidden = !(state.adv.capture && !isEmpty(state.adv));
    summary.textContent = '';
    if (n) summary.append(h('span', { class: 'faint', style: { fontSize: '12px' } }, t(n === 1 ? 'nFilter' : 'nFilters', { n })),
      h('button', { class: 'btn ghost sm', onClick: () => { setAdv({ ...normalize({}), capture: state.adv.capture }); } }, t('fClear')));
  }
  // fromPanel: değişiklik panelden geldiyse paneli yeniden çizme (odak kaybolmasın).
  function setAdv(f, fromPanel) {
    state.adv = normalize(f);
    localStorage.setItem('net:adv', JSON.stringify(state.adv));
    advC = compile(state.adv);
    cap.setFilter(state.adv.capture && !advC.empty ? advC : null);
    if (!fromPanel) panel.set(state.adv);
    renderChips();
    syncFilterUi();
    refresh();
  }
  renderChips();
  const tabSel = h('select', { class: 'select', style: { maxWidth: '220px' }, title: t('tabFilter') });
  tabSel.addEventListener('change', () => { state.tab = tabSel.value; refresh(); });
  const preserve = h('label', { class: 'check', title: t('preserveHint') }, h('input', { type: 'checkbox', onChange: (ev) => { cap.preserve = ev.target.checked; } }), t('preserveLog'));
  const layoutBtn = h('button', { class: 'btn ghost icon', onClick: () => { state.layout = state.layout === 'right' ? 'bottom' : 'right'; localStorage.setItem('net:layout', state.layout); applyLayout(); } });
  const liveSep = h('div', { class: 'sep' });
  const clearBtn = h('button', { class: 'btn icon', html: icon('trash'), title: t('clear'), onClick: () => { cap.clear(); multi.clear(); select(null); } });
  const saveBtn = h('button', { class: 'btn ghost icon', html: icon('save'), title: t('saveRecording'), onClick: () => saveCurrent() });
  const exportBtn = h('button', { class: 'btn ghost icon', html: icon('download'), title: t('exportDots'), onClick: () => exportDialog(scopes(), source ? source.rec.name : '') });
  if (ctx.panel) { tabSel.classList.add('panel-hide'); preserve.classList.add('panel-hide'); }
  const toolbar = h('div', { class: 'toolbar nowrap' },
    recBtn,
    clearBtn,
    liveSep,
    h('div', { class: 'search grow' }, h('span', { html: icon('search') }), search),
    filterBtn,
    ctx.lockTab == null ? tabSel : null,
    preserve,
    h('div', { class: 'sep' }),
    saveBtn, exportBtn,
    layoutBtn);
  const subbar = h('div', { class: 'subbar' }, chips, h('span', { class: 'grow' }), capBadge, summary);

  // ---------------------------------------------------------------- liste
  const head = h('div', { class: 'nethead' });
  const spacer = h('div', { class: 'spacer' });
  const body = h('div', { class: 'netbody', tabindex: '0' }, spacer);
  const empty = h('div', { class: 'empty', style: { position: 'absolute', inset: '30px 0 0 0' } },
    h('div', null, h('div', { class: 'ico', html: icon('activity') }), h('h3', null, t('netEmptyTitle')), h('p', null, t('netEmptyText'))));
  const liveDot = h('span', { class: 'livedot' });
  const liveText = h('span');
  const footInfo = h('span');
  const foot = h('div', { class: 'netfoot' }, h('span', { class: 'row', style: { gap: '7px' } }, liveDot, liveText), footInfo);
  const list = h('div', { class: 'netwrap', style: { position: 'relative' } }, head, body, empty, foot);

  const COLS = [
    { key: 'method', label: t('colMethod'), w: '74px' },
    { key: 'status', label: t('colStatus'), w: '78px' },
    { key: 'name', label: t('colName'), w: 'minmax(180px, 1fr)' },
    { key: 'type', label: t('colType'), w: '92px', wide: true },
    { key: 'size', label: t('colSize'), w: '82px', wide: true },
    { key: 'time', label: t('colTime'), w: '82px' },
    { key: 'start', label: t('colWaterfall'), w: '150px', wide: true }
  ];
  let compact = false;
  const cols = () => COLS.filter((c) => !compact || !c.wide);
  const renderHead = () => {
    head.textContent = '';
    list.style.setProperty('--cols', cols().map((c) => c.w).join(' '));
    for (const c of cols()) {
      head.append(h('div', { onClick: () => { state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : 1 }; renderHead(); refresh(); } },
        c.label, state.sort.key === c.key && c.key !== 'start' ? h('span', { class: 'arrow' }, state.sort.dir > 0 ? '▲' : '▼') : null));
    }
  };

  function sortVal(e, key) {
    switch (key) {
      case 'method': return e.method;
      case 'status': return e.error ? 999 : e.status || 0;
      case 'name': return splitUrl(e.url).name.toLowerCase();
      case 'type': return typeLabel(e);
      case 'size': return responseSize(e) || 0;
      case 'time': return duration(e) || 0;
      default: return e.start;
    }
  }

  function compute() {
    const f = parseFilter(state.q);
    const tab = state.tab === 'all' ? null : Number(state.tab);
    view = all().filter((e) => (tab == null || e.tabId === tab)
      && (advC.empty || advC.all(e))
      && matchFilter(e, f));
    const { key, dir } = state.sort;
    if (key !== 'start' || dir !== 1) view.sort((a, b) => { const x = sortVal(a, key); const y = sortVal(b, key); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  }

  let range = { min: 0, max: 1 };
  function computeRange() {
    let min = Infinity;
    let max = 0;
    for (const e of view) {
      if (e.start < min) min = e.start;
      const end = e.tEnd || e.tHeaders || e.start;
      if (end > max) max = end;
    }
    range = { min: isFinite(min) ? min : 0, max: Math.max(max, min + 1) };
  }

  function row(e, i) {
    const g = typeGroup(e.type);
    const u = splitUrl(e.url);
    const st = e.error ? (e.error.includes('BLOCKED') ? 'blocked' : 'failed') : e.state === 'pending' && !e.status ? '…' : String(e.status || '');
    const d = duration(e);
    const r = h('div', {
      class: 'netrow' + (state.sel === e.id || multi.has(e.id) ? ' sel' : '') + (e.error || e.status >= 400 ? ' failed' : ''),
      style: { top: i * ROW + 'px' }, 'data-id': e.id
    });
    const cells = [
      h('div', null, h('span', { class: 'm m-' + e.method }, e.method)),
      h('div', null, h('span', { class: 'st ' + statusClass(e.status, e.error), title: e.error || e.statusText || '' }, st)),
      h('div', { class: 'name', title: e.url }, h('span', { class: 'typeico t-' + g }, TYPE_ICON[g]), h('b', null, u.name || u.host), h('span', null, u.host),
        e.source === 'mock' ? h('span', { class: 'badge mock' }, 'MOCK') : null,
        e.hook && e.hook.delayed ? h('span', { class: 'badge warn' }, t('delayed')) : null)
    ];
    if (!compact) cells.push(h('div', { class: 'ty' }, typeLabel(e)), h('div', { class: 'num' }, e.fromCache ? t('cache') : fmtBytes(responseSize(e))));
    cells.push(h('div', { class: 'num' }, d == null ? (e.state === 'pending' ? '…' : '—') : fmtMs(d)));
    if (!compact) {
      const span = range.max - range.min;
      const left = ((e.start - range.min) / span) * 100;
      const end = e.tEnd || e.tHeaders || e.start;
      const wait = e.tHeaders ? ((e.tHeaders - e.start) / span) * 100 : 0;
      const width = ((end - e.start) / span) * 100;
      cells.push(h('div', null, h('div', { class: 'wf' },
        h('i', { class: 'wait', style: { left: left + '%', width: Math.max(0.3, wait) + '%' } }),
        h('i', { style: { left: (left + wait) + '%', width: Math.max(0.3, width - wait) + '%', background: e.error ? 'var(--err)' : '' } }))));
    }
    r.append(...cells);
    return r;
  }

  function renderRows() {
    const top = body.scrollTop;
    const hgt = body.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW) - 6);
    const last = Math.min(view.length, Math.ceil((top + hgt) / ROW) + 6);
    spacer.style.height = view.length * ROW + 'px';
    spacer.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(row(view[i], i));
    spacer.append(frag);
    empty.hidden = all().length > 0;
  }

  function renderFoot() {
    let bytes = 0;
    let errs = 0;
    for (const e of view) { bytes += responseSize(e) || 0; if (e.error || e.status >= 400) errs++; }
    footInfo.innerHTML = t('netFoot', {
      shown: `<b>${view.length}</b>`, total: `<b>${all().length}</b>`, bytes: `<b>${esc(fmtBytes(bytes))}</b>`, errs: `<b>${errs}</b>`
    }) + (multi.size > 1 ? ' · ' + t('nSelected', { n: `<b>${multi.size}</b>` }) : '');
  }

  function refresh() {
    stick = body.scrollTop + body.clientHeight >= body.scrollHeight - ROW * 2;
    compute();
    computeRange();
    renderRows();
    renderFoot();
    if (stick && state.sort.key === 'start' && state.sort.dir === 1) body.scrollTop = body.scrollHeight;
    if (state.sel != null) {
      const e = findEntry(state.sel);
      if (!e) select(null);
      else if (sig(e) !== detailSig) renderDetail(e);
    }
    ctx.onCount && ctx.onCount(cap.entries.length);
  }

  body.addEventListener('scroll', () => renderRows(), { passive: true });
  new ResizeObserver(() => renderRows()).observe(body);
  // Satırlar canlı trafikte sık yeniden çizildiği için çift tıklama zamanlamayla algılanır.
  let lastClick = { id: 0, at: 0 };
  body.addEventListener('click', (ev) => {
    const r = ev.target.closest('.netrow');
    if (!r) return;
    const id = Number(r.dataset.id);
    const now = Date.now();
    if (ev.ctrlKey || ev.metaKey) {
      if (state.sel != null && multi.size === 0) multi.add(state.sel);
      if (multi.has(id)) multi.delete(id); else multi.add(id);
      anchor = id;
      select(multi.has(id) ? id : [...multi].pop() ?? null);
      renderFoot();
      return;
    }
    if (ev.shiftKey && anchor != null) {
      const a = view.findIndex((x) => x.id === anchor);
      const b = view.findIndex((x) => x.id === id);
      if (a >= 0 && b >= 0) multi = new Set(view.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
      select(id);
      renderFoot();
      return;
    }
    multi = new Set([id]);
    anchor = id;
    if (lastClick.id === id && now - lastClick.at < 450) {
      lastClick = { id: 0, at: 0 };
      const e = findEntry(id);
      if (e) ctx.openSpec(entryToSpec(e));
      return;
    }
    lastClick = { id, at: now };
    select(id);
    renderFoot();
  });
  body.addEventListener('contextmenu', (ev) => {
    const r = ev.target.closest('.netrow');
    if (!r) return;
    ev.preventDefault();
    const e = findEntry(Number(r.dataset.id));
    if (!e) return;
    if (multi.size > 1 && multi.has(e.id)) {
      const n = multi.size;
      menu(ev.clientX, ev.clientY, [
        { icon: 'save', label: t('saveSelected', { n }), onClick: () => saveDialog({ selected: selectedEntries() }) },
        { icon: 'download', label: t('exportSelected', { n }), onClick: () => exportDialog({ selected: selectedEntries() }, source ? source.rec.name : '') },
        '-',
        { icon: 'x', label: t('clearSelection'), onClick: () => { multi = new Set(state.sel != null ? [state.sel] : []); select(state.sel); renderFoot(); } }
      ]);
      return;
    }
    multi = new Set([e.id]);
    anchor = e.id;
    select(e.id);
    menu(ev.clientX, ev.clientY, actionsFor(e));
  });
  body.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      multi = new Set(view.map((x) => x.id));
      for (const r of spacer.children) r.classList.add('sel');
      renderFoot();
      return;
    }
    if (ev.key === 'Escape' && multi.size > 1) { ev.preventDefault(); multi = new Set(state.sel != null ? [state.sel] : []); select(state.sel); renderFoot(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(ev.key)) return;
    ev.preventDefault();
    const i = view.findIndex((e) => e.id === state.sel);
    if (ev.key === 'Escape') return select(null);
    if (ev.key === 'Enter') { const e = view[i]; if (e) ctx.openSpec(entryToSpec(e)); return; }
    const next = view[Math.max(0, Math.min(view.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      multi = new Set([next.id]);
      anchor = next.id;
      select(next.id);
      const y = view.indexOf(next) * ROW;
      if (y < body.scrollTop) body.scrollTop = y;
      else if (y + ROW > body.scrollTop + body.clientHeight) body.scrollTop = y + ROW - body.clientHeight;
    }
  });

  function actionsFor(e) {
    const isGet = e.method === 'GET' || e.method === 'HEAD';
    return [
      { icon: 'edit', label: t('editResend'), key: 'Enter', onClick: () => ctx.openSpec(entryToSpec(e)) },
      { icon: 'refresh', label: t('replay'), onClick: () => ctx.openSpec(entryToSpec(e), { send: true }) },
      '-',
      { icon: 'code', label: t('copyCurl'), onClick: async () => { await copyText(toCurl(resolve(entryToSpec(e)))); toast(t('copied')); } },
      { icon: 'code', label: t('copyFetch'), onClick: async () => { await copyText(toFetch(resolve(entryToSpec(e)))); toast(t('copied')); } },
      { icon: 'link', label: t('copyUrl'), onClick: async () => { await copyText(e.url); toast(t('copied')); } },
      responseBody(e) && responseBody(e).text ? { icon: 'copy', label: t('copyResponse'), onClick: async () => { await copyText(responseBody(e).text); toast(t('copied')); } } : null,
      '-',
      { icon: 'save', label: t('saveToCollection'), onClick: () => ctx.saveSpec(entryToSpec(e)) },
      { icon: 'zap', label: t('mockThis'), onClick: () => ctx.addRule(mockFrom(e)) },
      { icon: 'ban', label: t('blockThis'), onClick: () => ctx.addRule({ action: 'block', match: 'equals', pattern: e.url.split('#')[0], method: isGet ? 'ANY' : e.method, name: t('blockName', { name: splitUrl(e.url).name }) }) },
      { icon: 'hourglass', label: t('delayThis'), onClick: () => ctx.addRule({ action: 'delay', match: 'equals', pattern: e.url.split('#')[0], method: e.method, delay: 2000, name: t('delayName', { name: splitUrl(e.url).name }) }) }
    ];
  }

  function mockFrom(e) {
    const rb = responseBody(e);
    const ct = contentType(e) || 'application/json';
    return {
      action: 'mock', match: 'equals', pattern: e.url.split('#')[0], method: e.method, status: e.status || 200, contentType: ct.split(';')[0],
      body: rb && rb.text && !rb.binary ? rb.text : '', headers: [], name: t('mockName', { name: splitUrl(e.url).name })
    };
  }

  // ---------------------------------------------------------------- ayrıntı
  const detail = h('div', { class: 'detail' });
  const gutter = h('div', { class: 'gutter' });
  const listPane = h('div', { class: 'pane' }, list);
  const detailPane = h('div', { class: 'pane', style: { flex: '1' } }, detail);
  const split = h('div', { class: 'split' }, listPane, gutter, detailPane);
  let detailSig = '';
  const sig = (e) => [e.state, e.status, !!e.hook, !!e.reqHeaders, !!e.resHeaders, e.error, e.fetched ? 1 : 0].join('|');

  // Dar alanda (yan panel) ayrıntı her zaman alta iner.
  const isNarrow = () => document.body.classList.contains('narrow');
  const layoutNow = () => (isNarrow() ? 'bottom' : state.layout);
  let lastNarrow = isNarrow();
  addEventListener('resize', () => { if (isNarrow() !== lastNarrow) { lastNarrow = isNarrow(); applyLayout(); } });

  function applyLayout() {
    const open = state.sel != null;
    const layout = layoutNow();
    layoutBtn.hidden = isNarrow();
    split.classList.toggle('v', layout === 'bottom');
    gutter.hidden = !open;
    detailPane.hidden = !open;
    layoutBtn.innerHTML = icon(state.layout === 'right' ? 'panelB' : 'panel');
    layoutBtn.title = state.layout === 'right' ? t('detailBottom') : t('detailRight');
    if (!open) listPane.style.flex = '1 1 auto';
    else splitter(split, listPane, gutter, { vertical: layout === 'bottom', key: 'net-' + layout + (isNarrow() ? '-n' : ''), initial: layout === 'right' ? 0.52 : isNarrow() ? 0.45 : 0.55, min: isNarrow() ? 120 : 220 });
    const nextCompact = (open && layout === 'right') || isNarrow();
    if (nextCompact !== compact) { compact = nextCompact; renderHead(); }
    renderRows();
  }

  function select(id) {
    const wasOpen = state.sel != null;
    state.sel = id;
    const e = id == null ? null : findEntry(id);
    if (!e) { state.sel = null; detailSig = ''; }
    if (wasOpen !== (state.sel != null)) applyLayout();
    else for (const r of spacer.children) { const rid = Number(r.dataset.id); r.classList.toggle('sel', rid === state.sel || multi.has(rid)); }
    if (e) renderDetail(e);
  }

  function renderDetail(e) {
    detailSig = sig(e);
    const scrollKeep = detail.querySelector('.dbody') ? detail.querySelector('.dbody').scrollTop : 0;
    detail.textContent = '';
    const d = duration(e);
    const sc = statusClass(e.status, e.error);
    const headEl = h('div', { class: 'dhead' },
      h('div', { class: 'grow' },
        h('div', { class: 'url' }, h('span', { class: 'm m-' + e.method, style: { marginRight: '8px' } }, e.method), e.url),
        h('div', { class: 'meta' },
          h('span', { class: 'pill ' + sc }, e.error ? e.error.replace(/^net::/, '') : e.status ? `${e.status} ${e.statusText || ''}`.trim() : t('pending')),
          h('span', null, typeLabel(e)), h('span', null, '·'), h('span', null, fmtMs(d)), h('span', null, '·'), h('span', null, e.fromCache ? t('fromCache') : fmtBytes(responseSize(e))),
          e.source === 'mock' ? h('span', { class: 'badge mock' }, 'MOCK') : null)),
      h('div', { class: 'row', style: { gap: '4px' } },
        h('button', { class: 'btn primary sm', html: icon('edit') + `<span>${esc(t('editResend'))}</span>`, onClick: () => ctx.openSpec(entryToSpec(e)) }),
        h('button', { class: 'btn sm icon', html: icon('refresh'), title: t('replay'), onClick: () => ctx.openSpec(entryToSpec(e), { send: true }) }),
        h('button', { class: 'btn sm icon', html: icon('more'), title: t('more'), onClick: (ev) => { const r = ev.currentTarget.getBoundingClientRect(); menu(r.left - 170, r.bottom + 4, actionsFor(e)); } }),
        h('button', { class: 'btn ghost sm icon', html: icon('x'), title: t('close'), onClick: () => select(null) })));

    const reqCount = (e.reqHeaders || []).length;
    const resCount = (e.resHeaders || []).length;
    const params = queryRows(e.url);
    const rb = requestBody(e);
    const tabs = tabbar([
      { id: 'headers', label: t('tabHeaders'), count: reqCount + resCount || '' },
      { id: 'payload', label: t('tabPayload'), count: params.length + (rb ? 1 : 0) || '' },
      { id: 'response', label: t('tabResponse') },
      { id: 'timing', label: t('tabTiming') },
      { id: 'code', label: t('tabCode') }
    ], state.dtab, (id) => { state.dtab = id; fill(); });
    const dbody = h('div', { class: 'dbody' });
    detail.append(headEl, tabs.el, dbody);

    function section(title, content, tools, open = true) {
      return h('details', { class: 'section', open }, h('summary', null, title, tools ? h('span', { class: 'tools', onClick: (ev) => ev.preventDefault() }, tools) : null), h('div', { class: 'inner' }, content));
    }
    const kvlist = (pairs, emptyKey) => pairs && pairs.length
      ? h('div', { class: 'kvlist' }, pairs.map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]))
      : h('div', { class: 'faint', style: { fontSize: '12px' } }, t(emptyKey || 'none'));
    const copyBtn = (fn) => h('button', { class: 'btn ghost sm icon', html: icon('copy'), title: t('copy'), onClick: async () => { await copyText(fn()); toast(t('copied')); } });
    const hdrText = (list) => (list || []).map(([k, v]) => `${k}: ${v}`).join('\n');

    function fill() {
      dbody.textContent = '';
      dbody.style.display = '';
      if (state.dtab === 'headers') {
        const tab = source ? null : tabsMeta.get(e.tabId);
        const general = [
          [t('gUrl'), e.url], [t('gMethod'), e.method],
          [t('gStatus'), e.error ? e.error : e.status ? `${e.status} ${e.statusText || ''}` : t('pending')],
          e.protocol ? [t('gProtocol'), e.protocol] : null, e.ip ? [t('gRemote'), e.ip] : null,
          [t('gType'), typeLabel(e)], e.initiator ? [t('gInitiator'), e.initiator] : null,
          tab ? [t('gTab'), tab.title || tab.url || String(e.tabId)] : e.tabId >= 0 && !source ? [t('gTab'), String(e.tabId)] : null,
          [t('gStarted'), fmtClock(e.start)], e.fromCache ? [t('gCache'), t('yes')] : null,
          e.redirectTo ? [t('gRedirect'), e.redirectTo] : null,
          [t('gSource'), e.source === 'mock' ? t('srcMock') : e.source === 'import' ? t('srcImport') : e.hook ? t('srcHook') : t('srcNet')]
        ].filter(Boolean);
        dbody.append(
          section(t('secGeneral'), kvlist(general)),
          section(t('secResHeaders') + (resCount ? ` (${resCount})` : ''), kvlist(e.resHeaders, 'noHeaders'), copyBtn(() => hdrText(e.resHeaders))),
          section(t('secReqHeaders') + (reqCount ? ` (${reqCount})` : ''), kvlist(e.reqHeaders || (e.hook && e.hook.reqHeaders), 'noHeaders'), copyBtn(() => hdrText(e.reqHeaders))));
        if (e.hook && e.reqHeaders && e.hook.reqHeaders && e.hook.reqHeaders.length && !e.reqHeaders.length) dbody.append(section(t('secHookHeaders'), kvlist(e.hook.reqHeaders)));
      } else if (state.dtab === 'payload') {
        dbody.append(section(t('secQuery') + (params.length ? ` (${params.length})` : ''), kvlist(params.map((p) => [p.k, p.v]), 'noParams')));
        if (rb && rb.fields) dbody.append(section(t('secFormData'), kvlist(rb.fields), copyBtn(() => new URLSearchParams(rb.fields).toString())));
        else if (rb) {
          const ct = (e.reqHeaders || []).find(([k]) => k.toLowerCase() === 'content-type');
          const v = viewer({ ...rb, contentType: ct ? ct[1] : '' }, { name: 'request-body' });
          v.style.minHeight = '220px';
          dbody.append(section(t('secReqBody'), v));
        } else dbody.append(h('div', { class: 'note', html: icon('info') + `<span>${esc(t('noReqBody'))}</span>` }));
      } else if (state.dtab === 'response') {
        dbody.style.display = 'flex';
        dbody.style.flexDirection = 'column';
        const resb = e.fetched || responseBody(e);
        if (resb) {
          if (e.fetched) dbody.append(h('div', { class: 'note warn', html: icon('info') + `<span>${esc(t('refetchedNote'))}</span>` }));
          dbody.append(viewer(resb, { name: splitUrl(e.url).name.replace(/[^\w.-]+/g, '_') || 'response' }));
        } else {
          const why = e.state === 'pending' ? t('respPending') : e.type === 'xmlhttprequest' ? t('respNoHook') : t('respNotCaptured');
          const canFetch = (e.method === 'GET' || e.method === 'HEAD') && e.state !== 'pending';
          dbody.append(h('div', { class: 'empty' }, h('div', null,
            h('div', { class: 'ico', html: icon('eye') }), h('h3', null, t('respNoBodyTitle')), h('p', null, why),
            canFetch ? h('button', { class: 'btn primary', style: { marginTop: '14px' }, html: icon('download') + `<span>${esc(t('fetchBody'))}</span>`, onClick: () => refetch(e) }) : null)));
        }
      } else if (state.dtab === 'timing') {
        const total = d || 0;
        const rows = [];
        const sent = e.tSent ? e.tSent - e.start : 0;
        const wait = e.tHeaders && (e.tSent || e.start) ? e.tHeaders - (e.tSent || e.start) : null;
        const down = e.tEnd && e.tHeaders ? e.tEnd - e.tHeaders : null;
        const bar = (from, len, color) => h('div', { class: 'bar' }, h('i', { style: { left: (total ? (from / total) * 100 : 0) + '%', width: Math.max(0.5, total ? (len / total) * 100 : 0) + '%', background: color } }));
        rows.push([t('tQueue'), bar(0, sent, 'var(--faint)'), fmtMs(sent)]);
        if (wait != null) rows.push([t('tWait'), bar(sent, wait, 'var(--ok)'), fmtMs(wait)]);
        if (down != null) rows.push([t('tDownload'), bar(sent + (wait || 0), down, 'var(--info)'), fmtMs(down)]);
        rows.push([h('b', null, t('tTotal')), h('div'), h('b', null, fmtMs(total))]);
        dbody.append(h('div', { class: 'pad' },
          h('div', { class: 'timing' }, rows.map(([a, b, c]) => [h('div', { class: 'muted' }, a), b, h('div', { class: 'v' }, c)])),
          h('p', { class: 'faint', style: { fontSize: '12px', marginTop: '14px' } }, t('timingNote', { at: fmtClock(e.start) }))));
      } else if (state.dtab === 'code') {
        const r = resolve(entryToSpec(e));
        const gen = { curl: toCurl, fetch: toFetch, python: toPython, httpie: toHttpie };
        const area = h('div');
        const draw = () => { area.textContent = ''; area.append(codeBlock(gen[state.code](r), 'text', true)); };
        const s = seg([{ v: 'curl', label: 'cURL' }, { v: 'fetch', label: 'fetch' }, { v: 'python', label: 'Python' }, { v: 'httpie', label: 'HTTPie' }], state.code, (v) => { state.code = v; draw(); });
        draw();
        dbody.append(h('div', { class: 'viewer' }, h('div', { class: 'vbar' }, s.el, h('span', { class: 'grow' }),
          h('span', { class: 'faint', style: { fontSize: '12px' } }, t('codeNote')),
          copyBtn(() => gen[state.code](r))), area));
      }
    }
    fill();
    dbody.scrollTop = scrollKeep;
  }

  async function refetch(e) {
    const spec = entryToSpec(e);
    const { promise } = send(resolve(spec), { via: 'ext', maxBody: ctx.settings().maxBody * 5 });
    const res = await promise;
    if (!res || !res.ok) { toast(t('sendFailed', { e: (res && res.error) || '' }), 'err'); return; }
    e.fetched = { text: res.body, base64: res.base64, size: res.size, contentType: res.contentType, truncated: res.truncated };
    if (state.sel === e.id) renderDetail(e);
  }

  function saveCurrent() {
    saveDialog(scopes());
  }

  // ---------------------------------------------------------------- kayıt görüntüleme
  const bannerText = h('div', { class: 'grow ellipsis' });
  const banner = h('div', { class: 'recbanner', hidden: true },
    h('span', { class: 'ri', html: icon('archive') }), bannerText,
    h('button', { class: 'btn sm', html: icon('download') + `<span>${esc(t('export'))}</span>`, onClick: () => exportDialog(scopes(), source ? source.rec.name : '') }),
    h('button', { class: 'btn sm primary', html: icon('activity') + `<span>${esc(t('backToLive'))}</span>`, onClick: () => showLive() }));

  function setSource(next) {
    source = next;
    multi = new Set();
    anchor = null;
    select(null);
    const rec = !!source;
    banner.hidden = !rec;
    for (const el of [recBtn, clearBtn, liveSep, preserve, tabSel]) el.hidden = rec;
    liveDot.parentElement.hidden = rec;
    if (rec) {
      state.tab = 'all';
      bannerText.innerHTML = t('viewingRec', { name: `<b>${esc(source.rec.name)}</b>`, n: source.entries.length, at: esc(new Date(source.rec.createdAt).toLocaleString()) });
    } else state.tab = ctx.lockTab != null ? String(ctx.lockTab) : tabSel.value || 'all';
    refresh();
    body.scrollTop = rec ? 0 : body.scrollHeight;
  }
  const showLive = () => setSource(null);

  // ---------------------------------------------------------------- sekme listesi
  async function loadTabs() {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    tabsMeta = new Map(tabs.map((x) => [x.id, x]));
    if (ctx.lockTab != null) return;
    const cur = state.tab;
    tabSel.textContent = '';
    tabSel.append(h('option', { value: 'all' }, t('allTabs')));
    for (const x of tabs) {
      if (x.id === ctx.ownTabId || !x.url || !/^(https?|file):/.test(x.url)) continue;
      let host = '';
      try { host = new URL(x.url).host; } catch { /* yok say */ }
      tabSel.append(h('option', { value: String(x.id) }, `${(x.title || host).slice(0, 40)}${host ? ' — ' + host : ''}`));
    }
    tabSel.value = [...tabSel.options].some((o) => o.value === cur) ? cur : 'all';
    state.tab = tabSel.value;
  }
  chrome.tabs.onUpdated.addListener(debounce(loadTabs, 400));
  chrome.tabs.onRemoved.addListener(debounce(loadTabs, 400));
  chrome.tabs.onCreated.addListener(debounce(loadTabs, 400));
  loadTabs();

  root.append(toolbar, subbar, panelBox, banner, split);
  renderHead();
  applyLayout();
  syncRec();
  cap.addEventListener('change', () => { if (!source) refresh(); syncRec(); });
  cap.setFilter(state.adv.capture && !advC.empty ? advC : null);
  syncFilterUi();

  // Uygulama bir sekmeden açıldıysa / tekrar çağrıldıysa listeyi o sekmeye odakla.
  function focusTab(tabId, opts = {}) {
    if (ctx.lockTab != null || source || tabId == null) return;
    if (tabId === ctx.ownTabId) return;
    state.tab = String(tabId);
    if ([...tabSel.options].some((o) => o.value === state.tab)) tabSel.value = state.tab;
    refresh();
    const meta = tabsMeta.get(tabId);
    if (meta && !opts.silent) toast(t('focusedTab', { title: (meta.title || splitUrl(meta.url || '').host).slice(0, 60) }));
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'reqlab:focusTab') loadTabs().then(() => focusTab(msg.tabId));
    return false;
  });
  refresh();

  return {
    focusSearch: () => search.focus(),
    focusTab,
    refresh,
    saveCurrent,
    viewRecording: (rec, entries) => setSource({ rec, entries }),
    showLive,
    currentRecording: () => (source ? source.rec.id : null)
  };
}
