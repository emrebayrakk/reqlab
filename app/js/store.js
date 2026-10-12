// chrome.storage.local üzerinde küçük bir depo: okuma, yazma ve değişiklik dinleme.
//  settings     uygulama ayarları
//  collections  [{ id, name, items: [spec] }]
//  history      [{ id, at, spec, status, time, size, error }]  (en yeni başta)
//  envs         [{ id, name, vars: [{ k, v, on }] }]   activeEnv: id
//  rules        [{ id, enabled, name, action, match, pattern, method, ... }]   ruleErrors: { id: hata }
//  drafts       İstemci'de açık sekmeler   live: { until } (sayfalara "pencere açık" sinyali)

export const DEFAULT_SETTINGS = {
  lang: 'auto',
  theme: 'dark',
  hook: true,
  maxBody: 1048576,
  maxEntries: 3000,
  historyLimit: 200,
  wrap: true,
  detailLayout: 'right',
  openMode: 'panel',
  focusSource: true
};

const listeners = new Map();

export async function get(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}

export function set(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
}

export async function patchSettings(p) {
  const s = await getSettings();
  const next = { ...s, ...p };
  await set('settings', next);
  return next;
}

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  for (const [k, c] of Object.entries(ch)) {
    const set = listeners.get(k);
    if (set) for (const fn of set) fn(c.newValue, c.oldValue);
  }
});

// Sıralı güncelleme: oku -> değiştir -> yaz (aynı anahtara art arda yazımlar karışmasın).
let chain = Promise.resolve();
export function update(key, fallback, fn) {
  const p = chain.then(async () => {
    const cur = await get(key, fallback);
    const next = await fn(cur);
    if (next !== undefined) await set(key, next);
    return next === undefined ? cur : next;
  });
  chain = p.catch(() => {});
  return p;
}
