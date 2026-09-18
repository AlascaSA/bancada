// Plano de corte seco. A fronteira vem do TEXTO (as palavras e onde a frase fecha), o
// milissegundo vem do ÁUDIO (energia) — regra do editor-prproj. Três famílias de corte:
//   pausa      — buraco entre duas palavras com silêncio de verdade;
//   refeitura  — ele errou e recomeçou a frase: sai a primeira tentativa inteira;
//   fala fora da transcrição — buraco entre palavras onde a energia mostra FALA (o whisper
//                engoliu a tentativa errada); sai também, com aviso, para ele conferir.
// Entrada de cada trecho no onset da palavra (depois do respiro), saída onde o áudio silencia.

import { encostarPalavras } from './energy.js';

const FECHA_FRASE = /[.!?…:;]["'”’)\]]*$/;
const TRUNCADA = /(\.\.\.|…)$/;
const JANELA_REFEITURA = 30;   // s: quão longe procurar a frase repetida
let contador = 0;

const CONTRACOES = { pra: 'para', ta: 'esta', to: 'estou', ce: 'voce' };   // o whisper alterna "pra"/"para" entre tomadas
const limpa = s => { const t = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); return CONTRACOES[t] || t; };

export const ROTULO = {
  cabeca: 'cabeça do clipe',
  rabo: 'rabo do clipe',
  pausa: 'pausa',
  'pausa-frase': 'pausa no meio da frase',
  refeitura: 'refeitura (ele recomeçou)',
  'fala-nao-transcrita': 'fala fora da transcrição',
  sobra: 'sobrou entre tentativas · ligue se ele descartou',
  manual: 'corte do editor',
};

function novo(clipe, de, ate, tipo, ligado, motivo) {
  return { id: ++contador, clipe, de, ate, dur: ate - de, tipo, ligado, motivo };
}
// projeto restaurado traz cortes com id: os novos continuam depois deles
export function reservarIds(n) { if (n > contador) contador = n; }
export function corteManual(clipe, de, ate) {
  return novo(clipe, Math.min(de, ate), Math.max(de, ate), 'manual', true);
}

// frases: fecham em pontuação final ou num buraco de fala >= 0,8 s
export function frases(palavras) {
  const out = [];
  let atual = [];
  palavras.forEach((w, k) => {
    atual.push(k);
    const prox = palavras[k + 1];
    // o whisper às vezes não fecha a frase mas escreve a próxima com maiúscula ("…sua advocacia Para você garantir…"): pausa + maiúscula fecha
    const fecha = FECHA_FRASE.test(w.texto) || !prox || prox.de - w.ate >= 0.8 || (prox.de - w.ate >= 0.35 && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(prox.texto));
    if (fecha) { out.push({ ini: atual[0], fim: k, de: palavras[atual[0]].de, ate: w.ate, texto: atual.map(i => palavras[i].texto).join(' ') }); atual = []; }
  });
  return out;
}

// quantas palavras iguais no começo das duas frases
function aberturaComum(a, b, palavras) {
  let n = 0;
  while (a.ini + n <= a.fim && b.ini + n <= b.fim && limpa(palavras[a.ini + n].texto) === limpa(palavras[b.ini + n].texto) && limpa(palavras[a.ini + n].texto)) n++;
  return n;
}

