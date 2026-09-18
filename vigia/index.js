// Vigia da Bancada — Cloudflare Worker com cron (grátis). A cada 5 min olha a pasta de brutos de cada
// professor no Drive e a lista de projetos; se há bruto sem projeto, ou mesa pedindo render novo, dispara
// o robô no GitHub Actions (workflow robo.yml). Não processa vídeo: só decide se vale acordar o robô.
// POST = olhar agora (é o que o botão «Rodar o robô agora» da Bancada chama, via /api/robo); GET = {rodando}.
// Segredos: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, GH_TOKEN.
// Vars (wrangler.toml): BANCADA_SITE, GH_REPO, PROFS (JSON igual ao robo/pastas.json → profs).
const API = 'https://www.googleapis.com/drive/v3';
const UA = { 'User-Agent': 'bancada-vigia' };

async function token(env) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Google OAuth: ${d.error || r.status}`);
  return d.access_token;
}
async function videosNaPasta(tok, pastaId) {
  const q = `'${pastaId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const r = await fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`Drive ${r.status}`);
  return ((await r.json()).files || []).filter(f => /^video\//.test(f.mimeType || '') || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
}
async function roboRodando(env) {
  for (const status of ['in_progress', 'queued']) {
    const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/robo.yml/runs?status=${status}&per_page=1`, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', ...UA } });
    if (r.ok && (await r.json()).total_count > 0) return true;
  }
  return false;
}
async function acordarRobo(env) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/robo.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...UA },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function vigiar(env) {
  const profs = JSON.parse(env.PROFS || '{}'), site = env.BANCADA_SITE.replace(/\/$/, '');
  const motivos = [];
  let tok = null;
  for (const [prof, P] of Object.entries(profs)) {
    const projetos = (await (await fetch(`${site}/api/projetos?professor=${prof}`, { headers: UA })).json()).projetos || [];
    const feitos = new Set(projetos.map(p => p.fluxo?.brutoId).filter(Boolean));
    tok = tok || await token(env);
    const novos = (await videosNaPasta(tok, P.brutos)).filter(v => !feitos.has(v.id));
    if (novos.length) motivos.push(`${prof}: ${novos.length} bruto(s) novo(s) (${novos.map(v => v.name).join(', ').slice(0, 120)})`);
    const rer = projetos.filter(p => p.fluxo?.pedirRender && p.fluxo.etapa !== 'entregue' && !p.fluxo.erro && Date.now() - (p.editadoEm || 0) > 90e3);
    if (rer.length) motivos.push(`${prof}: ${rer.length} mesa(s) para renderizar de novo`);
  }
  if (!motivos.length) return { acordou: false, motivos, rodando: await roboRodando(env) };
  if (await roboRodando(env)) return { acordou: false, motivos, esperando: 'o robô já está rodando' };
  await acordarRobo(env);
  return { acordou: true, motivos };
}

export default {
  async scheduled(ev, env, ctx) { ctx.waitUntil(vigiar(env).then(r => console.log(JSON.stringify(r))).catch(e => console.error('vigia', e.message))); },
  async fetch(req, env) {
    if (req.method === 'POST') { try { return Response.json(await vigiar(env)); } catch (e) { return Response.json({ erro: e.message }, { status: 500 }); } }
    try { return Response.json({ rodando: await roboRodando(env) }); } catch (e) { return Response.json({ erro: e.message }, { status: 500 }); }   // GET: o robô está numa volta?
  },
};
