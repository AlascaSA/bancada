// Google Drive pela conta do robô (OAuth: mesmo app e refresh token da Dublagem, conta gu.costa.mendes).
// Segredos no Pages: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN.
// Var: DRIVE_PASTA_PRONTOS_ID (para onde o vídeo aprovado vai).
const API = 'https://www.googleapis.com/drive/v3';
export const configurado = env => !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN);

export async function token(env) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`Google OAuth: ${d.error || r.status} ${d.error_description || ''}`.trim());
  return d.access_token;
}
const auth = tok => ({ Authorization: `Bearer ${tok}` });

export async function meta(tok, id) {
  const r = await fetch(`${API}/files/${id}?fields=id,name,size,mimeType,parents,modifiedTime&supportsAllDrives=true`, { headers: auth(tok) });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Repassa o arquivo em streaming, com Range (o <video> e o Mediabunny pedem pedaços).
export async function stream(tok, id, request) {
  const h = { ...auth(tok) };
  const range = request.headers.get('Range');
  if (range) h.Range = range;
  const r = await fetch(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { headers: h });
  if (!r.ok && r.status !== 206) return new Response(await r.text(), { status: r.status });
  const saida = new Headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' });
  for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Last-Modified']) { const v = r.headers.get(k); if (v) saida.set(k, v); }
  return new Response(r.body, { status: r.status, headers: saida });
}

// Move o arquivo de uma pasta para outra (sem reenviar bytes).
export async function mover(tok, id, para, de) {
  const q = new URLSearchParams({ addParents: para, supportsAllDrives: 'true', fields: 'id,name,parents,webViewLink' });
  if (de) q.set('removeParents', de);
  const r = await fetch(`${API}/files/${id}?${q}`, { method: 'PATCH', headers: { ...auth(tok), 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`Drive mover ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// arquivo com este nome na pasta (não lixeira)
export async function porNome(tok, pastaId, nome) {
  const q = `name = '${nome.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${pastaId}' in parents and trashed = false`;
  const r = await fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5`, { headers: auth(tok) });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).files || [];
}
export async function lixeira(tok, id) {
  const r = await fetch(`${API}/files/${id}?supportsAllDrives=true`, { method: 'PATCH', headers: { ...auth(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  if (!r.ok) throw new Error(`Drive lixeira ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
export const link = id => `https://drive.google.com/file/d/${id}/view`;

// Só arquivos da Bancada passam: o token é da conta inteira (escopo drive), então sem isso qualquer id do Drive dela
// seria baixável pelo site. Vale: arquivo cuja pasta é uma das pastas da Bancada (BANCADA_PASTAS = brutos e entrega de
// cada professor) ou uma subpasta direta delas («Em revisão», «proxy»). A decisão fica 1 h no cache do Cloudflare.
export async function daBancada(env, tok, id) {
  const permitidas = new Set(String(env.BANCADA_PASTAS || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!permitidas.size) return false;
  const cache = caches.default, chave = new Request(`https://bancada-cache.invalid/permitido/${id}`);
  const guardado = await cache.match(chave);
  if (guardado) return (await guardado.text()) === '1';
  const pais = async x => { const r = await fetch(`${API}/files/${x}?fields=parents&supportsAllDrives=true`, { headers: auth(tok) }); return r.ok ? (await r.json()).parents || [] : []; };
  const p1 = await pais(id);
  let ok = p1.some(p => permitidas.has(p));
  if (!ok) for (const p of p1) if ((await pais(p)).some(q => permitidas.has(q))) { ok = true; break; }
  await cache.put(chave, new Response(ok ? '1' : '0', { headers: { 'Cache-Control': 'public, max-age=3600' } }));
  return ok;
}