// A refeitura: a MESMA abertura de frase repetida logo depois. Fica a última tentativa.
//  - 5+ palavras iguais: refeitura, sempre (dentro de 30 s);
//  - 4 palavras e a primeira tentativa truncada ("é...", sem fechar) ou dentro de 12 s;
//  - 3 palavras, truncada e dentro de 8 s.
// a abertura (5 palavras) de A reaparece inteira dentro de B: "Eu trilhei um longo caminho, …" →
// "De lá até aqui eu trilhei um longo caminho de acertos e erros." — B é a refeitura de A com outro começo
function aberturaDentro(a, b, palavras, n = 5) {
  if (a.fim - a.ini + 1 < n) return false;
  const chave = palavras.slice(a.ini, a.ini + n).map(w => limpa(w.texto));
  if (chave.some(t => !t)) return false;
  for (let k = b.ini; k + n - 1 <= b.fim; k++) if (chave.every((t, q) => limpa(palavras[k + q].texto) === t)) return true;
  return false;
}
export function refeituras(palavras) {
  const fr = frases(palavras);
  const out = [];
  let i = 0;
  while (i < fr.length) {
    let achou = null, nAchou = 0;
    const nA = fr[i].fim - fr[i].ini + 1;
    const ultima = palavras[fr[i].fim].texto;
    const truncada = TRUNCADA.test(ultima) || !FECHA_FRASE.test(ultima);
    // frase ABANDONADA: o whisper marcou "…" (a fala parou no meio) e ela é curta — "De lá...", "Eu vou te
    // ensinar...", "Durante todo esse caminho, eu passei por..." — sai até o começo da frase seguinte
    if (TRUNCADA.test(ultima) && nA <= 8 && i + 1 < fr.length) {
      out.push({ deIdx: fr[i].ini, ateIdx: fr[i + 1].ini, motivo: `abandonou «${palavras.slice(fr[i].ini, Math.min(fr[i].ini + 4, fr[i].fim + 1)).map(w => w.texto).join(' ')}»` });
      i++;
      continue;
    }
    for (let j = i + 1; j < fr.length && fr[j].de - fr[i].de <= JANELA_REFEITURA; j++) {
      const n = aberturaComum(fr[i], fr[j], palavras);
      const nB = fr[j].fim - fr[j].ini + 1;
      const dist = fr[j].de - fr[i].de;
      // anáfora retórica ("Você vai perder processo. Você vai perder processo se…"): A completa e curta,
      // inteira como abertura de uma B mais longa — não é refeitura
      const retorica = !truncada && n === nA && nB > nA;
      const bate = (n >= 5) || (n >= 4 && (truncada || (dist <= 12 && !retorica))) || (n >= 3 && truncada && dist <= 8) || (n >= 2 && n >= nA && truncada && dist <= 6)
        // a MESMA frase curta inteira, de novo, logo em seguida ("Para sua advocacia." ×3): só a última fica.
        // Só quando as duas são idênticas — "Você vai perder processo. Você vai perder processo se…" é retórica
        || (n >= 3 && n === nA && n === nB && dist <= 8)
        // abertura de A dentro de B só conta como refeitura se ele PAROU antes de B (pausa ≥ 1 s) ou A ficou
        // truncada — "…e mesmo assim perder. Assim como algumas vezes você pode fazer um trabalho…" (0,5 s,
        // paralelismo retórico, 4:22 aos 1:16) não é; "…apenas os acertos. [1,8 s] De lá até aqui eu trilhei…" é
        || (nA >= 5 && dist <= 20 && (truncada || fr[j].de - fr[i].ate >= 1.0) && aberturaDentro(fr[i], fr[j], palavras));
      if (bate) { achou = j; nAchou = n; break; }
    }
    if (achou !== null) { out.push({ deIdx: fr[i].ini, ateIdx: fr[achou].ini, n: nAchou, motivo: `repetiu «${palavras.slice(fr[achou].ini, Math.min(fr[achou].ini + 4, fr[achou].fim + 1)).map(w => w.texto).join(' ')}»` }); i = achou; }
    else i++;
  }
  return out;
}

