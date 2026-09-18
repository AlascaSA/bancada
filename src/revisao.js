// Revisão por IA onde ele "caçou" a frase: cadeia de 3+ refeituras (≤ 20 s entre elas). As regras
// tiram o que se repete igual; o que sobra no meio pode ser tentativa com OUTRAS palavras ("Eu trilhei
// um longo caminho…" → "De lá até aqui eu trilhei…" → "durante todo esse caminho eu passei por…").
// Regra nenhuma vê isso; um leitor vê. As frases do trecho (com pausas, as já removidas marcadas e as
// palavras-chave que cada uma compartilha com as seguintes) vão para o gpt-oss da Groq com a regra do
// editor: cada ideia entra uma vez, na última tomada; ideia cuja última tomada ficou pela metade sai
// inteira. Ele devolve os grupos; o que não é tomada final vira corte "IA: …" (tipo refeitura, o editor
// liga e desliga). Protegidos por estrutura: a primeira e a última frase do trecho, e o pickup (frase
// igual ao fim de uma frase anterior que ficou). Medido: acerta o trecho do AD119 e não mexe no do 4:22.
import { frases, cadeiasDeTentativas } from './cuts.js';
import { encostarPalavras } from './energy.js';

const MODELO = 'openai/gpt-oss-120b';
const FRACAS = new Set('a o as os um uma de do da dos das em no na nos nas por para pra com sem e ou mas que se ao aos à às pelo pela meu seu sua este esse aquele muito mais já ainda eu tu ele ela nós vós eles elas você vocês me te lhe vos minha teu tua nosso quando onde como porque porém então aí até desde após durante entre sobre sob contra é foi são ser vai vou ter tem'.split(' '));
const limpa = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const chaves = texto => new Set(texto.split(/\s+/).map(limpa).filter(t => t.length > 2 && !FRACAS.has(t)));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const SISTEMA = 'Você é um editor de vídeo montando o corte final a partir da transcrição BRUTA de uma gravação de fala única para a câmera. O locutor erra, para, repete e recomeça. A regra do editor: cada IDEIA entra no vídeo uma vez só, na ÚLTIMA tomada; as tentativas anteriores saem. Se a última tomada de uma ideia ficou incompleta, abrupta, ou virou fragmento, a ideia inteira foi abandonada e nada dela entra. '
  + 'IMPORTANTE: tentativas da mesma ideia costumam ter OUTRAS PALAVRAS — uma frase reescrita com o mesmo tema e palavras-chave em comum ("eu trilhei um longo caminho" → "de lá até aqui eu trilhei um longo caminho" → "durante todo esse caminho eu passei por") é a mesma ideia. Um fragmento que repete o começo de uma frase anterior ("de lá") é uma nova tentativa dessa frase. Cada linha traz, entre chaves, as palavras-chave que ela compartilha com linhas seguintes: use isso para agrupar. '
  + 'Frases marcadas [REMOVIDA] já saíram. Frases marcadas [FICA] entram obrigatoriamente. Agrupe TODAS as frases por ideia (frase que não repete nada é uma ideia sozinha, com ela mesma como final). '
  + 'Responda SÓ JSON: {"grupos":[{"ideia":"resumo curto","frases":[ids],"final":id_ou_null}]}';

// frases do trecho (com 1 de contexto antes e a final), marcadas
export function montarPergunta(fr, palavras, cortes, ci, cadeia) {
  const de = cadeia[0].de, ate = cadeia[cadeia.length - 1].ate;
  let i0 = fr.findIndex(f => f.ate > de); if (i0 > 0) i0--;
  let i1 = fr.findIndex(f => f.de >= ate - 0.2); if (i1 < 0) i1 = fr.length - 1;
  i1 = Math.min(fr.length - 1, i1 + 1);   // a tomada que as regras deixaram + 1 de contexto (pode ser fragmento; a IA julga)
  const dentro = fr.slice(i0, i1 + 1);
  const texto = f => palavras.slice(f.ini, f.fim + 1).map(w => w.texto).join(' ');
  const removida = f => cortes.some(k => k.clipe === ci && k.ligado && k.de <= f.de + 0.15 && k.ate >= f.ate - 0.15);
  const linhas = dentro.map((f, i) => {
    const ant = i > 0 ? dentro[i - 1] : null, pausa = ant ? Math.max(0, f.de - ant.ate) : 0;
    const t = texto(f), fica = i === 0 || i === dentro.length - 1;
    const comp = [];
    for (let j = i + 1; j < dentro.length; j++) { const c = [...chaves(t)].filter(x => chaves(texto(dentro[j])).has(x)); if (c.length >= 2) comp.push(`#${j + 1}: ${c.join(', ')}`); }
    return { id: i + 1, f, texto: t, removida: removida(f), fica, linha: `#${i + 1} [${fmt(f.de)}${pausa >= 0.5 ? `, pausa de ${pausa.toFixed(1)} s antes` : ''}]${removida(f) ? ' [REMOVIDA]' : ''}${fica ? ' [FICA]' : ''} ${t}${comp.length ? ` {${comp.join('; ')}}` : ''}` };
  });
  return { sistema: SISTEMA, usuario: linhas.map(l => l.linha).join('\n'), linhas };
}

export async function perguntarGroq({ sistema, usuario }, { base = '/api/groq' } = {}) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODELO, temperature: 0, max_tokens: 4000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }] }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const d = await r.json();
  try { return JSON.parse(d.choices?.[0]?.message?.content || '{}'); } catch { return {}; }
}

