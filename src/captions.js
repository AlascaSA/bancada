// Legendas: palavras → cues por programação dinâmica, com o custo de quebra
// portado do legenda-nativa/remontar.py (pausa, pontuação, gramática, colados).

import { encostarPalavras } from './energy.js';

const AVANCO = {};
for (const c of "iljI|!.,:;'’") AVANCO[c] = 280;
for (const c of 'ftr()[]-') AVANCO[c] = 350;
for (const c of 'mwMW@') AVANCO[c] = 880;
for (const c of 'ABCDEFGHJKLNOPQRSTUVXYZ') AVANCO[c] = 700;
AVANCO[' '] = 280;

export function larguraVisual(texto) {
  let s = 0;
  for (const c of texto) s += AVANCO[c] ?? 580;
  return s / 1000;
}

const FIM_FRASE = /[.!?…]["'”’)\]]*$/;
export const fimDeFrase = p => FIM_FRASE.test(p.trim());

const FRACAS = new Set(('a o as os um uma de do da dos das em no na nos nas por para pra com sem e ou mas que se ao aos à às pelo pela ' +
  'meu seu sua este esse aquele muito mais já ainda eu tu ele ela nós vós eles elas você vocês me te lhe vos minha teu tua nosso ' +
  'quando onde como porque porém então aí até desde após durante entre sobre sob contra perante mediante conforme segundo salvo ' +
  'exceto apenas só talvez sempre nunca quase cada todo toda').split(' '));
// 'se' NÃO entra: na transcrição do whisper o clítico vem colado com hífen (transformou-se);
// o 'se' solto é quase sempre conjunção ("ver se tem alguém") e quebrar antes dele é bom.
const OBLIQUOS = new Set(['me', 'te', 'lhe', 'nos', 'vos', 'lo', 'la', 'los', 'las']);
const NAO_INICIA = new Set('sua suas seu seus meu meus minha minhas dele dela deles delas nosso nossa mesmo mesma próprio própria algum alguma nenhum nenhuma'.split(' '));
const COLADOS = new Set(['processo civil', 'código de', 'direito civil', 'ação de', 'recurso especial', 'agravo de', 'embargos de',
  'juizado especial', 'boa fé', 'coisa julgada', 'livre convencimento', 'meio ambiente', 'união estável', 'regime de', 'de cujus']);
// 'se' e 'que' abrem oração subordinada: "deixa eu ver | se tem alguém" lê melhor que "ver se tem | alguém"
const ABRE_ORACAO = new Set('como quando onde porque porquê pois portanto então mas porém contudo todavia entretanto ou agora aí até inclusive aliás ainda sempre nunca talvez se que'.split(' '));
const PAUSA_LONGA = 0.45;

const limpa = p => p.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function custo(ant, prox, pausa) {
  const a = limpa(ant), b = limpa(prox);
  if (OBLIQUOS.has(b)) return 900;
  if (NAO_INICIA.has(b)) return 850;
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && !nb) return 800;
  if (nb && !na) return 750;
  if (COLADOS.has(a + ' ' + b)) return 700;
  let c;
  if (fimDeFrase(ant)) c = 0;
  else if (ABRE_ORACAO.has(b) && !FRACAS.has(a)) c = 15;
  else if (/[,;:]["'”’)\]]*$/.test(ant.trim())) c = 25;
  else if (FRACAS.has(a)) c = 220;
  else c = 90;
  if (FRACAS.has(a)) return c;
  if (pausa >= PAUSA_LONGA) c = Math.min(c, 5);
  else if (pausa >= 0.22) c = Math.round(c * 0.45);
  return c;
}

// palavras: [{texto, de, ate}] de UM trecho contínuo. Devolve grupos [ini, fim).
export function agrupar(palavras, { larguraEm = 14, durMin = 0.7, durMax = 5.0 } = {}) {
  const n = palavras.length;
  const melhor = new Float64Array(n + 1).fill(Infinity);
  const ant = new Int32Array(n + 1).fill(-1);
  melhor[0] = 0;
  for (let j = 1; j <= n; j++) {
    let texto = '';
    for (let i = j - 1; i >= 0; i--) {
      texto = i === j - 1 ? palavras[i].texto : palavras[i].texto + ' ' + texto;
      if (i < j - 1 && larguraVisual(texto) > larguraEm) break;
      const dur = palavras[j - 1].ate - palavras[i].de;
      if (i < j - 1 && dur > durMax) break;
      let c = melhor[i];
      if (j < n) c += custo(palavras[j - 1].texto, palavras[j].texto, palavras[j].de - palavras[j - 1].ate);
      // cue curta: pena proporcional ao que falta (0,46 s → +31; 0,2 s → +64). Fixa em 60 fazia "que é aprender" perder para "processo." órfão
      if (dur < durMin && j < n && !fimDeFrase(palavras[j - 1].texto)) c += Math.round(90 * (durMin - dur) / durMin);
      // frase que termina no MEIO da legenda ("Vamos trabalhar. Deixa"): o estilo dele fecha a cue no ponto
      for (let k = i; k < j - 1; k++) if (fimDeFrase(palavras[k].texto)) c += 120;
      if (j - i === 1 && FRACAS.has(limpa(palavras[i].texto))) c += 80;
      // palavra sozinha que não é frase inteira ("aqui.") fica órfã: prefere "se tem alguém aqui."
      if (j - i === 1 && !(i === 0 || fimDeFrase(palavras[i - 1].texto))) c += 40;
      if (c < melhor[j]) { melhor[j] = c; ant[j] = i; }
    }
  }
  const grupos = [];
  for (let j = n; j > 0; j = ant[j]) grupos.unshift([ant[j], j]);
  return grupos;
}

// Monta as cues de todos os segmentos, já no tempo de saída.
export function legendar(clipes, segmentos, preset) {
  const L = preset.legenda;
  const cues = [];
  const encostadas = new Map();   // por clipe, uma vez: palavras encostadas no som (o whisper cola o silêncio nelas)
  for (const seg of segmentos) {
    if (!encostadas.has(seg.clipe)) encostadas.set(seg.clipe, encostarPalavras(clipes[seg.clipe].palavras || [], clipes[seg.clipe].energia));
    const todas = encostadas.get(seg.clipe);
    // palavra entra no trecho se o centro dela cai dentro
    const dentro = todas.filter(w => (w.de + w.ate) / 2 >= seg.de && (w.de + w.ate) / 2 < seg.ate);
    if (!dentro.length) continue;
    const grupos = agrupar(dentro, { larguraEm: L.larguraEm });
    const mapa = t => seg.saidaDe + (Math.min(Math.max(t, seg.de), seg.ate) - seg.de);
    const E = clipes[seg.clipe].energia;
    let locais = grupos.map(([i, j]) => {
      const a = dentro[i], b = dentro[j - 1];
      // o relógio do whisper escorrega; o áudio diz onde a palavra começa e onde a última cala.
      // O onset nunca recua para antes do fim da palavra anterior (senão duas cues nascem juntas).
      const anterior = i > 0 ? dentro[i - 1].ate : -1;
      let de = E ? (E.onset(a.de, 0.25, 0.12) ?? a.de) : a.de;
      if (de < anterior) de = Math.max(anterior, a.de - 0.05);
      const fim = E ? (E.comecaSilencio(Math.max(0, b.ate - 0.08)) ?? b.ate) : b.ate;
      return { texto: dentro.slice(i, j).map(w => w.texto).join(' '), de: mapa(de - 0.04), ate: mapa(Math.max(fim, b.ate - 0.15) + 0.12), segmento: seg };
    });
    for (let k = 0; k < locais.length; k++) {
      const c = locais[k], ant = locais[k - 1], prox = locais[k + 1];
      if (ant && c.de < ant.ate + 0.02) c.de = ant.ate + 0.02;           // nunca começa antes da anterior acabar
      if (prox && c.ate > prox.de - 0.02) c.ate = prox.de - 0.02;
      if (c.ate - c.de < 0.3) c.ate = Math.min(c.de + 0.3, seg.saidaAte);
    }
    cues.push(...locais);
  }
  cues.forEach((c, i) => { c.id = i + 1; c.editada = false; });
  return cues;
}

// Onde a legenda vai na tela, em frações da saída: o padrão do professor, mais o deslocamento
// do bloco (todas juntas), mais o deslocamento próprio da legenda (só esta), se houver.
export const SEM_AJUSTE = Object.freeze({ dx: 0, dy: 0 });
export function posicaoLegenda(cue, L, bloco = SEM_AJUSTE) {
  const d = cue?.desloc || SEM_AJUSTE;
  return { x: (L.x ?? 0.5) + bloco.dx + d.dx, y: L.y + bloco.dy + d.dy };
}

// Estilo com destaque (template "Million" do Pablo): a última palavra vai para a linha de baixo em
// negrito; se ela é fraca ("de", "que"), a anterior desce junto. Devolve [linha1, linha2] ou [texto].
export function separarDestaque(texto) {
  const p = texto.trim().split(/\s+/).filter(Boolean);
  if (p.length < 2) return [p.join(' ')];
  let k = p.length - 1;
  if (FRACAS.has(limpa(p[k])) && k >= 2) k--;
  return [p.slice(0, k).join(' '), p.slice(k).join(' ')];
}

export function cueEm(cues, t) {
  for (const c of cues) if (t >= c.de && t < c.ate) return c;
  return null;
}
