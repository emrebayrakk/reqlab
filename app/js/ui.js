// Arayüz parçaları: bildirim, pencere, sağ tık menüsü, bölme ayırıcısı, sekme çubuğu.
import { h } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function toast(msg, kind = 'ok') {
  const el = h('div', { class: 'toast ' + kind, html: icon(kind === 'err' ? 'alert' : kind === 'warn' ? 'alert' : 'check') }, h('span', null, msg));
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, kind === 'err' ? 4200 : 2400);
}

// modal({ title, body: Node, wide, actions: [{ label, kind, onClick(close) -> false ise açık kalır }] })
export function modal({ title, body, wide, flush, actions = [], onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const foot = actions.length ? h('footer', null, actions.map((a) => h('button', {
    class: 'btn ' + (a.kind || ''),
    onClick: async () => { const r = a.onClick ? await a.onClick(close) : undefined; if (r !== false) close(); }
  }, a.label))) : null;
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('header', null, h('h2', null, title), h('button', { class: 'btn ghost icon', html: icon('x'), title: t('close'), onClick: close })),
    h('div', { class: 'mbody' + (flush ? ' flush' : '') }, body),
    foot);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  const first = box.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return close;
}

export function prompt(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, style: { width: '100%', height: '34px' } });
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const close = modal({
      title, body: input,
      actions: [{ label: t('cancel'), kind: 'ghost', onClick: () => finish(null) }, { label: t('ok'), kind: 'primary', onClick: () => finish(input.value.trim()) }],
      onClose: () => finish(null)
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value.trim()); close(); } });
  });
}

export function confirm(title, text, danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title, body: h('p', { style: { margin: 0, color: 'var(--muted)' } }, text),
      actions: [{ label: t('cancel'), kind: 'ghost', onClick: () => finish(false) }, { label: t('ok'), kind: danger ? 'danger' : 'primary', onClick: () => finish(true) }],
      onClose: () => finish(false)
    });
  });
}

let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
// menu(e, [{ icon, label, onClick, danger, key } | '-'])
export function menu(x, y, items) {
  closeMenu();
  const el = h('div', { class: 'menu' }, items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', {
    class: it.danger ? 'danger' : '',
    html: (it.icon ? icon(it.icon) : '') + `<span>${it.label}</span>` + (it.key ? `<span class="k">${it.key}</span>` : ''),
    onClick: () => { closeMenu(); it.onClick(); }
  })));
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  openMenu = el;
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

// İki bölme arasında sürüklenebilir ayırıcı. size: ilk bölmenin oranı (0-1) ya da piksel.
export function splitter(split, first, gutter, { vertical = false, key, min = 160, initial = 0.5 } = {}) {
  const saved = key ? Number(localStorage.getItem('split:' + key)) : 0;
  const apply = (ratio) => {
    const r = Math.max(0.1, Math.min(0.9, ratio));
    first.style.flex = `0 0 ${(r * 100).toFixed(2)}%`;
    return r;
  };
  apply(saved || initial);
  // Aynı ayırıcı yeniden kurulursa eski dinleyici kaldırılır.
  if (gutter._onDown) gutter.removeEventListener('mousedown', gutter._onDown);
  gutter._onDown = (e) => {
    e.preventDefault();
    gutter.classList.add('drag');
    const rect = split.getBoundingClientRect();
    const move = (ev) => {
      const total = vertical ? rect.height : rect.width;
      const pos = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      const clamped = Math.max(min, Math.min(total - min, pos));
      const r = apply(clamped / total);
      if (key) localStorage.setItem('split:' + key, String(r));
    };
    const up = () => { gutter.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  gutter.addEventListener('mousedown', gutter._onDown);
}

// Sekme çubuğu: tabs([{ id, label, count }], aktif, onChange) -> { el, set(id), update(list) }
export function tabbar(list, active, onChange, tools) {
  const el = h('div', { class: 'tabs' });
  let cur = active;
  const render = (items) => {
    el.textContent = '';
    for (const it of items) {
      el.append(h('button', { class: 'tab' + (it.id === cur ? ' on' : ''), onClick: () => { cur = it.id; render(items); onChange(it.id); } },
        it.label, it.count != null && it.count !== '' ? h('span', { class: 'count' }, it.count) : null));
    }
    if (tools) el.append(h('div', { class: 'tools' }, tools));
  };
  render(list);
  return { el, set(id) { cur = id; render(list); }, update(items) { list = items; render(items); }, get: () => cur };
}

export function seg(options, value, onChange) {
  const el = h('div', { class: 'seg' });
  const render = () => {
    el.textContent = '';
    for (const o of options) el.append(h('button', { class: o.v === value ? 'on' : '', onClick: () => { value = o.v; render(); onChange(o.v); } }, o.label));
  };
  render();
  return { el, set(v) { value = v; render(); } };
}

export function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}