// Recomeço DENTRO da frase: ele diz "O iniciante acredita que precisa ganhar", para, e repete
// "O iniciante acredita que precisa ganhar todas." sem ponto nem pausa longa no meio — a
// transcrição não fecha frase e `refeituras()` não vê nada. Bloco de ≥ 5 palavras repetido logo em
// seguida (ou ≥ 4 cobrindo quase o bloco todo, ou ≥ 3 sendo o bloco inteiro depois de uma
// respirada) = refeitura da primeira tentativa. Visto no vídeo de 4:22 aos 2:53.
export function repeticoesInternas(palavras) {
  const out = [];
  for (let i = 0; i < palavras.length; i++) {
    let achou = null;
    for (let j = i + 2; j < palavras.length && j - i <= 15; j++) {
      // frase que FECHA no meio do bloco não é recomeço, é paralelismo ("...e perder. Assim como você
      // pode fazer um trabalho ... e ganhar."): isso é assunto de refeituras(), que compara aberturas
      if (FECHA_FRASE.test(palavras[j - 1].texto)) break;
      let n = 0;
      while (j + n < palavras.length && i + n < j && limpa(palavras[i + n].texto) && limpa(palavras[i + n].texto) === limpa(palavras[j + n].texto)) n++;
      const bloco = j - i, pausa = palavras[j].de - palavras[j - 1].ate;
      const bate = n >= 5 || (n >= 4 && n >= bloco - 1) || (n >= 3 && n === bloco && pausa >= 0.25);
      if (bate && palavras[j].de - palavras[i].de <= JANELA_REFEITURA) { achou = j; break; }
    }
    if (achou !== null) { out.push({ deIdx: i, ateIdx: achou, n: 5, motivo: `repetiu «${palavras.slice(achou, achou + 4).map(w => w.texto).join(' ')}»` }); i = achou - 1; }
  }
  return out;
}

