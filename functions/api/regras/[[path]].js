// Regras do professor, escritas pela equipe («não faz isso», «faz sempre isso»). Entram no prompt da
// revisão por IA e aparecem na mesa. Chave KV: regras:<professor>.
const SEM_CACHE = { 'Cache-Control': 'no-store' };
const json = (o, status = 200) => Response.json(o, { status, headers: SEM_CACHE });
const PROF = /^[a-z]{2,20}$/;
export async function onRequest({ request, env, params }) {
  if (!env.PROJETOS) return json({ erro: 'sem KV' }, 503);
  const [prof] = params.path || [];
  if (!PROF.test(prof || '')) return json({ erro: 'professor' }, 400);
  const chave = `regras:${prof}`;
  if (request.method === 'GET') return json((await env.PROJETOS.get(chave, 'json')) || { texto: '', editadoEm: 0, editadoPor: '' });
  if (request.method === 'PUT') {
    const b = await request.json();
    const d = { texto: String(b.texto || '').slice(0, 4000), editadoEm: Date.now(), editadoPor: String(b.quem || '').slice(0, 40) };
    await env.PROJETOS.put(chave, JSON.stringify(d));
    return json(d);
  }
  return json({ erro: 'método' }, 405);
}
