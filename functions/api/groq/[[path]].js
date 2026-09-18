// Repassa /api/groq/* para a Groq com a chave guardada como segredo do projeto (GROQ_KEY).
// O navegador nunca vê a chave. Mesmo contrato do serve.py local.
// O corpo é lido inteiro antes de reenviar: repassar o stream do request para o fetch
// derrubava a conexão no multipart (áudio) sem resposta nenhuma.
export async function onRequestPost({ request, env, params }) {
  if (!env.GROQ_KEY) return Response.json({ erro: 'sem chave da Groq no servidor' }, { status: 503 });
  const rota = (params.path || []).join('/');
  const corpo = await request.arrayBuffer();
  const r = await fetch('https://api.groq.com/openai/v1/' + rota, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GROQ_KEY, 'Content-Type': request.headers.get('content-type') || 'application/octet-stream', 'User-Agent': 'Bancada/1.0' },
    body: corpo,
  });
  const texto = await r.text();
  return new Response(texto, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
}
