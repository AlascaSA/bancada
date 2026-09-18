// Diário das correções da equipe: GET /api/feedback?professor=<p> junta o «feedback» de todos os
// projetos do professor (cada corte desligado com o porquê, cada corte feito à mão) e os «reportes» (erro
// apontado num ponto do vídeo: tipo, texto, trecho transcrito). É daqui que saem as regras novas do planejador
// e os exemplos que entram no prompt da revisão por IA. Cada item leva `fonte`: 'corte' ou 'reporte'.
const SEM_CACHE = { 'Cache-Control': 'no-store' };
const json = (o, status = 200) => Response.json(o, { status, headers: SEM_CACHE });
export async function onRequestGet({ request, env }) {
  if (!env.PROJETOS) return json({ erro: 'sem KV' }, 503);
  const prof = new URL(request.url).searchParams.get('professor') || '';
  if (!/^[a-z]{2,20}$/.test(prof)) return json({ erro: 'professor' }, 400);
  const chaves = [];
  let cursor;
  do {
    const r = await env.PROJETOS.list({ prefix: `p:${prof}:`, cursor });
    for (const k of r.keys) if (k.metadata?.feedback) chaves.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const itens = [];
  for (const chave of chaves.slice(0, 80)) {
    const p = await env.PROJETOS.get(chave, 'json');
    for (const f of p?.feedback || []) itens.push({ fonte: 'corte', projeto: p.id, nome: p.nome, bruto: p.brutos?.[f.clipe]?.nome || '', ...f });
    for (const r of p?.reportes || []) itens.push({ fonte: 'reporte', projeto: p.id, nome: p.nome, bruto: p.brutos?.[r.clipe]?.nome || '', ...r });
  }
  itens.sort((a, b) => (b.quando || 0) - (a.quando || 0));
  return json({ itens });
}
