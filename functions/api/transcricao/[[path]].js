// Transcrição guardada por bruto (KV PROJETOS, chave tr:<hash>). O mesmo arquivo transcrito de novo
// devolve as MESMAS palavras — o whisper varia entre rodadas e essa variação mudava cortes de um
// vídeo que já estava bom. GET devolve 404 se não há; PUT grava (uma escrita por bruto novo).
const SEM_CACHE = { 'Cache-Control': 'no-store' };
export async function onRequest({ request, env, params }) {
  if (!env.PROJETOS) return Response.json({ erro: 'sem KV' }, { status: 503, headers: SEM_CACHE });
  const hash = (params.path || [])[0] || '';
  if (!/^[a-f0-9]{16,64}$/.test(hash)) return Response.json({ erro: 'hash' }, { status: 400, headers: SEM_CACHE });
  if (request.method === 'GET') {
    const s = await env.PROJETOS.get(`tr:${hash}`);
    if (!s) return new Response('', { status: 404, headers: SEM_CACHE });
    return new Response(s, { headers: { 'Content-Type': 'application/json', ...SEM_CACHE } });
  }
  if (request.method === 'PUT') { await env.PROJETOS.put(`tr:${hash}`, await request.text()); return Response.json({ ok: true }, { headers: SEM_CACHE }); }
  return Response.json({ erro: 'método' }, { status: 405, headers: SEM_CACHE });
}
