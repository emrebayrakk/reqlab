// Ayrıntılı filtre: hem listeyi süzer hem de istenirse yakalamaya uygulanır (eşleşmeyen istek hiç kaydedilmez).
// Yakalama sırasında iki aşamada değerlendirilir: istek başlarken (URL, alan adı, yöntem, tür) ve
// istek bitince (durum, süre, boyut, başlık, gövde).
import { h, esc } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { typeGroup, duration, responseSize, requestBody } from './capture.js';

export const EMPTY = {
  include: '', exclude: '', regex: '', domains: '', notDomains: '', header: '', body: '',
  methods: [], types: [], status: [], minTime: '', maxTime: '', minSize: '', maxSize: '',
  onlyBody: false, onlyMock: false, capture: false
};
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const STATUS = ['2xx', '3xx', '4xx', '5xx', 'failed', 'pending'];
export const TYPES = ['xhr', 'doc', 'js', 'css', 'img', 'media', 'font', 'ws', 'other'];

const list = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

export function normalize(f) {
  return { ...EMPTY, ...(f || {}) };
}

// Görünür ölçütlerin sayısı (yakalama anahtarı ve tür çipleri hariç; onlar ayrıca gösterilir).
export function count(f) {
  f = normalize(f);
  let n = 0;
  for (const k of ['include', 'exclude', 'regex', 'domains', 'notDomains', 'header', 'body', 'minTime', 'maxTime', 'minSize', 'maxSize']) if (String(f[k]).trim()) n++;
  for (const k of ['methods', 'status']) if (f[k].length) n++;
  if (f.onlyBody) n++;
  if (f.onlyMock) n++;
  return n;
}

export const isEmpty = (f) => count(f) === 0 && !normalize(f).types.length;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// f -> { pre(e), post(e), all(e), needsBody, empty }
export function compile(f) {
  f = normalize(f);
  const inc = list(f.include);
  const exc = list(f.exclude);
  const doms = list(f.domains);
  const notDoms = list(f.notDomains);
  let re = null;
  if (f.regex.trim()) { try { re = new RegExp(f.regex.trim(), 'i'); } catch { re = /$^/; } }
  const methods = new Set(f.methods);
  const types = new Set(f.types);
  const status = new Set(f.status);
  const minT = num(f.minTime);
  const maxT = num(f.maxTime);
  const minS = num(f.minSize) != null ? num(f.minSize) * 1024 : null;
  const maxS = num(f.maxSize) != null ? num(f.maxSize) * 1024 : null;
  const hdr = f.header.trim().toLowerCase();
  const bodyQ = f.body.trim().toLowerCase();
  const domMatch = (host, d) => host === d || host.endsWith('.' + d) || (d.startsWith('*.') && host.endsWith(d.slice(1)));

  const pre = (e) => {
    const url = e.url.toLowerCase();
    if (inc.length && !inc.some((s) => url.includes(s))) return false;
    if (exc.some((s) => url.includes(s))) return false;
    if (re && !re.test(e.url)) return false;
    if (doms.length || notDoms.length) {
      const host = hostOf(e.url);
      if (doms.length && !doms.some((d) => domMatch(host, d))) return false;
      if (notDoms.some((d) => domMatch(host, d))) return false;
    }
    if (methods.size && !methods.has(e.method)) return false;
    if (types.size && !types.has(typeGroup(e.type))) return false;
    return true;
  };

  const post = (e) => {
    if (status.size) {
      const failed = !!e.error;
      const pending = e.state === 'pending' && !e.status && !failed;
      const grp = e.status ? String(e.status)[0] + 'xx' : '';
      if (!((failed && status.has('failed')) || (pending && status.has('pending')) || (grp && !failed && status.has(grp)))) return false;
    }
    const d = duration(e);
    if (minT != null && !(d != null && d >= minT)) return false;
    if (maxT != null && !(d != null && d <= maxT)) return false;
    const size = responseSize(e);
    if (minS != null && !(size != null && size >= minS)) return false;
    if (maxS != null && !(size != null && size <= maxS)) return false;
    if (hdr) {
      const hs = [...(e.reqHeaders || []), ...(e.resHeaders || [])];
      const hit = hdr.includes(':')
        ? (() => { const [k, ...rest] = hdr.split(':'); const v = rest.join(':').trim(); return hs.some(([a, b]) => a.toLowerCase() === k.trim() && String(b).toLowerCase().includes(v)); })()
        : hs.some(([a, b]) => a.toLowerCase().includes(hdr) || String(b).toLowerCase().includes(hdr));
      if (!hit) return false;
    }
    if (f.onlyMock && e.source !== 'mock') return false;
    const resText = e.hook && e.hook.resBody && !e.hook.resBody.binary ? e.hook.resBody.text || '' : e.fetched && e.fetched.text ? e.fetched.text : '';
    if (f.onlyBody && !resText) return false;
    if (bodyQ) {
      const rb = requestBody(e);
      const reqText = rb ? rb.text || (rb.fields ? rb.fields.map(([k, v]) => k + '=' + v).join('&') : '') : '';
      if (!(resText.toLowerCase().includes(bodyQ) || reqText.toLowerCase().includes(bodyQ))) return false;
    }
    return true;
  };

  return {
    pre, post, all: (e) => pre(e) && post(e),
    needsBody: !!(bodyQ || f.onlyBody),
    empty: isEmpty(f)
  };
}

