// Kurallar: engelle, yönlendir, istek/yanıt başlığı değiştir (tarayıcı ağ kuralları, bütün istek türleri),
// sahte yanıt ve gecikme (sayfa kancası, yalnızca fetch/XHR).
import { h, esc, uid, clone, tryJson, download, pickFile, fileStamp } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast, modal, menu, confirm, switchEl, seg } from './ui.js';
import { kvEditor } from './kv.js';
import * as store from './store.js';

const ACTIONS = [
  { v: 'block', icon: 'ban' },
  { v: 'redirect', icon: 'redirect' },
  { v: 'reqHeaders', icon: 'headers' },
  { v: 'resHeaders', icon: 'headers' },
  { v: 'mock', icon: 'zap' },
  { v: 'delay', icon: 'hourglass' }
];
const MATCHES = ['contains', 'wildcard', 'regex', 'equals'];
const RULE_METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function newRule(p = {}) {
  return {
    id: uid(), enabled: true, name: '', action: 'block', match: 'contains', pattern: '', method: 'ANY',
    redirectUrl: '', headers: [], status: 200, statusText: '', contentType: 'application/json', body: '', delay: 0, ...p
  };
}

// Kanca ile aynı eşleşme mantığı (editördeki "dene" alanı için).
export function ruleMatches(r, method, url) {
  if (r.method && r.method !== 'ANY' && r.method !== method) return false;
  const v = r.pattern || '';
  try {
    if (r.match === 'regex') return new RegExp(v, 'i').test(url);
    if (r.match === 'equals') return url.split('#')[0] === v.split('#')[0];
    if (r.match === 'wildcard') return new RegExp('^' + v.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(url);
  } catch { return false; }
  return url.toLowerCase().includes(v.toLowerCase());
}

function describe(r) {
  const p = r.pattern || '—';
  switch (r.action) {
    case 'redirect': return `${p}  →  ${r.redirectUrl || '?'}`;
    case 'reqHeaders': case 'resHeaders': return `${p}  ·  ${(r.headers || []).filter((x) => x.on !== false && x.k).map((x) => (x.op === 'remove' ? '−' : '+') + x.k).join(', ')}`;
    case 'mock': return `${p}  →  ${r.status || 200} ${r.contentType || ''}${r.delay ? ` · ${r.delay} ms` : ''}`;
    case 'delay': return `${p}  ·  +${r.delay || 0} ms`;
    default: return p;
  }
}

export function mountRules(root, ctx) {
  let rules = [];
  let errors = {};
  const page = h('div', { class: 'grid-page' });
  root.append(
    h('div', { class: 'vtitle' },
      h('div', { class: 'grow' }, h('h1', null, t('navRules')), h('p', null, t('rulesSub'))),
      h('button', { class: 'btn', html: icon('upload') + `<span>${esc(t('import'))}</span>`, onClick: importRules }),
      h('button', { class: 'btn', html: icon('download') + `<span>${esc(t('export'))}</span>`, onClick: () => {
        if (!rules.length) { toast(t('nothingToExport'), 'warn'); return; }
        download(`reqlab-rules-${fileStamp()}.json`, JSON.stringify({ reqlab: 1, rules }, null, 2));
      } }),
      h('button', { class: 'btn primary', html: icon('plus') + `<span>${esc(t('newRule'))}</span>`, onClick: () => edit(newRule()) })),
    page);

  const save = (list) => store.set('rules', list);

  async function importRules() {
    const f = await pickFile('.json');
    if (!f) return;
    const j = tryJson(f.text);
    if (!j.ok || !Array.isArray(j.value.rules)) { toast(t('importFailed', { e: t('unknownFormat') }), 'err'); return; }
    const add = j.value.rules.map((r) => ({ ...newRule(), ...r, id: uid() }));
    await save([...rules, ...add]);
    toast(t('imported', { n: add.length }));
  }

  function presets() {
    const P = [
      { label: t('preCors'), icon: 'globe', make: () => newRule({ name: t('preCors'), action: 'resHeaders', match: 'contains', pattern: '', headers: [
        { k: 'Access-Control-Allow-Origin', v: '*', on: true, op: 'set' }, { k: 'Access-Control-Allow-Methods', v: 'GET, POST, PUT, PATCH, DELETE, OPTIONS', on: true, op: 'set' },
        { k: 'Access-Control-Allow-Headers', v: '*', on: true, op: 'set' }, { k: 'Access-Control-Expose-Headers', v: '*', on: true, op: 'set' }] }) },
      { label: t('preNoCache'), icon: 'refresh', make: () => newRule({ name: t('preNoCache'), action: 'reqHeaders', match: 'contains', pattern: '', headers: [
        { k: 'Cache-Control', v: 'no-cache', on: true, op: 'set' }, { k: 'Pragma', v: 'no-cache', on: true, op: 'set' }] }) },
      { label: t('preSlow'), icon: 'hourglass', make: () => newRule({ name: t('preSlow'), action: 'delay', match: 'contains', pattern: '/api/', delay: 3000 }) },
      { label: t('pre500'), icon: 'alert', make: () => newRule({ name: t('pre500'), action: 'mock', match: 'contains', pattern: '/api/', status: 500, contentType: 'application/json', body: '{\n  "error": "Internal Server Error"\n}' }) },
      { label: t('preTrackers'), icon: 'ban', make: () => newRule({ name: t('preTrackers'), action: 'block', match: 'regex', pattern: '^https?://([^/]*\\.)?(google-analytics\\.com|googletagmanager\\.com|doubleclick\\.net|connect\\.facebook\\.net|hotjar\\.com|clarity\\.ms)/' }) },
      { label: t('preNoCsp'), icon: 'lock', make: () => newRule({ name: t('preNoCsp'), action: 'resHeaders', match: 'contains', pattern: '', headers: [
        { k: 'Content-Security-Policy', v: '', on: true, op: 'remove' }, { k: 'X-Frame-Options', v: '', on: true, op: 'remove' }] }) }
    ];
    return h('div', { class: 'presets' }, P.map((p) => h('button', { class: 'btn', html: icon(p.icon) + `<span>${esc(p.label)}</span>`, onClick: () => edit(p.make()) })));
  }

  function render() {
    page.textContent = '';
    page.append(h('div', { class: 'note', style: { margin: '0 0 14px' }, html: icon('info') + `<span>${esc(t('rulesNote'))}</span>` }));
    page.append(h('div', { style: { marginBottom: '16px' } }, h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' } }, t('presets')), presets()));
    if (!rules.length) {
      page.append(h('div', { class: 'empty', style: { padding: '50px 0' } }, h('div', null,
        h('div', { class: 'ico', html: icon('sliders') }), h('h3', null, t('rulesEmptyTitle')), h('p', null, t('rulesEmptyText')))));
      return;
    }
    const active = rules.filter((r) => r.enabled !== false).length;
    page.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('span', { class: 'muted' }, t('rulesCount', { n: rules.length, a: active })), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onClick: () => save(rules.map((r) => ({ ...r, enabled: active === 0 }))) }, active ? t('disableAll') : t('enableAll'))));
    const list = h('div', { class: 'cards' });
    rules.forEach((r, i) => {
      const a = ACTIONS.find((x) => x.v === r.action) || ACTIONS[0];
      const err = errors[r.id];
      const el = h('div', { class: 'rule' + (r.enabled === false ? ' off' : ''), onClick: () => edit(clone(r)) },
        h('span', { onClick: (ev) => ev.stopPropagation() }, switchEl(r.enabled !== false, (on) => { const next = clone(rules); next[i].enabled = on; save(next); })),
        h('div', { class: 'ricon ra-' + r.action, html: icon(a.icon) }),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'rt' }, r.name || t('act_' + r.action)), r.name ? h('span', { class: 'badge' }, t('act_' + r.action)) : null,
            r.method && r.method !== 'ANY' ? h('span', { class: 'm m-' + r.method }, r.method) : null),
          h('div', { class: 'rp' }, describe(r)),
          err ? h('div', { class: 'rerr' }, t('ruleError', { e: t('rerr_' + err) !== 'rerr_' + err ? t('rerr_' + err) : err })) : null),
        h('div', { class: 'row', style: { gap: '2px' }, onClick: (ev) => ev.stopPropagation() },
          h('button', { class: 'btn ghost sm icon', html: icon('more'), onClick: (ev) => {
            menu(ev.clientX, ev.clientY, [
              { icon: 'edit', label: t('edit'), onClick: () => edit(clone(r)) },
              { icon: 'copy', label: t('duplicate'), onClick: () => { const n = clone(rules); n.splice(i + 1, 0, { ...clone(r), id: uid(), name: (r.name || t('act_' + r.action)) + ' (2)' }); save(n); } },
              i > 0 ? { icon: 'chevR', label: t('moveUp'), onClick: () => { const n = clone(rules); [n[i - 1], n[i]] = [n[i], n[i - 1]]; save(n); } } : null,
              i < rules.length - 1 ? { icon: 'chevD', label: t('moveDown'), onClick: () => { const n = clone(rules); [n[i], n[i + 1]] = [n[i + 1], n[i]]; save(n); } } : null,
              '-',
              { icon: 'trash', label: t('remove'), danger: true, onClick: async () => { if (await confirm(t('removeRule'), r.name || describe(r))) save(rules.filter((x) => x.id !== r.id)); } }
            ]);
          } })));
      list.append(el);
    });
    page.append(list);
  }

  // ---------------------------------------------------------------- düzenleyici
  function edit(rule) {
    const r = { ...newRule(), ...rule };
    const isNew = !rules.some((x) => x.id === r.id);
    const body = h('div');
    const name = h('input', { class: 'input', value: r.name, placeholder: t('ruleNamePh') });
    name.addEventListener('input', () => { r.name = name.value; });
    const actSeg = seg(ACTIONS.map((a) => ({ v: a.v, label: t('act_' + a.v) })), r.action, (v) => { r.action = v; drawAction(); drawTest(); });
    const matchSel = h('select', { class: 'select' }, MATCHES.map((m) => h('option', { value: m, selected: r.match === m }, t('match_' + m))));
    const pattern = h('input', { class: 'input mono', value: r.pattern, placeholder: t('patternPh'), spellcheck: 'false', style: { width: '100%' } });
    const methodSel = h('select', { class: 'select' }, RULE_METHODS.map((m) => h('option', { value: m, selected: r.method === m }, m === 'ANY' ? t('anyMethod') : m)));
    matchSel.addEventListener('change', () => { r.match = matchSel.value; drawTest(); });
    pattern.addEventListener('input', () => { r.pattern = pattern.value; drawTest(); });
    methodSel.addEventListener('change', () => { r.method = methodSel.value; drawTest(); });
    const desc = h('p', { class: 'faint', style: { fontSize: '12px', margin: '6px 0 0' } });
    const actionBox = h('div');
    const testIn = h('input', { class: 'input mono', placeholder: 'https://api.example.com/v1/users?page=2', spellcheck: 'false', style: { flex: 1 } });
    const testOut = h('span', { class: 'badge' });
    const drawTest = () => {
      const u = testIn.value.trim();
      if (!u) { testOut.className = 'badge'; testOut.textContent = t('testIdle'); return; }
      const ok = r.match === 'regex' ? (() => { try { new RegExp(r.pattern); return true; } catch { return false; } })() : true;
      if (!ok) { testOut.className = 'badge err'; testOut.textContent = t('badRegex'); return; }
      const m = ruleMatches({ ...r, method: 'ANY' }, 'GET', u);
      testOut.className = 'badge ' + (m ? 'ok' : 'warn');
      testOut.textContent = m ? t('testMatch') : t('testNoMatch');
    };
    testIn.addEventListener('input', drawTest);

    function drawAction() {
      actionBox.textContent = '';
      desc.textContent = t('actDesc_' + r.action);
      const field = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('span', { class: 'faint', style: { fontSize: '11.5px' } }, hint) : null);
      if (r.action === 'redirect') {
        const to = h('input', { class: 'input mono', value: r.redirectUrl, placeholder: 'https://localhost:3000/api/users', spellcheck: 'false' });
        to.addEventListener('input', () => { r.redirectUrl = to.value; });
        actionBox.append(field(t('redirectTo'), to, t('redirectHint')));
      } else if (r.action === 'reqHeaders' || r.action === 'resHeaders') {
        const ops = [{ v: 'set', label: t('opSet') }, { v: 'remove', label: t('opRemove') }];
        if (r.action === 'resHeaders') ops.push({ v: 'append', label: t('opAppend') });
        const ed = kvEditor({ rows: r.headers, headers: true, ops, keyPh: t('header'), valPh: t('value'), onChange: (rows) => { r.headers = rows; } });
        actionBox.append(ed.el, h('p', { class: 'faint', style: { fontSize: '12px' } }, r.action === 'reqHeaders' ? t('reqHdrRuleHint') : t('resHdrRuleHint')));
      } else if (r.action === 'mock') {
        const status = h('input', { class: 'input', type: 'number', value: r.status, min: '100', max: '599' });
        status.addEventListener('input', () => { r.status = Number(status.value) || 200; });
        const ct = h('input', { class: 'input mono', value: r.contentType, list: 'dl-ct2', spellcheck: 'false' });
        ct.addEventListener('input', () => { r.contentType = ct.value; });
        const delay = h('input', { class: 'input', type: 'number', min: '0', step: '100', value: r.delay || 0 });
        delay.addEventListener('input', () => { r.delay = Number(delay.value) || 0; });
        const ta = h('textarea', { class: 'textarea', rows: 9, spellcheck: 'false', style: { width: '100%' } });
        ta.value = r.body || '';
        const jsonErr = h('span', { class: 'faint', style: { fontSize: '11.5px' } });
        const checkJson = () => {
          if (!/json/i.test(r.contentType) || !ta.value.trim()) { jsonErr.textContent = ''; return; }
          const j = tryJson(ta.value);
          jsonErr.textContent = j.ok ? '' : t('jsonInvalid', { e: j.error });
          jsonErr.style.color = j.ok ? '' : 'var(--err)';
        };
        ta.addEventListener('input', () => { r.body = ta.value; checkJson(); });
        checkJson();
        const hdrs = kvEditor({ rows: r.headers, headers: true, keyPh: t('header'), valPh: t('value'), onChange: (rows) => { r.headers = rows; }, title: t('respHeaders') });
        actionBox.append(
          h('div', { class: 'field-row' }, field(t('statusCode'), status), field('Content-Type', ct)),
          h('datalist', { id: 'dl-ct2' }, ['application/json', 'text/plain', 'text/html', 'application/xml', 'text/csv'].map((c) => h('option', { value: c }))),
          field(t('respBody'), ta), jsonErr,
          h('div', { class: 'field-row', style: { marginTop: '12px' } }, field(t('delayMs'), delay), h('div')),
          hdrs.el);
      } else if (r.action === 'delay') {
        const delay = h('input', { class: 'input', type: 'number', min: '0', step: '100', value: r.delay || 1000 });
        r.delay = r.delay || 1000;
        delay.addEventListener('input', () => { r.delay = Number(delay.value) || 0; });
        actionBox.append(field(t('delayMs'), delay, t('delayHint')));
      }
    }
    drawAction();
    drawTest();

    body.append(
      h('div', { class: 'field' }, h('label', null, t('ruleName')), name),
      h('div', { class: 'field' }, h('label', null, t('ruleAction')), h('div', null, actSeg.el), desc),
      h('div', { class: 'field' }, h('label', null, t('ruleMatch')),
        h('div', { class: 'row' }, matchSel, h('div', { class: 'grow' }, pattern), methodSel),
        h('span', { class: 'faint', style: { fontSize: '11.5px' } }, t('patternHint'))),
      h('div', { class: 'field' }, h('label', null, t('testUrl')), h('div', { class: 'row' }, testIn, testOut)),
      h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '4px 0 14px' } }),
      actionBox);

    modal({
      title: isNew ? t('newRule') : t('editRule'), wide: true, body,
      actions: [{ label: t('cancel'), kind: 'ghost' }, {
        label: isNew ? t('createRule') : t('save'), kind: 'primary', onClick: async () => {
          if (!r.pattern.trim() && !['reqHeaders', 'resHeaders'].includes(r.action)) { toast(t('needPattern'), 'warn'); return false; }
          if (r.match === 'regex') { try { new RegExp(r.pattern); } catch { toast(t('badRegex'), 'err'); return false; } }
          if (r.action === 'redirect' && !r.redirectUrl.trim()) { toast(t('needRedirect'), 'warn'); return false; }
          // Başlık kurallarında boş desen "her şey" demektir.
          if (!r.pattern.trim()) { r.pattern = '*'; r.match = 'wildcard'; }
          const next = clone(rules);
          const i = next.findIndex((x) => x.id === r.id);
          if (i >= 0) next[i] = r; else next.push(r);
          await save(next);
          toast(isNew ? t('ruleCreated') : t('saved'));
          ctx.showRules && ctx.showRules();
        }
      }]
    });
  }

  store.on('rules', (v) => { rules = v || []; render(); });
  store.on('ruleErrors', (v) => { errors = v || {}; render(); });
  (async () => {
    rules = await store.get('rules', []);
    errors = await store.get('ruleErrors', {});
    render();
  })();
  return { edit: (partial) => edit(newRule(partial)) };
}
