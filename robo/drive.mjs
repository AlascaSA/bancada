// Drive pela conta do robô (OAuth da Dublagem). Credenciais: GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN no
// ambiente (é assim no GitHub Actions) ou, na falta, ~/.claude/.google/token_dublagem.json + client_secret.json (Mac).
import { readFileSync, createWriteStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE = join(homedir(), '.claude', '.google');
let cache = { tok: '', ate: 0 };

export async function token() {
  if (cache.tok && Date.now() < cache.ate) return cache.tok;
  let cred;
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) cred = { client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN };
  else {
    const t = JSON.parse(readFileSync(join(GOOGLE, 'token_dublagem.json'), 'utf8'));
    const cs = JSON.parse(readFileSync(join(GOOGLE, 'client_secret.json'), 'utf8')).installed;
    cred = { client_id: t.client_id, client_secret: cs.client_secret, refresh_token: t.refresh_token };
  }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...cred, grant_type: 'refresh_token' }) });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Google OAuth: ${d.error || r.status} ${d.error_description || ''}`);
  cache = { tok: d.access_token, ate: Date.now() + 50 * 60e3 };
  return d.access_token;
}
async function chamar(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await token()}`, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Drive ${r.status} ${url.split('?')[0].slice(-40)}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
const q = s => encodeURIComponent(s);

// vídeos numa pasta (não lixeira), do mais antigo para o mais novo
export async function listarVideos(pastaId) {
  const cond = `'${pastaId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const lista = []; let pageToken = '';
  do {
    const d = await (await chamar(`${API}/files?q=${q(cond)}&fields=nextPageToken,files(id,name,size,mimeType,md5Checksum,modifiedTime,createdTime)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`)).json();
    lista.push(...d.files); pageToken = d.nextPageToken || '';
  } while (pageToken);
  // só vídeo (a subpasta «Em revisão» e qualquer documento ficam de fora)
  return lista.filter(f => !/^\./.test(f.name) && (/^video\//.test(f.mimeType || '') || /\.(mp4|mov|m4v|webm)$/i.test(f.name))).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
}
export async function meta(id) { return (await chamar(`${API}/files/${id}?fields=id,name,size,mimeType,parents,trashed&supportsAllDrives=true`)).json(); }
export async function acharOuCriarPasta(nome, paiId) {
  const cond = `name = '${nome.replace(/'/g, "\\'")}' and '${paiId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const d = await (await chamar(`${API}/files?q=${q(cond)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1`)).json();
  if (d.files[0]) return d.files[0].id;
  return (await (await chamar(`${API}/files?supportsAllDrives=true&fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nome, mimeType: 'application/vnd.google-apps.folder', parents: [paiId] }) })).json()).id;
}

// baixa para o disco, retomando de onde parou se já houver parte
export async function baixar(id, destino, tamanho, aoProgredir) {
  let ja = 0; try { ja = statSync(destino).size; } catch {}
  if (tamanho && ja === tamanho) return;
  if (ja > tamanho) ja = 0;
  const h = ja ? { Range: `bytes=${ja}-` } : {};
  const r = await chamar(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { headers: h });
  let lidos = ja;
  const contador = new Transform({ transform(c, e, cb) { lidos += c.length; aoProgredir?.(lidos, tamanho); cb(null, c); } });
  await pipeline(Readable.fromWeb(r.body), contador, createWriteStream(destino, { flags: ja ? 'a' : 'w' }));
  const fim = statSync(destino).size;
  if (tamanho && fim !== tamanho) throw new Error(`download incompleto: ${fim} de ${tamanho}`);
}

// upload retomável em pedaços de 32 MiB; com `existenteId` substitui o conteúdo (mesmo id, mesmo link)
export async function subir(caminho, nome, pastaId, existenteId = null, aoProgredir) {
  const total = statSync(caminho).size, PEDACO = 32 * 1024 * 1024;
  const cab = { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(total) };
  const inicio = existenteId
    ? await chamar(`${UPLOAD}/files/${existenteId}?uploadType=resumable&supportsAllDrives=true`, { method: 'PATCH', headers: cab, body: JSON.stringify({ name: nome }) })
    : await chamar(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, { method: 'POST', headers: cab, body: JSON.stringify({ name: nome, parents: [pastaId] }) });
  const sessao = inicio.headers.get('Location');
  if (!sessao) throw new Error('Drive não abriu sessão de upload');
  const fd = openSync(caminho, 'r');
  try {
    for (let de = 0; de < total; de += PEDACO) {
      const n = Math.min(PEDACO, total - de), buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, de);
      let r;
      for (let tent = 0; ; tent++) {
        r = await fetch(sessao, { method: 'PUT', headers: { 'Content-Length': String(n), 'Content-Range': `bytes ${de}-${de + n - 1}/${total}` }, body: buf });
        if (r.status === 200 || r.status === 201 || r.status === 308) break;
        if (tent >= 4) throw new Error(`upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
        await new Promise(ok => setTimeout(ok, 2000 * (tent + 1)));
      }
      aoProgredir?.(de + n, total);
      if (r.status === 200 || r.status === 201) return (await r.json()).id;
    }
  } finally { closeSync(fd); }
  throw new Error('upload terminou sem resposta final');
}
// Shared Drive: a conta não apaga de vez, só manda para a lixeira
export async function apagar(id) { await chamar(`${API}/files/${id}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }
