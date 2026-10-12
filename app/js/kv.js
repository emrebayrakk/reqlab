// Anahtar/değer tablosu (parametreler, başlıklar, form alanları, ortam değişkenleri).
// Son satır her zaman boştur; yazınca yeni satır açılır. "Toplu düzenle" ile "anahtar: değer" metni olarak düzenlenir.
import { h } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const HEADER_NAMES = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-Match', 'If-None-Match',
  'If-Modified-Since', 'Origin', 'Pragma', 'Range', 'Referer', 'User-Agent', 'X-Requested-With', 'X-Api-Key', 'X-CSRF-Token',
  'Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Credentials',
  'Content-Security-Policy', 'Set-Cookie', 'X-Frame-Options'];

function headerList() {
  let dl = document.getElementById('dl-headers');
  if (!dl) {
    dl = h('datalist', { id: 'dl-headers' }, HEADER_NAMES.map((n) => h('option', { value: n })));
    document.body.append(dl);
  }
  return 'dl-headers';
}

export function kvEditor({ rows = [], onChange, keyPh, valPh, ops, headers, warn, bulk = true, title } = {}) {
  let data = rows.map((r) => ({ k: r.k || '', v: r.v ?? '', on: r.on !== false, ...(ops ? { op: r.op || ops[0].v } : {}) }));
  let bulkMode = false;
  const el = h('div');
  const box = h('div', { class: 'kvbox' });
  const fire = () => onChange && onChange(data.filter((r) => r.k || r.v));
  const dl = headers ? headerList() : null;

  const ta = h('textarea', { class: 'textarea', rows: 8, style: { width: '100%', border: 0, borderRadius: 0, minHeight: '160px' }, spellcheck: 'false' });
  ta.addEventListener('input', () => {
    data = ta.value.split('\n').map((line) => {
      const off = line.startsWith('//');
      const l = off ? line.slice(2) : line;
      const i = l.indexOf(':');
      return { k: (i < 0 ? l : l.slice(0, i)).trim(), v: i < 0 ? '' : l.slice(i + 1).trim(), on: !off, ...(ops ? { op: ops[0].v } : {}) };
    }).filter((r) => r.k || r.v);
    fire();
  });

  const renderTable = () => {
    box.textContent = '';
    if (bulkMode) {
      ta.value = data.filter((r) => r.k || r.v).map((r) => (r.on ? '' : '//') + r.k + ': ' + r.v).join('\n');
      box.append(ta);
      return;
    }
    const tbody = h('tbody');
    const all = [...data, { k: '', v: '', on: true, ghost: true, ...(ops ? { op: ops[0].v } : {}) }];
    all.forEach((r, i) => {
      const row = h('tr', { class: (r.on ? '' : 'off') + (r.ghost ? ' ghost' : '') });
      const cb = h('input', { type: 'checkbox', checked: r.on, disabled: r.ghost });
      cb.addEventListener('change', () => { data[i].on = cb.checked; row.classList.toggle('off', !cb.checked); fire(); });
      const k = h('input', { type: 'text', value: r.k, placeholder: keyPh || t('key'), spellcheck: 'false', list: dl || null });
      const v = h('input', { type: 'text', value: r.v, placeholder: valPh || t('value'), spellcheck: 'false' });
      const mark = h('span', { class: 'warnmark' });
      const updWarn = () => { const w = warn && warn(k.value); mark.textContent = w ? '⚑' : ''; mark.title = w || ''; };
      updWarn();
      const onInput = () => {
        if (r.ghost) {
          r.ghost = false;
          data.push({ k: k.value, v: v.value, on: true, ...(ops ? { op: ops[0].v } : {}) });
          const focusKey = document.activeElement === k;
          renderTable();
          const inputs = box.querySelectorAll('tbody tr')[data.length - 1].querySelectorAll('input[type=text]');
          const target = inputs[focusKey ? 0 : 1];
          target.focus();
          target.setSelectionRange(target.value.length, target.value.length);
          fire();
          return;
        }
        data[i].k = k.value;
        data[i].v = v.value;
        updWarn();
        fire();
      };
      k.addEventListener('input', onInput);
      v.addEventListener('input', onInput);
      const cells = [h('td', { class: 'c' }, cb), h('td', null, h('div', { class: 'row', style: { gap: 0 } }, k, mark))];
      if (ops) {
        const sel = h('select', null, ops.map((o) => h('option', { value: o.v, selected: o.v === r.op }, o.label)));
        sel.disabled = !!r.ghost;
        sel.addEventListener('change', () => { data[i].op = sel.value; v.disabled = sel.value === 'remove'; fire(); });
        v.disabled = r.op === 'remove';
        cells.push(h('td', { class: 'op' }, sel));
      }
      cells.push(h('td', null, v));
      cells.push(h('td', { class: 'x' }, r.ghost ? '' : h('button', {
        class: 'btn ghost sm icon del', html: icon('x'), title: t('remove'),
        onClick: () => { data.splice(i, 1); renderTable(); fire(); }
      })));
      row.append(...cells);
      tbody.append(row);
    });
    box.append(h('table', { class: 'kv' },
      h('thead', null, h('tr', null, h('th'), h('th', null, keyPh || t('key')), ops ? h('th', null, t('operation')) : null, h('th', null, valPh || t('value')), h('th'))),
      tbody));
  };

  const bulkBtn = bulk ? h('button', { class: 'btn ghost sm', onClick: () => { bulkMode = !bulkMode; bulkBtn.textContent = bulkMode ? t('tableEdit') : t('bulkEdit'); renderTable(); } }, t('bulkEdit')) : null;
  el.append(h('div', { class: 'kvbar' }, title ? h('b', { style: { color: 'var(--text)' } }, title) : null, h('span', { class: 'grow' }), bulkBtn), box);
  renderTable();
  return {
    el,
    get: () => data.filter((r) => r.k || r.v).map((r) => ({ ...r })),
    set(next) { data = (next || []).map((r) => ({ k: r.k || '', v: r.v ?? '', on: r.on !== false, ...(ops ? { op: r.op || ops[0].v } : {}) })); renderTable(); }
  };
}