// pickup: a frase repete o FIM de uma frase anterior que ficou ("…possibilidade para sua advocacia." → "Para sua
// advocacia."). Só o ÚLTIMO pickup da mesma cauda é protegido; os anteriores são tentativas dele.
const tokens = t => t.split(/\s+/).map(limpa).filter(Boolean);
function ehPickup(l, linhas) {
  const p = tokens(l.texto);
  if (p.length < 2 || p.length > 5) return false;
  const chave = p.join(' ');
  const cauda = o => tokens(o.texto).slice(-p.length).join(' ');
  if (!linhas.some(o => o !== l && !o.removida && o.f.de < l.f.de && cauda(o) === chave && tokens(o.texto).length > p.length)) return false;
  // vem outro pickup da mesma cauda logo depois (≤ 8 s): este não é o último
  return !linhas.some(o => o !== l && !o.removida && o.f.de > l.f.de && o.f.de - l.f.ate <= 8 && cauda(o) === chave);
}
const fechada = l => /[.!?…]["'”’)\]]*$/.test(l.texto.trim());
// tomada que as regras elegeram depois de um casamento FORTE (abertura igual de ≥ 4 palavras): é a tomada final
// daquela ideia — a IA não pode derrubar ("E talvez uma das maiores diferenças…" no 4:22)
// o corte forte pode acabar no COMEÇO da frase ou DENTRO dela (gagueira "O iniciante acredita que precisa ganhar | o
// iniciante acredita que precisa ganhar todas," é uma frase só para o whisper): o que sobra depois dele é a tomada eleita
const eleita = (l, cortes, ci) => cortes.some(k => k.clipe === ci && k.tipo === 'refeitura' && k.ligado && (k.forca || 0) >= 4 && k.ate >= l.f.de - 0.4 && k.ate <= l.f.ate - 0.5) && (fechada(l) || tokens(l.texto).length >= 6);
// o modelo às vezes junta ideias diferentes num grupo só: uma frase só sai por causa do grupo se compartilha
// ≥ 2 palavras-chave com outra frase do grupo (ou é fragmento)
const coerente = (l, grupoIds, porId) => tokens(l.texto).length <= 3 || grupoIds.some(id => id !== l.id && [...chaves(l.texto)].filter(x => chaves(porId.get(id).texto).has(x)).length >= 2);
const numero = x => +String(x).replace(/[^0-9]/g, '');
const fragmento = l => tokens(l.texto).length <= 3 || /(\.\.\.|…)$/.test(l.texto.trim());

// devolve { [ci]: [{deIdx, ateIdx, motivo}] } para o planejador
// regras: texto livre da equipe para este professor («não corta repetição de ênfase»…) — entra no prompt, acima das regras gerais
export async function revisarTentativas(clipes, cortes, { perguntar = perguntarGroq, aoProgredir, regras = '' } = {}) {
  const extras = {};
  const trabalhos = [];
  clipes.forEach((clipe, ci) => {
    if (!clipe.energia || !clipe.palavras?.length) return;
    for (const cadeia of cadeiasDeTentativas(cortes, ci).filter(c => c.length >= 3)) trabalhos.push({ clipe, ci, cadeia });
  });
  let feitos = 0;
  for (const { clipe, ci, cadeia } of trabalhos) {
    const palavras = encostarPalavras(clipe.palavras, clipe.energia);
    const fr = frases(palavras);
    const pergunta = montarPergunta(fr, palavras, cortes, ci, cadeia);
    if (regras.trim()) pergunta.sistema += ` Regras deste professor, dadas pela equipe de edição (valem acima das gerais): ${regras.trim().replace(/\s+/g, ' ')}`;
    let resposta;
    try { resposta = await perguntar(pergunta); } catch (e) { console.warn('revisão', e); feitos++; continue; }
    const porId = new Map(pergunta.linhas.map(l => [l.id, l]));
    const finais = new Set(), emGrupo = new Set(), grupoDe = new Map();
    for (const g of resposta.grupos || []) {
      const ids = (g.frases || []).map(numero).filter(id => porId.has(id)).sort((a, b) => porId.get(a).f.de - porId.get(b).f.de);
      if (!ids.length) continue;
      for (const id of ids) { emGrupo.add(id); grupoDe.set(id, { ids, final: null }); }
      // a regra do editor vale mais que a escolha do modelo: a tomada final é a ÚLTIMA do grupo no tempo.
      // "Ideia abandonada" (final null) só vale se essa última está pela metade: já removida, fragmento,
      // truncada ou sem ponto final — senão ela é a final e fica
      const ultima = porId.get(ids[ids.length - 1]);
      const pelaMetade = ultima.removida || fragmento(ultima) || !fechada(ultima);
      if (!(g.final == null && pelaMetade) && !ultima.removida && !fragmento(ultima)) { finais.add(ultima.id); for (const id of ids) grupoDe.get(id).final = ultima.id; }
    }
    for (const l of pergunta.linhas) {
      if (l.removida || l.fica || finais.has(l.id) || !emGrupo.has(l.id) || ehPickup(l, pergunta.linhas) || eleita(l, cortes, ci)) continue;
      // sai por causa de uma tomada final posterior? então precisa ter a ver com o grupo; ideia abandonada inteira (sem final) sai
      const gr = grupoDe.get(l.id);
      if (gr.final != null && !coerente(l, gr.ids, porId)) continue;
      const prox = fr[fr.indexOf(l.f) + 1];
      (extras[ci] ||= []).push({ deIdx: l.f.ini, ateIdx: prox ? prox.ini : l.f.fim + 1, motivo: `IA: tentativa abandonada «${palavras.slice(l.f.ini, Math.min(l.f.ini + 5, l.f.fim + 1)).map(w => w.texto).join(' ')}»` });
    }
    feitos++;
    aoProgredir?.(feitos, trabalhos.length);
  }
  return extras;
}
