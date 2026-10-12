// Çözümlenmiş istekten (method, url, headers [[k, v]], body { type, text, fields }) kod üretir; cURL'ü geri okur.

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const hasBody = (r) => r.body && r.body.type && r.body.type !== 'none' && !['GET', 'HEAD'].includes(r.method);

export function toCurl(r) {
  const parts = ['curl'];
  if (r.method !== 'GET' || (hasBody(r) && r.method === 'GET')) parts.push('-X ' + r.method);
  parts.push(sq(r.url));
  for (const [k, v] of r.headers || []) parts.push('-H ' + sq(`${k}: ${v}`));
  if (hasBody(r)) {
    if (r.body.type === 'multipart') for (const [k, v] of r.body.fields || []) parts.push('-F ' + sq(`${k}=${v}`));
    else if (r.body.type === 'form') parts.push('--data ' + sq(new URLSearchParams(r.body.fields || []).toString()));
    else if (r.body.text) parts.push('--data-raw ' + sq(r.body.text));
  }
  return parts.join(' \\\n  ');
}

export function toFetch(r) {
  const opts = [`  method: ${JSON.stringify(r.method)}`];
  const hs = (r.headers || []).filter(([k]) => !(r.body && r.body.type === 'multipart' && /^content-type$/i.test(k)));
  if (hs.length) opts.push('  headers: {\n' + hs.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n  }');
  let pre = '';
  if (hasBody(r)) {
    if (r.body.type === 'multipart') {
      pre = 'const form = new FormData();\n' + (r.body.fields || []).map(([k, v]) => `form.append(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n\n';
      opts.push('  body: form');
    } else if (r.body.type === 'form') opts.push(`  body: new URLSearchParams(${JSON.stringify(r.body.fields || [])})`);
    else opts.push(`  body: ${JSON.stringify(r.body.text || '')}`);
  }
  opts.push('  credentials: "include"');
  return `${pre}const res = await fetch(${JSON.stringify(r.url)}, {\n${opts.join(',\n')}\n});\nconst data = await res.text();\nconsole.log(res.status, data);`;
}

export function toPython(r) {
  const py = (s) => JSON.stringify(String(s));
  const lines = ['import requests', ''];
  const hs = (r.headers || []).filter(([k]) => !(r.body && r.body.type === 'multipart' && /^content-type$/i.test(k)));
  lines.push(`url = ${py(r.url)}`);
  if (hs.length) lines.push('headers = {\n' + hs.map(([k, v]) => `    ${py(k)}: ${py(v)}`).join(',\n') + '\n}');
  const args = ['url'];
  if (hs.length) args.push('headers=headers');
  if (hasBody(r)) {
    if (r.body.type === 'multipart') { lines.push('files = {\n' + (r.body.fields || []).map(([k, v]) => `    ${py(k)}: (None, ${py(v)})`).join(',\n') + '\n}'); args.push('files=files'); }
    else if (r.body.type === 'form') { lines.push('data = {\n' + (r.body.fields || []).map(([k, v]) => `    ${py(k)}: ${py(v)}`).join(',\n') + '\n}'); args.push('data=data'); }
    else { lines.push(`data = ${py(r.body.text || '')}`); args.push('data=data.encode("utf-8")'); }
  }
  lines.push('', `response = requests.request(${py(r.method)}, ${args.join(', ')})`, 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

export function toHttpie(r) {
  const parts = ['http', r.method, sq(r.url)];
  for (const [k, v] of r.headers || []) parts.push(sq(`${k}:${v}`));
  let pre = '';
  if (hasBody(r)) {
    if (r.body.type === 'form' || r.body.type === 'multipart') {
      parts.splice(1, 0, r.body.type === 'multipart' ? '--multipart' : '--form');
      for (const [k, v] of r.body.fields || []) parts.push(sq(`${k}=${v}`));
    } else if (r.body.text) pre = `printf '%s' ${sq(r.body.text)} | `;
  }
  return pre + parts.join(' ');
}

// ---------------------------------------------------------------- cURL okuma

function tokenize(src) {
  // Satır devamları: "\" (bash) ve "^" (cmd) satır sonları.
  const s = src.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').trim();
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let tok = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        tok += s.slice(i + 1, j < 0 ? s.length : j);
        i = j < 0 ? s.length : j + 1;
      } else if (c === '$' && s[i + 1] === "'") {
        let j = i + 2;
        let v = '';
        while (j < s.length && s[j] !== "'") {
          if (s[j] === '\\' && j + 1 < s.length) {
            const n = s[j + 1];
            v += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
            j += 2;
          } else v += s[j++];
        }
        tok += v;
        i = j + 1;
      } else if (c === '"') {
        let j = i + 1;
        let v = '';
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && j + 1 < s.length && /["\\$`]/.test(s[j + 1])) { v += s[j + 1]; j += 2; } else v += s[j++];
        }
        tok += v;
        i = j + 1;
      } else if (c === '\\' && i + 1 < s.length) { tok += s[i + 1]; i += 2; }
      else if (c === '^' && i + 1 < s.length) { tok += s[i + 1]; i += 2; }
      else { tok += c; i++; }
    }
    out.push(tok);
  }
  return out;
}

