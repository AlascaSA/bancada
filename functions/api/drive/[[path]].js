// Drive para a revisão:
//   GET  /api/drive/arquivo/<id>   → o arquivo em streaming (Range): o vídeo editado no visualizador, o bruto para reabrir a mesa
//   GET  /api/drive/meta/<id>      → nome, tamanho
//   POST /api/drive/entregar       → {professor, id, quem}: move o vídeo aprovado de «Em revisão» para a pasta de entrega (fluxo.entrega.pastaId) e marca o projeto
import { configurado, token, meta, stream, mover, link, porNome, lixeira } from '../../_drive.js';
const SEM_CACHE = { 'Cache-Control': 'no-store' };
const json = (o, status = 200) => Response.json(o, { status, headers: SEM_CACHE });
const DRIVE_ID = /^[A-Za-z0-9_-]{10,80}$/, ID = /^[a-z0-9]{6,40}$/i, PROF = /^[a-z]{2,20}$/;

export async function onRequest({ request, env, params }) {
  if (!configurado(env)) return json({ erro: 'Drive não configurado no servidor' }, 503);
  const [rota, id] = params.path || [], m = request.method;
  if (rota === 'arquivo' || rota === 'meta') {
    if (m !== 'GET' && m !== 'HEAD') return json({ erro: 'método' }, 405);
    if (!DRIVE_ID.test(id || '')) return json({ erro: 'id' }, 400);
    const tok = await token(env);
    if (rota === 'meta') return json(await meta(tok, id));
    return stream(tok, id, request);
  }
  if (rota === 'entregar') {
    if (m !== 'POST') return json({ erro: 'método' }, 405);
    if (!env.PROJETOS) return json({ erro: 'sem KV de projetos' }, 503);
    const { professor, id: pid, quem } = await request.json();
    if (!PROF.test(professor || '') || !ID.test(pid || '')) return json({ erro: 'projeto' }, 400);
    const chave = `p:${professor}:${pid}`;
    const proj = await env.PROJETOS.get(chave, 'json');
    if (!proj) return json({ erro: 'projeto não existe' }, 404);
    const f = proj.fluxo || {};
    if (!f.saida?.driveId) return json({ erro: 'este projeto não tem vídeo editado pelo robô' }, 409);
    if (f.etapa === 'entregue') return json({ ok: true, link: f.link, repetido: true });
    if (f.pedirRender) return json({ erro: 'o robô ainda está renderizando as últimas mudanças' }, 409);
    const destino = f.entrega?.pastaId || env.DRIVE_PASTA_PRONTOS_ID;
    if (!destino) return json({ erro: 'este projeto não tem pasta de entrega' }, 503);
    const tok = await token(env);
    // mesmo nome já entregue antes → o antigo vai para a lixeira (como o Renomeador faz ao substituir)
    for (const velho of await porNome(tok, destino, f.saida.nome)) if (velho.id !== f.saida.driveId) await lixeira(tok, velho.id);
    const r = await mover(tok, f.saida.driveId, destino, f.saida.pastaId || '');
    const agora = Date.now();
    proj.fluxo = { ...f, etapa: 'entregue', aprovadoPor: String(quem || '').slice(0, 40), aprovadoEm: agora, entregueEm: agora, link: r.webViewLink || link(r.id), historico: [...(f.historico || []), { quando: agora, quem: String(quem || '').slice(0, 40), o: 'aprovado e enviado ao Drive' }] };
    proj.editadoEm = agora;
    await env.PROJETOS.put(chave, JSON.stringify(proj), { metadata: metadados(proj) });
    return json({ ok: true, link: proj.fluxo.link });
  }
  return json({ erro: 'rota' }, 404);
}

// o mesmo resumo que /api/projetos grava (a lista lê só o metadata)
export function metadados(proj) {
  const f = proj.fluxo;
  return {
    nome: String(proj.nome || '').slice(0, 80), editadoEm: proj.editadoEm, editadoPor: String(proj.editadoPor || '').slice(0, 40),
    duracao: +proj.duracao || 0, brutos: (proj.brutos || []).length, midiaEm: +proj.midiaEm || 0,
    fluxo: f ? { etapa: f.etapa || 'editor', pedirRender: !!f.pedirRender, brutoId: f.bruto?.driveId || '', saida: !!f.saida?.driveId, link: f.link || '', erro: f.erro ? String(f.erro).slice(0, 200) : '' } : null,
    feedback: (proj.feedback || []).length + (proj.reportes || []).length,
  };
}
