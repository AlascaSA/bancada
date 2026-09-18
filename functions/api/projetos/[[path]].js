// Projetos da Bancada no KV (binding PROJETOS). Só o que a mesa decidiu + transcrição + energia;
// o vídeo nunca sobe. Chaves:
//   p:<professor>:<id>  → JSON do projeto (metadata: nome, editadoEm, editadoPor, duracao, brutos)
//   prev:<id>           → MP4 do loop de prévia (270x480, ~4 s, mudo)
//   capa:<id>           → JPEG do primeiro quadro
// metadata da lista: nome, editadoEm, editadoPor, duracao, brutos, midiaEm, fluxo {etapa, pedirRender, brutoId, saida, link}, feedback (n)
// Plano grátis do KV: 1.000 escritas/dia na conta — o app só grava quando a mesa ficou parada.
import { metadados } from '../drive/[[path]].js';
const SEM_CACHE = { 'Cache-Control': 'no-store' };
const json = (o, status = 200) => Response.json(o, { status, headers: SEM_CACHE });
const ID = /^[a-z0-9]{6,40}$/i, PROF = /^[a-z]{2,20}$/;

export async function onRequest({ request, env, params }) {
  if (!env.PROJETOS) return json({ erro: 'sem KV de projetos' }, 503);
  const kv = env.PROJETOS, partes = params.path || [], m = request.method, url = new URL(request.url);
  if (!partes.length) {
    if (m !== 'GET') return json({ erro: 'método' }, 405);
    const prof = url.searchParams.get('professor') || '';
    if (!PROF.test(prof)) return json({ erro: 'professor' }, 400);
    const lista = [];
    let cursor;
    do {
      const r = await kv.list({ prefix: `p:${prof}:`, cursor });
      for (const k of r.keys) lista.push({ id: k.name.slice(prof.length + 3), ...(k.metadata || {}) });
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    lista.sort((a, b) => (b.editadoEm || 0) - (a.editadoEm || 0));
    return json({ projetos: lista });
  }
  const [id, sub] = partes;
  if (!ID.test(id)) return json({ erro: 'id' }, 400);
  if (sub === 'preview' || sub === 'capa') {
    const chave = `${sub === 'preview' ? 'prev' : 'capa'}:${id}`, tipo = sub === 'preview' ? 'video/mp4' : 'image/jpeg';
    if (m === 'PUT') { await kv.put(chave, await request.arrayBuffer()); return json({ ok: true }); }
    if (m !== 'GET') return json({ erro: 'método' }, 405);
    const b = await kv.get(chave, 'arrayBuffer');
    if (!b) return new Response('', { status: 404, headers: SEM_CACHE });
    return new Response(b, { headers: { 'Content-Type': tipo, 'Cache-Control': 'private, max-age=300' } });
  }
  if (sub) return json({ erro: 'rota' }, 404);
  if (m === 'PUT') {
    const proj = await request.json();
    if (!PROF.test(proj.professor || '')) return json({ erro: 'professor' }, 400);
    proj.id = id; proj.editadoEm = Date.now();
    await kv.put(`p:${proj.professor}:${id}`, JSON.stringify(proj), { metadata: metadados(proj) });
    return json({ ok: true, editadoEm: proj.editadoEm });
  }
  const prof = url.searchParams.get('professor') || '';
  if (!PROF.test(prof)) return json({ erro: 'professor' }, 400);
  if (m === 'GET') {
    const s = await kv.get(`p:${prof}:${id}`);
    if (!s) return json({ erro: 'não existe' }, 404);
    return new Response(s, { headers: { 'Content-Type': 'application/json', ...SEM_CACHE } });
  }
  if (m === 'DELETE') {
    await Promise.all([kv.delete(`p:${prof}:${id}`), kv.delete(`prev:${id}`), kv.delete(`capa:${id}`)]);
    return json({ ok: true });
  }
  return json({ erro: 'método' }, 405);
}