const WITH_VALUE = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '--url', '--json',
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--resolve', '-w', '--write-out', '--cacert', '--cert', '--key', '-T', '--upload-file']);

export function parseCurl(src) {
  const toks = tokenize(src);
  if (!toks.length || !/^curl(\.exe)?$/i.test(toks[0])) throw new Error('notCurl');
  const r = { method: '', url: '', headers: [], data: [], form: [], get: false, json: false };
  for (let i = 1; i < toks.length; i++) {
    let a = toks[i];
    let val = null;
    if (a.startsWith('--') && a.includes('=')) { val = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    else if (/^-[XHdFuAeb]./.test(a)) { val = a.slice(2); a = a.slice(0, 2); }
    const take = () => (val != null ? val : toks[++i] ?? '');
    if (!a.startsWith('-') || a === '-') { if (!r.url) r.url = a; continue; }
    if (!WITH_VALUE.has(a)) {
      if (a === '-G' || a === '--get') r.get = true;
      else if (a === '-I' || a === '--head') r.method = 'HEAD';
      continue;
    }
    const v = take();
    switch (a) {
      case '-X': case '--request': r.method = v.toUpperCase(); break;
      case '-H': case '--header': {
        const j = v.indexOf(':');
        if (j > 0) r.headers.push([v.slice(0, j).trim(), v.slice(j + 1).trim()]);
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii': r.data.push(v); break;
      case '--data-urlencode': {
        const j = v.indexOf('=');
        r.data.push(j < 0 ? encodeURIComponent(v) : v.slice(0, j + 1) + encodeURIComponent(v.slice(j + 1)));
        break;
      }
      case '--json': r.data.push(v); r.json = true; break;
      case '-F': case '--form': case '--form-string': {
        const j = v.indexOf('=');
        r.form.push([j < 0 ? v : v.slice(0, j), j < 0 ? '' : v.slice(j + 1)]);
        break;
      }
      case '-u': case '--user': r.headers.push(['Authorization', 'Basic ' + btoa(unescape(encodeURIComponent(v)))]); break;
      case '-A': case '--user-agent': r.headers.push(['User-Agent', v]); break;
      case '-e': case '--referer': r.headers.push(['Referer', v]); break;
      case '-b': case '--cookie': if (v.includes('=')) r.headers.push(['Cookie', v]); break;
      case '--url': r.url = v; break;
      default: break;
    }
  }
  if (!r.url) throw new Error('noUrl');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(r.url)) r.url = 'http://' + r.url;
  const hasCT = r.headers.some(([k]) => /^content-type$/i.test(k));
  let body = { type: 'none' };
  if (r.get && r.data.length) {
    r.url += (r.url.includes('?') ? '&' : '?') + r.data.join('&');
  } else if (r.form.length) {
    body = { type: 'multipart', fields: r.form };
  } else if (r.data.length) {
    const text = r.data.join('&');
    const ct = (r.headers.find(([k]) => /^content-type$/i.test(k)) || [])[1] || '';
    if (r.json) {
      if (!hasCT) r.headers.push(['Content-Type', 'application/json']);
      if (!r.headers.some(([k]) => /^accept$/i.test(k))) r.headers.push(['Accept', 'application/json']);
    } else if (!hasCT) r.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    body = { type: 'text', text, contentType: ct || (r.json ? 'application/json' : 'application/x-www-form-urlencoded') };
  }
  const method = r.method || (body.type !== 'none' ? 'POST' : 'GET');
  return { method, url: r.url, headers: r.headers, body };
}