export const PRESETS = [
  { id: 'api', f: { types: ['xhr'], notDomains: 'google-analytics.com, googletagmanager.com, doubleclick.net, facebook.com, hotjar.com, sentry.io' } },
  { id: 'errors', f: { status: ['4xx', '5xx', 'failed'] } },
  { id: 'slow', f: { minTime: '1000' } },
  { id: 'large', f: { minSize: '100' } },
  { id: 'writes', f: { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] } }
];

// ---------------------------------------------------------------- panel

// filterPanel(değer, onChange) -> { el, set(f) }
export function filterPanel(value, onChange) {
  let f = normalize(value);
  const el = h('div', { class: 'fpanel' });
  const fire = () => onChange(normalize(f));

  const text = (key, label, ph, opts = {}) => {
    const inp = h('input', { class: 'input' + (opts.mono ? ' mono' : ''), value: f[key], placeholder: ph || '', spellcheck: 'false', type: opts.type || 'text', min: opts.min });
    inp.addEventListener('input', () => {
      f[key] = inp.value;
      if (key === 'regex') { let ok = true; try { if (inp.value.trim()) new RegExp(inp.value); } catch { ok = false; } inp.classList.toggle('bad', !ok); }
      fire();
    });
    return h('label', { class: 'ff' }, h('span', null, label), inp);
  };
  const multi = (key, options, labelOf) => {
    const box = h('div', { class: 'chips' });
    const draw = () => {
      box.textContent = '';
      for (const o of options) box.append(h('button', { class: 'chip' + (f[key].includes(o) ? ' on' : ''), onClick: () => {
        f[key] = f[key].includes(o) ? f[key].filter((x) => x !== o) : [...f[key], o];
        draw();
        fire();
      } }, labelOf ? labelOf(o) : o));
    };
    draw();
    return box;
  };
  const check = (key, label) => {
    const inp = h('input', { type: 'checkbox', checked: f[key] });
    inp.addEventListener('change', () => { f[key] = inp.checked; fire(); });
    return h('label', { class: 'check' }, inp, label);
  };

  const render = () => {
    el.textContent = '';
    const capIn = h('input', { type: 'checkbox', checked: f.capture });
    capIn.addEventListener('change', () => { f.capture = capIn.checked; fire(); render(); });
    el.append(
      h('div', { class: 'fgrid' },
        text('include', t('fInclude'), 'api, /v2/, graphql'),
        text('exclude', t('fExclude'), 'analytics, .png, hot-update'),
        text('regex', t('fRegex'), '^https://api\\.example\\.com/(users|orders)', { mono: true }),
        text('domains', t('fDomains'), 'api.example.com, *.myapp.io'),
        text('notDomains', t('fNotDomains'), 'google-analytics.com, sentry.io'),
        text('header', t('fHeader'), 'authorization · content-type: json'),
        text('body', t('fBody'), '"userId": 42 · token'),
        h('div', { class: 'ff range' }, h('span', null, t('fTime')),
          h('div', { class: 'row' }, text('minTime', '', '≥ ms', { type: 'number', min: '0' }).lastChild, h('span', { class: 'faint' }, '–'), text('maxTime', '', '≤ ms', { type: 'number', min: '0' }).lastChild)),
        h('div', { class: 'ff range' }, h('span', null, t('fSize')),
          h('div', { class: 'row' }, text('minSize', '', '≥ kB', { type: 'number', min: '0' }).lastChild, h('span', { class: 'faint' }, '–'), text('maxSize', '', '≤ kB', { type: 'number', min: '0' }).lastChild))),
      h('div', { class: 'frow' }, h('span', { class: 'fl' }, t('fMethods')), multi('methods', METHODS)),
      h('div', { class: 'frow' }, h('span', { class: 'fl' }, t('fStatus')), multi('status', STATUS, (s) => (s === 'failed' ? t('stFailed') : s === 'pending' ? t('stPending') : s))),
      h('div', { class: 'frow' }, h('span', { class: 'fl' }), check('onlyBody', t('fOnlyBody')), check('onlyMock', t('fOnlyMock'))),
      h('div', { class: 'ffoot' },
        h('label', { class: 'capswitch' + (f.capture ? ' on' : '') }, h('span', { class: 'switch' }, capIn, h('span')),
          h('span', null, h('b', null, t('fCapture')), h('small', null, f.capture ? t('fCaptureOn') : t('fCaptureOff')))),
        h('span', { class: 'grow' }),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, t('fPresets')),
        PRESETS.map((p) => h('button', { class: 'btn sm', onClick: () => { f = normalize({ ...p.f, capture: f.capture }); render(); fire(); } }, t('pre_' + p.id))),
        h('button', { class: 'btn sm ghost', html: icon('x') + `<span>${esc(t('fClear'))}</span>`, onClick: () => { f = normalize({ capture: f.capture }); render(); fire(); } })));
  };
  render();
  return { el, set(next) { f = normalize(next); render(); }, get: () => normalize(f) };
}