// extras: { [clipe]: [{deIdx, ateIdx, motivo}] } — frases que a revisão por IA apontou como tentativas abandonadas
// cadeias de refeituras (≤ 20 s entre uma e a próxima): onde ele estava "caçando" a frase
export function cadeiasDeTentativas(cortes, ci) {
  const ref = cortes.filter(k => k.clipe === ci && k.tipo === 'refeitura' && k.ligado).sort((x, y) => x.de - y.de);
  const cadeias = [];
  for (const k of ref) { const c = cadeias[cadeias.length - 1]; if (c && k.de - c[c.length - 1].ate <= 20) c.push(k); else cadeias.push([k]); }
  return cadeias;
}
export function planejarCortes(clipes, preset, extras = {}) {
  const P = preset.corte;
  const cortes = [], sugestoes = [];
  clipes.forEach((clipe, ci) => {
    const dur = clipe.duracao, E = clipe.energia, palavras = encostarPalavras(clipe.palavras || [], E);
    if (clipe.semFala || !E) return;
    if (!palavras.length) { // sem transcrição: só cabeça e rabo pela energia
      const s = clipe.silencios || [];
      if (s[0] && s[0].de <= 0.25 && s[0].ate - P.respiroEntrada >= 0.1) cortes.push(novo(ci, 0, s[0].ate - P.respiroEntrada, 'cabeca', true));
      const u = s[s.length - 1];
      if (u && u.ate >= dur - 0.25 && dur - (u.de + P.respiroSaida) >= 0.1) cortes.push(novo(ci, u.de + P.respiroSaida, dur, 'rabo', true));
      return;
    }
    // entrada = onset da palavra (última subida de energia antes dela: depois do respiro), saída = onde silencia
    // respiro de entrada só quando há silêncio antes da palavra; com fala colada (tomada que começa sem pausa) o corte cai na fronteira da palavra
    const entrada = w => { const o = E.onset(w.de); const t = o ?? w.de; return Math.max(0, t - (o == null && E.fala(t - 0.13) ? 0.02 : P.respiroEntrada)); };
    const saida = w => { const s = E.comecaSilencio(Math.max(0, w.ate - 0.08)); return Math.min(dur, (s ?? w.ate) + P.respiroSaida); };

    // refeituras primeiro: marcam palavras que saem inteiras
    const fora = new Set();
    const achadas = [...refeituras(palavras), ...repeticoesInternas(palavras), ...(extras[ci] || [])].filter(r => r.ateIdx > r.deIdx && r.ateIdx <= palavras.length && r.deIdx >= 0).sort((a, b) => a.deIdx - b.deIdx);
    for (const r of achadas) {
      // a refeitura sai desde a SAÍDA da última palavra boa: o ar morto antes da tentativa errada
      // (0,83 s depois de "perder." no vídeo de 4:22) não é pausa por si só, mas vai junto com o corte
      const antes = palavras[r.deIdx - 1];
      const deRuim = entrada(palavras[r.deIdx]);
      const de = antes ? Math.min(deRuim, saida(antes)) : deRuim;
      const ate = r.ateIdx < palavras.length ? entrada(palavras[r.ateIdx]) : saida(palavras[r.ateIdx - 1]);
      if (ate - de < 0.3) continue;
      for (let k = r.deIdx; k < r.ateIdx; k++) fora.add(k);
      const c = novo(ci, de, ate, 'refeitura', true, r.motivo); c.forca = r.n || 0;   // força do casamento: a tomada que ficou depois de um casamento forte (≥ 4 palavras de abertura) é tomada final
      cortes.push(c);
    }
    // Pickup: ele regravou o FIM da frase ("…uma nova possibilidade para sua advocacia." e depois "Para sua
    // advocacia." ×3). A ponta regravada entra NO LUGAR da original, senão fica "para sua advocacia. Para
    // sua advocacia." — corte da fronteira da palavra antes da cauda até a entrada do último pickup.
    {
      const fr = frases(palavras);
      const tk = f => palavras.slice(f.ini, f.fim + 1).map(w => limpa(w.texto)).filter(Boolean);
      for (let si = 0; si < fr.length; si++) {
        // a frase pode COMEÇAR numa refeitura já removida (gagueira "talvez você esteja talvez você esteja três…"):
        // o que importa é a cauda dela ter ficado
        const S = fr[si]; if (fora.has(S.fim)) continue;
        const tS = tk(S); if (tS.length < 4) continue;
        // pickup de verdade tem ≥ 2 tomadas da ponta (as anteriores já saíram como refeitura); dita UMA vez é
        // repetição de propósito ("…a minha nova aquisição. [pausa] Minha nova aquisição. Tcharam!") e fica
        let ultimo = null, tomadas = 0;
        for (let q = si + 1; q < fr.length && fr[q].de - S.ate <= 12; q++) {
          const P = fr[q], tP = tk(P);
          if (tP.length < 2 || tP.length > 5 || tP.length >= tS.length) continue;
          if (tS.slice(-tP.length).join(' ') !== tP.join(' ')) continue;
          tomadas++;
          if (!fora.has(P.ini)) ultimo = { P, n: tP.length };
        }
        if (!ultimo || tomadas < 2) continue;
        let idx = S.fim + 1, falta = ultimo.n;
        while (falta > 0 && idx > S.ini) { idx--; if (limpa(palavras[idx].texto)) falta--; }
        const antes = palavras[idx - 1];
        // o corte cai no VALE de energia entre a palavra e a cauda (fala contínua: a fronteira do whisper morde a palavra)
        const de = antes ? E.vale(antes.ate - 0.15, Math.min(palavras[idx].de + 0.1, antes.ate + 0.3)) : Math.max(0, palavras[idx].de - 0.12), ate = entrada(palavras[ultimo.P.ini]);
        if (ate - de < 0.3) continue;
        for (let k = idx; k < ultimo.P.ini; k++) fora.add(k);
        // a legenda do pickup continua a frase: herda o texto da cauda original ("para sua advocacia." e não "Para sua advocacia.")
        const orig = clipe.palavras || [];
        if (ultimo.P.fim - ultimo.P.ini === S.fim - idx) for (let m = 0; m <= S.fim - idx; m++) { if (orig[ultimo.P.ini + m]) orig[ultimo.P.ini + m].texto = palavras[idx + m].texto; palavras[ultimo.P.ini + m].texto = palavras[idx + m].texto; }
        cortes.push(novo(ci, de, ate, 'refeitura', true, `pickup «${palavras.slice(ultimo.P.ini, ultimo.P.fim + 1).map(w => w.texto).join(' ')}» no lugar do fim da frase`));
      }
    }
    // cabeça e rabo
    if (P.cabecaRabo) {
      const primeira = palavras.find((w, k) => !fora.has(k)) || palavras[0];
      const cab = entrada(primeira);
      if (cab >= 0.1) cortes.push(novo(ci, 0, cab, 'cabeca', true));
      const ultima = palavras[palavras.length - 1];
      const rab = saida(ultima);
      if (dur - rab >= 0.1) cortes.push(novo(ci, rab, dur, 'rabo', true));
    }
    // buracos entre palavras vizinhas
    for (let k = 0; k + 1 < palavras.length; k++) {
      // dentro de uma refeitura já removida não há o que cortar; mas a pausa ANTES dela (entre a
      // última palavra boa e a tentativa errada) continua sendo pausa — sem isso sobravam 4 s de
      // silêncio colados na refeitura (visto no vídeo de 4:22)
      if (fora.has(k) && fora.has(k + 1)) continue;
      const a = palavras[k], b = palavras[k + 1];
      if (b.de - a.ate < 0.6) continue;
      const de = saida(a);
      let ate = entrada(b);
      if (ate - de < 0.15) continue;
      // Voz dentro do buraco: ou o whisper engoliu uma tentativa (ilha de fala isolada por silêncio
      // dos dois lados) ou o relógio dele atrasou e a palavra seguinte começa antes do que ele disse
      // (a corrida de fala emenda com a palavra b). No segundo caso só se corrige a entrada.
      const corridas = E.corridas(de, b.de + 0.3);
      let iB = corridas.findIndex(r => r.ate >= b.de - 0.05);
      let bRun = iB >= 0 ? { ...corridas[iB] } : null;
      const forte = r => bRun && E.pico(r.de, r.ate) >= 0.5 * E.pico(bRun.de, bRun.ate);   // respiro é fraco; palavra é forte
      const naCadeia = new Set([iB]);
      // palavra reancorada pela segunda escuta (a Groq, começando no silêncio, a pôs DEPOIS do som):
      // o som antes dela não é ela começando cedo — não emenda
      if (bRun && !b.reancorada) {
        // o relógio do whisper atrasa: corridas FORTES emendadas (< 0,5 s) à palavra b são a própria palavra começando antes
        for (let j = iB - 1; j >= 0; j--) {
          const r = corridas[j];
          if (bRun.de - r.ate < 0.5 && forte(r)) { bRun.de = r.de; naCadeia.add(j); } else break;
        }
        if (bRun.de < b.de - 0.35) ate = Math.max(de + 0.15, bRun.de - P.respiroEntrada);
      }
      const ilhas = corridas.filter((r, j) => !naCadeia.has(j) && r.ate - r.de >= 0.8 && r.de - de >= 0.3 && (bRun ? bRun.de - r.ate >= 0.5 : true) && forte(r));
      // Começo falso: ele abre a frase ("E esse,"), sai um som sem palavra (o whisper não transcreve
      // nem reouvindo), pausa e recomeça de outro jeito. O fragmento curto (≤ 3 palavras desde o fim
      // da frase anterior, sem fechar frase) é a tentativa abortada e sai junto com o som — visto no
      // AD119 aos 0:11 ("E esse, [som] pouco mais de dez anos após").
      // Começo falso GRUDADO na frase anterior ("…de inventários que é onde eu a [pausa] que é a minha área",
      // AD119 aos 1:02): a palavra seguinte foi reancorada depois do silêncio pela escuta limpa, e entre o fim
      // da última palavra e o silêncio sobra voz sem texto (≥ 0,4 s) — a tentativa abortada, colada, sem
      // pausa antes. Sai da fronteira da palavra até a entrada da reancorada.
      // Só quando a escuta limpa MOVEU palavras para depois do silêncio (evidência forte de que o whisper errou a
      // fronteira). Só "reancorada" não basta: "Mas principalmente [0,5 s de voz]" no 4:22 aos 0:45 era a própria
      // palavra esticada — ele desligou o corte
      if (b.reancorada && b.movida && !fora.has(k)) {
        const fimVoz = E.comecaSilencio(Math.max(0, a.ate - 0.02), 2.5);
        if (fimVoz != null && fimVoz - a.ate >= 0.6 && b.de - fimVoz >= 0.25) {
          cortes.push(novo(ci, a.ate + 0.04, ate, 'refeitura', true, `começo falso sem texto antes de «${b.texto}»`));
          continue;
        }
      }
      const vozSemTexto = corridas.some((r, j) => !naCadeia.has(j) && r.ate - r.de >= 0.4 && r.de - de >= 0.2 && (bRun ? bRun.de - r.ate >= 0.3 : true) && forte(r));
      let ini = k;
      while (ini > 0 && !FECHA_FRASE.test(palavras[ini - 1].texto) && !fora.has(ini - 1)) ini--;
      if (vozSemTexto && !FECHA_FRASE.test(a.texto) && k - ini + 1 <= 3 && !fora.has(k)) {
        const deFalso = ini > 0 ? saida(palavras[ini - 1]) : 0;
        cortes.push(novo(ci, Math.min(deFalso, de), ate, 'refeitura', true, `começo falso «${palavras.slice(ini, k + 1).map(w => w.texto).join(' ')}»`));
        continue;
      }
      if (ilhas.length) {
        cortes.push(novo(ci, de, ate, 'fala-nao-transcrita', true, `${(ilhas.reduce((s, r) => s + r.ate - r.de, 0)).toFixed(1)} s de voz sem texto entre «${a.texto}» e «${b.texto}»`));
        continue;
      }
      if (ate - de < P.pausaMinima - 0.32) continue;   // pausa útil (já sem os respiros) menor que o mínimo
      const fechada = FECHA_FRASE.test(a.texto);
      cortes.push(novo(ci, de, ate, fechada ? 'pausa' : 'pausa-frase', true, `${(ate - de + 0.32).toFixed(1)} s`));
    }
    // Trecho de tentativas: 3+ refeituras encadeadas (≤ 20 s entre uma e a próxima) — ele estava
    // "caçando" a frase. O que sobrou ENTRE duas refeituras da cadeia e é curto (≤ 8 palavras) pode ser
    // tentativa também, mas só quem conhece o roteiro sabe ("de lá", "sua advocacia." soltos). Uma IA
    // lendo o texto frio descartou tomadas boas (testado com o gpt-oss no AD119) — então isso entra
    // como corte DESLIGADO: a mesa mostra e o editor liga com um clique.
    const cadeias = cadeiasDeTentativas(cortes, ci);
    const ligados = cortes.filter(k => k.clipe === ci);
    const fr = frases(palavras);
    const textoDe = f => palavras.slice(f.ini, f.fim + 1).map(w => w.texto).join(' ');
    const toks = f => palavras.slice(f.ini, f.fim + 1).map(w => limpa(w.texto)).filter(Boolean);
    // pickup: repete o FIM de uma frase anterior que ficou ("…possibilidade para sua advocacia." → "Para sua advocacia.") — é a regravação da ponta, fica
    const ehPickup = f => { const t = toks(f); return t.length >= 2 && fr.some(o => o !== f && o.ate <= f.de && !ligados.some(k => k.de <= o.de + 0.15 && k.ate >= o.ate - 0.15) && toks(o).length > t.length && toks(o).slice(-t.length).join(' ') === t.join(' ')); };
    for (const cadeia of cadeias.filter(c => c.length >= 3)) {
      // a tomada que sobrou DEPOIS da cadeia: se é um fragmento (≤ 3 palavras) e não é pickup, é o último
      // "Na sua advocacia." de sete iguais — tentativa também, não texto final
      const fimCadeia = cadeia[cadeia.length - 1].ate;
      const depois = fr.find(f => f.de >= fimCadeia - 0.2);
      if (depois && depois.fim - depois.ini + 1 <= 3 && !ehPickup(depois) && !ligados.some(k => k.de <= depois.de + 0.15 && k.ate >= depois.ate - 0.15)) {
        const a = palavras[depois.ini - 1], b = palavras[depois.fim + 1];
        const de = a ? saida(a) : 0, ate = b ? entrada(b) : dur;
        if (ate - de >= 0.3) cortes.push(novo(ci, de, ate, 'refeitura', true, `sobra entre tentativas «${textoDe(depois)}»`));
      }
      for (let q = 0; q + 1 < cadeia.length; q++) {
        const de0 = cadeia[q].ate, ate0 = cadeia[q + 1].de;
        for (const f of fr) {
          const n = f.fim - f.ini + 1;
          // só frases INTEIRAS dentro do vão: uma frase que atravessa um corte da cadeia foi aparada de propósito
          // (gagueira no começo, pickup na cauda) e o que ficou é texto bom
          if (f.de < de0 - 0.2 || f.ate > ate0 + 0.2) continue;
          if (ligados.some(k => k.de <= f.de + 0.15 && k.ate >= f.ate - 0.15)) continue;   // já saiu
          if (ehPickup(f)) continue;
          const a = palavras[f.ini - 1], b = palavras[f.fim + 1];
          const de = a ? saida(a) : 0, ate = b ? entrada(b) : dur;
          if (ate - de < 0.3) continue;
          // Frase de qualquer tamanho: se um fragmento MAIS À FRENTE na cadeia repete o começo dela ("De lá até
          // aqui eu trilhei…" e depois "de lá"), ele tentou refazê-la e desistiu — sai. Fragmento (≤ 3 palavras)
          // ou frase que o whisper não fechou, entre duas refeituras: tentativa — sai. Frase fechada de 4 a 8
          // palavras: só quem conhece o roteiro sabe — entra desligada, o editor liga
          const t = toks(f);
          const reiniciada = fr.some(o => o.de > f.ate && o.de <= cadeia[cadeia.length - 1].ate + 0.2 && toks(o).length >= 2 && toks(o).length <= 3 && t.length > toks(o).length && t.slice(0, toks(o).length).join(' ') === toks(o).join(' '));
          const fragmento = n <= 3 || !FECHA_FRASE.test(palavras[f.fim].texto);
          if (reiniciada) cortes.push(novo(ci, de, ate, 'refeitura', true, `tentou de novo e desistiu «${textoDe(f)}»`));
          else if (n > 8) continue;
          else if (fragmento) cortes.push(novo(ci, de, ate, 'refeitura', true, `sobra entre tentativas «${textoDe(f)}»`));
          else sugestoes.push(novo(ci, de, ate, 'sobra', false, `«${textoDe(f)}»`));
        }
      }
    }
  });
  // cortes que se sobrepõem viram um só (o maior vence)
  cortes.sort((a, b) => a.clipe - b.clipe || a.de - b.de);
  const limpo = [];
  for (const k of cortes) {
    const u = limpo[limpo.length - 1];
    if (u && u.clipe === k.clipe && k.de <= u.ate + 0.01) { if (k.ate > u.ate) { u.ate = k.ate; u.dur = u.ate - u.de; } if (k.tipo === 'refeitura') { u.tipo = 'refeitura'; u.motivo = k.motivo; u.forca = k.forca; } continue; }
    limpo.push(k);
  }
  limpo.push(...sugestoes);
  limpo.sort((a, b) => a.clipe - b.clipe || a.de - b.de);
  return limpo;
}

// Trechos que FICAM, na ordem, com o tempo de saída acumulado.
export function montarSegmentos(clipes, cortes) {
  const seg = [];
  let saida = 0;
  clipes.forEach((clipe, ci) => {
    const fora = cortes.filter(c => c.clipe === ci && c.ligado).sort((a, b) => a.de - b.de);
    let cursor = 0;
    const empurra = (de, ate) => {
      if (ate - de < 0.1) return;
      seg.push({ clipe: ci, de, ate, dur: ate - de, saidaDe: saida, saidaAte: saida + (ate - de) });
      saida += ate - de;
    };
    for (const c of fora) {
      if (c.de > cursor) empurra(cursor, c.de);
      cursor = Math.max(cursor, c.ate);
    }
    if (clipe.duracao > cursor) empurra(cursor, clipe.duracao);
  });
  return seg;
}
