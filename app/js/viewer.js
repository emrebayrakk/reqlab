// Gövde görüntüleyici: renklendirilmiş metin, açılır-kapanır JSON ağacı, ham metin ve önizleme.
import { h, esc, tryJson, guessLang, copyText, download, b64ToBlob, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { toast } from './ui.js';

const HL_LIMIT = 600000;

export function highlightJson(text) {
  if (text.length > HL_LIMIT) return esc(text);
  return esc(text).replace(/(&quot;(?:\\.|(?!&quot;)[^\\])*?&quot;)(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g,
    (m, str, colon, bool, nul, num, punc) => {
      if (str) return colon ? `<span class="tk-key">${str}</span><span class="tk-punc">${colon}</span>` : `<span class="tk-str">${str}</span>`;
      if (bool) return `<span class="tk-bool">${bool}</span>`;
      if (nul) return `<span class="tk-null">${nul}</span>`;
      if (num) return `<span class="tk-num">${num}</span>`;
      return `<span class="tk-punc">${punc}</span>`;
    });
}

export function highlightMarkup(text) {
  if (text.length > HL_LIMIT) return esc(text);
  return esc(text)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-com">$1</span>')
    .replace(/(&lt;\/?)([\w:.-]+)((?:\s+[\w:.-]+(?:=(?:&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|[^\s&]+))?)*)(\s*\/?&gt;)/g, (m, open, tag, attrs, close) =>
      `<span class="tk-punc">${open}</span><span class="tk-tag">${tag}</span>` +
      attrs.replace(/([\w:.-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|[^\s&]+)?/g, '<span class="tk-attr">$1</span><span class="tk-punc">$2</span><span class="tk-str">$3</span>') +
      `<span class="tk-punc">${close}</span>`);
}

export function codeBlock(text, lang, wrap = true) {
  const html = lang === 'json' ? highlightJson(text) : lang === 'html' || lang === 'xml' ? highlightMarkup(text) : esc(text);
  return h('pre', { class: 'code' + (wrap ? '' : ' nowrap'), html });
}

// ---------------------------------------------------------------- JSON ağacı

function scalar(v) {
  if (v === null) return h('span', { class: 'tk-null' }, 'null');
  if (typeof v === 'string') return h('span', { class: 'tk-str v-str' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'tk-num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'tk-bool' }, String(v));
  return h('span', null, String(v));
}

function node(key, v, depth, isIndex) {
  const li = h('li');
  const label = key == null ? null : h('span', null, h('span', { class: isIndex ? 'tk-num' : 'tk-key' }, isIndex ? key : JSON.stringify(key)), h('span', { class: 'tk-punc' }, ': '));
  if (v === null || typeof v !== 'object') {
    li.append(h('span', { class: 'tg' }), label || '', scalar(v));
    return li;
  }
  const arr = Array.isArray(v);
  const keys = arr ? v.map((_, i) => i) : Object.keys(v);
  const open = arr ? '[' : '{';
  const close = arr ? ']' : '}';
  const sum = h('span', { class: 'sum' }, ` ${arr ? t('items', { n: keys.length }) : t('keys', { n: keys.length })} `);
  const tg = h('span', { class: 'tg' }, '▾');
  let built = false;
  const ul = h('ul');
  const build = () => {
    if (built) return;
    built = true;
    const LIMIT = 500;
    for (const k of keys.slice(0, LIMIT)) ul.append(node(k, v[k], depth + 1, arr));
    if (keys.length > LIMIT) ul.append(h('li', { class: 'faint' }, t('moreItems', { n: keys.length - LIMIT })));
  };
  const toggle = () => {
    const closed = li.classList.toggle('closed');
    tg.textContent = closed ? '▸' : '▾';
    if (!closed) build();
  };
  tg.addEventListener('click', toggle);
  sum.addEventListener('click', toggle);
  li.append(tg, label || '', h('span', { class: 'tk-punc' }, open), sum, ul, h('span', { class: 'tk-punc' }, close));
  if (depth >= 2 || keys.length === 0) { li.classList.add('closed'); tg.textContent = keys.length ? '▸' : ''; } else build();
  return li;
}

export function jsonTree(value) {
  const root = h('div', { class: 'tree' }, h('ul', null, node(null, value, 0)));
  return root;
}

function setAll(tree, open) {
  for (const li of tree.querySelectorAll('li')) {
    const tg = li.querySelector(':scope > .tg');
    if (!tg || !tg.textContent) continue;
    if (open === li.classList.contains('closed')) tg.click();
  }
}

// ---------------------------------------------------------------- görüntüleyici

// body: { text, contentType, base64, dataUrl, size, truncated, binary }
export function viewer(body, { name = 'response', emptyText, prefer } = {}) {
  const wrapper = h('div', { class: 'viewer' });
  const text = body && body.text != null ? String(body.text) : '';
  const imgSrc = body && (body.dataUrl || (body.base64 && /^image\//i.test(body.contentType || '') ? `data:${body.contentType.split(';')[0]};base64,${body.base64}` : ''));
  const lang = guessLang(body && body.contentType, text);
  const parsed = lang === 'json' ? tryJson(text) : { ok: false };
  const hasText = !!text && !(body && body.binary && !text.startsWith('['));

  if (!body || (!hasText && !imgSrc && !body.base64)) {
    wrapper.append(h('div', { class: 'empty' }, h('div', null, h('p', null, emptyText || t('noBody')))));
    return wrapper;
  }

  const modes = [];
  if (hasText) modes.push({ v: 'pretty', label: t('vPretty') });
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') modes.push({ v: 'tree', label: t('vTree') });
  if (hasText) modes.push({ v: 'raw', label: t('vRaw') });
  if (imgSrc || lang === 'html') modes.push({ v: 'preview', label: t('vPreview') });
  let mode = prefer && modes.some((m) => m.v === prefer) ? prefer : imgSrc ? 'preview' : modes[0] ? modes[0].v : 'raw';
  let wrap = localStorage.getItem('viewer:wrap') !== '0';

  const bar = h('div', { class: 'vbar' });
  const area = h('div', { class: 'vbody' });
  const treeTools = h('span', { class: 'row' },
    h('button', { class: 'btn ghost sm icon', html: icon('expand'), title: t('expandAll'), onClick: () => { const tr = area.querySelector('.tree'); if (tr) setAll(tr, true); } }),
    h('button', { class: 'btn ghost sm icon', html: icon('collapse'), title: t('collapseAll'), onClick: () => { const tr = area.querySelector('.tree'); if (tr) setAll(tr, false); } }));

  const render = () => {
    area.textContent = '';
    treeTools.hidden = mode !== 'tree';
    wrapBtn.classList.toggle('on', wrap);
    wrapBtn.hidden = mode === 'tree' || mode === 'preview';
    if (mode === 'pretty') area.append(codeBlock(parsed.ok ? JSON.stringify(parsed.value, null, 2) : text, lang, wrap));
    else if (mode === 'raw') area.append(codeBlock(text, 'text', wrap));
    else if (mode === 'tree') area.append(jsonTree(parsed.value));
    else if (mode === 'preview') {
      if (imgSrc) area.append(h('div', { class: 'preview-img' }, h('img', { src: imgSrc, alt: '' })));
      else area.append(h('iframe', { sandbox: '', srcdoc: text }));
    }
  };

  const segEl = h('div', { class: 'seg' });
  const renderSeg = () => {
    segEl.textContent = '';
    for (const m of modes) segEl.append(h('button', { class: m.v === mode ? 'on' : '', onClick: () => { mode = m.v; renderSeg(); render(); } }, m.label));
  };
  const wrapBtn = h('button', { class: 'btn ghost sm icon', html: icon('wrap'), title: t('wrapLines'), onClick: () => { wrap = !wrap; localStorage.setItem('viewer:wrap', wrap ? '1' : '0'); render(); } });
  const info = h('span', { class: 'faint', style: { fontSize: '12px' } },
    [lang !== 'text' ? lang.toUpperCase() : '', body.size != null ? fmtBytes(body.size) : text ? fmtBytes(new Blob([text]).size) : ''].filter(Boolean).join(' · '));
  const ext = { json: 'json', html: 'html', xml: 'xml', js: 'js', css: 'css' }[lang] || 'txt';
  bar.append(...[segEl, treeTools, h('span', { class: 'grow' }), info,
    body.truncated ? h('span', { class: 'badge warn', title: t('truncatedHint') }, t('truncated')) : null,
    wrapBtn,
    hasText ? h('button', { class: 'btn ghost sm icon', html: icon('copy'), title: t('copy'), onClick: async () => { await copyText(parsed.ok && mode !== 'raw' ? JSON.stringify(parsed.value, null, 2) : text); toast(t('copied')); } }) : null,
    h('button', {
      class: 'btn ghost sm icon', html: icon('download'), title: t('save'),
      onClick: () => {
        if (body.base64) download(name, b64ToBlob(body.base64, body.contentType));
        else download(`${name}.${ext}`, text, (body.contentType || 'text/plain').split(';')[0]);
      }
    })].filter(Boolean));
  renderSeg();
  render();
  wrapper.append(bar, area);
  return wrapper;
}
