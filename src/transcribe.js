// Transcrição pela Groq (Whisper large-v3-turbo, tempo por palavra).
// A chave fica no servidor (serve.py local ou Worker no ar): o navegador só fala com /api/groq.

export function wav16(dados, taxa = 16000) {
  const n = dados.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, dados[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export async function transcrever(blob, { idioma = 'pt', base = '/api/groq' } = {}) {
  const fd = new FormData();
  fd.append('file', blob, 'audio.wav');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', idioma);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  // A Groq limita o whisper a 20 pedidos por minuto. Três brutos em paralelo, cada
  // um com fatias e janelas de recuperação, estouram isso fácil — e o 429 vinha
  // com "try again in 3s", que eu ignorava. Agora espera o que ela pede e tenta
  // de novo, até 4 vezes.
  let r, j;
  for (let tentativa = 0; ; tentativa++) {
    r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: fd });
    if (r.ok) break;
    let msg = `Groq respondeu ${r.status}`, espera = 0;
    try { const e = await r.json(); const m = e.error?.message || e.erro || ''; msg += `: ${m}`; const t = /try again in ([\d.]+)s/.exec(m); espera = t ? +t[1] : 0; } catch {}
    if (r.status === 429 && tentativa < 4) { await new Promise(ok => setTimeout(ok, (espera || 3 * (tentativa + 1)) * 1000 + 300)); continue; }
    throw new Error(msg);
  }
  j = await r.json();
  const palavras = (j.words || [])
    .map(w => ({ texto: String(w.word || '').trim(), de: +w.start, ate: +w.end }))
    .filter(w => w.texto && Number.isFinite(w.de) && Number.isFinite(w.ate));
  // palavra sem duração (início = fim) atrapalha o corte: dá 60 ms mínimos
  for (const w of palavras) if (w.ate <= w.de) w.ate = w.de + 0.06;
  return { texto: j.text || '', palavras, segmentos: j.segments || [] };
}

// Transcreve um áudio longo em fatias cortadas nos silêncios (<= 90 s cada), em paralelo (3 por vez).
// O relógio de palavra do whisper escorrega em arquivo longo; em fatia curta fica no lugar.
export async function transcreverFatiado(dados, taxa, fatias, { aoProgredir, energia } = {}) {
  const palavras = [];
  let texto = '', feitas = 0;
  const fila = fatias.map(([de, ate], k) => ({ de, ate, k }));
  const resultados = new Array(fatias.length);
  const roda = async () => {
    while (fila.length) {
      const f = fila.shift();
      const trecho = dados.subarray(Math.floor(f.de * taxa), Math.floor(f.ate * taxa));
      const r = await transcrever(wav16(trecho, taxa));
      resultados[f.k] = { de: f.de, r };
      feitas++;
      aoProgredir?.(feitas, fatias.length);
    }
  };
  await Promise.all([roda(), roda(), roda()]);
  for (const x of resultados) {
    if (!x) continue;
    for (const w of x.r.palavras) palavras.push({ texto: w.texto, de: w.de + x.de, ate: w.ate + x.de });
    texto += (texto ? ' ' : '') + x.r.texto.trim();
  }
  // a ORDEM DO TEXTO manda: ordenar por tempo embaralhava a frase quando o whisper dá tempo errado a uma palavra
  // ("é só clicar abaixo. no botão"). As fatias já vêm em ordem; só se garante tempo monotônico.
  for (let i = 1; i < palavras.length; i++) { if (palavras[i].de < palavras[i - 1].ate) palavras[i].de = palavras[i - 1].ate; if (palavras[i].ate < palavras[i].de + 0.02) palavras[i].ate = palavras[i].de + 0.02; }
  const recuperadas = await recuperarEngolidas(dados, taxa, palavras, { aoProgredir, energia });
  return { texto, palavras, recuperadas };
}

// O whisper ENGOLE fala e estica a palavra vizinha por cima do buraco. Visto no
// bruto de 4:22 do Jaylton: "advogado" saiu com 4,8 s de duração e por baixo dela
// havia "e aquela... E talvez uma das maiores diferenças entre o" — a refeitura
// inteira. Sem esse texto o detector não tem o que comparar, e a ilha de "fala
// fora da transcrição" também não acusa, porque a palavra esticada cobre o tempo.
// Cada trecho suspeito (palavra > 1,2 s ou vão > 0,6 s entre palavras) é
// transcrito DE NOVO numa janela curta com contexto — em fatia curta o relógio
// do whisper fica no lugar — e as palavras dentro do trecho são trocadas pelas
// da janela, com o tempo real que ela devolve.
const PALAVRA_ESTICADA = 1.2;
const VAO = 0.6;
const MARGEM = 2.0;

export async function recuperarEngolidas(dados, taxa, palavras, { aoProgredir, energia, ouvir = transcrever } = {}) {
  const dur = dados.length / taxa;
  const suspeitos = [];
  for (let i = 0; i < palavras.length; i++) {
    const w = palavras[i], p = palavras[i + 1], q = palavras[i - 1];
    // Palavra esticada: o que foi engolido pode estar ANTES ou DEPOIS do que ela diz de verdade —
    // em "todas." (2,9 s, vídeo de 4:22 aos 2:55) a tentativa abortada vinha antes. Por isso as
    // âncoras são as VIZINHAS, e a própria esticada é trocada pelo que a janela ouve no lugar.
    if (w.ate - w.de > PALAVRA_ESTICADA) suspeitos.push({ de: q ? q.ate : w.de, ate: p ? p.de : w.ate, iEsq: i - 1, iDir: i + 1 });
    // pausa só é suspeita se tiver VOZ dentro: pausa de verdade é silêncio, e
    // reouvir cada uma gastava a cota de 20 pedidos/min da Groq à toa
    if (p && p.de - w.ate > VAO && (!energia || energia.fracaoFala(w.ate, p.de) > 0.25)) suspeitos.push({ de: w.ate, ate: p.de, iEsq: i, iDir: i + 1 });
  }
  // junta trechos que se encostam para não reouvir a mesma janela duas vezes
  suspeitos.sort((a, b) => a.de - b.de);
  const trechos = [];
  for (const t of suspeitos) {
    const u = trechos[trechos.length - 1];
    if (u && t.de <= u.ate + MARGEM) { u.ate = Math.max(u.ate, t.ate); u.iDir = Math.max(u.iDir, t.iDir); u.iEsq = Math.min(u.iEsq, t.iEsq); }
    else trechos.push({ ...t });
  }
  const fila = trechos.map((t, k) => ({ t, k }));
  const trocas = new Array(trechos.length);
  let feitas = 0;
  const roda = async () => {
    while (fila.length) {
      const { t, k } = fila.shift();
      const de = Math.max(0, t.de - MARGEM), ate = Math.min(dur, t.ate + MARGEM);
      try {
        const r = await ouvir(wav16(dados.subarray(Math.floor(de * taxa), Math.floor(ate * taxa)), taxa));
        trocas[k] = r.palavras.map(w => ({ texto: w.texto, de: w.de + de, ate: w.ate + de }));
      } catch { trocas[k] = null; }
      feitas++;
      aoProgredir?.(feitas, trechos.length, 'reouvindo');
    }
  };
  await Promise.all([roda(), roda()]);

  // Encaixe por ÂNCORAS: a palavra original de cada lado do trecho é localizada
  // na transcrição da janela (pelo texto, perto do tempo), e só o que a janela
  // ouviu ENTRE as duas entra. As originais não são trocadas — trocar por tempo
  // duplicava "existe" na borda e apagava o ponto de "advocacia.", colando duas
  // tentativas numa frase só e escondendo uma refeitura que antes era pega.
  const limpa = t => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const acha = (lista, alvo, perto, deIdx, sentido) => {
    const chave = limpa(alvo.texto);
    if (!chave) return -1;
    let melhor = -1, dist = 1.5;
    for (let i = Math.max(0, deIdx); i < lista.length; i++) {
      if (sentido < 0 && i > deIdx) break;
      if (limpa(lista[i].texto) !== chave) continue;
      const d = Math.abs(lista[i].de - perto);
      if (d < dist) { dist = d; melhor = i; }
    }
    return melhor;
  };
  let total = 0;
  // do fim para o começo: cada troca muda os índices só DEPOIS dela, então os trechos anteriores continuam válidos
  for (let k = trechos.length - 1; k >= 0; k--) {
    const janela = trocas[k];
    if (!janela) continue;
    let { iEsq, iDir } = trechos[k];
    if (iEsq < 0 || iDir >= palavras.length || iDir <= iEsq) continue;
    const esq = palavras[iEsq];
    const jEsq = acha(janela, esq, esq.de, 0, +1);
    if (jEsq < 0) continue;
    // âncora da direita pelo texto; se a janela não a ouviu igual, tenta a palavra seguinte (e engloba a que falhou)
    let dir = palavras[iDir];
    let jDir = acha(janela, dir, dir.de, jEsq + 1, +1);
    if (jDir < 0 && iDir + 1 < palavras.length) { iDir++; dir = palavras[iDir]; jDir = acha(janela, dir, dir.de, jEsq + 1, +1); }
    if (jDir < 0 || jDir <= jEsq) continue;
    const novas = janela.slice(jEsq + 1, jDir);
    const jaTem = iDir - iEsq - 1;          // originais que já existem entre as âncoras
    if (novas.length <= jaTem) continue;    // a janela não ouviu nada além do que a fatia ouviu
    // palavra esticada: o fim real é o que a janela mediu
    if (esq.ate - esq.de > PALAVRA_ESTICADA && janela[jEsq].ate > esq.de) esq.ate = janela[jEsq].ate;
    // A ordem do TEXTO manda. A Groq às vezes devolve uma palavra curta ("que") com tempo sobreposto
    // à vizinha; ordenar por tempo embaralhava a frase ("acredita ganhar que precisa") e o detector
    // de repetição deixava de ver "o iniciante acredita que precisa ganhar" duas vezes.
    let fim = janela[jEsq].ate;
    for (const w of novas) { if (w.de < fim) w.de = fim; if (w.ate < w.de + 0.02) w.ate = w.de + 0.02; fim = w.ate; }
    palavras.splice(iEsq + 1, jaTem, ...novas);
    total += novas.length - jaTem;
  }
  // A emenda pela âncora às vezes deixa a mesma palavra duas vezes na borda ("advocacia. advocacia.", tempos
  // sobrepostos): palavra igual à anterior começando antes de a anterior acabar (+50 ms) é duplicata
  for (let i = palavras.length - 1; i > 0; i--) {
    const w = palavras[i], p = palavras[i - 1];
    if (limpa(w.texto) === limpa(p.texto) && w.de < p.ate + 0.05) { p.ate = Math.max(p.ate, w.ate); palavras.splice(i, 1); }
  }
  // Gagueira / começo falso curto ("Mas sá… Mas sabe qual foi", AD119 aos 0:21): padrão de ENERGIA —
  // bloco curto A (≤ 0,8 s) isolado por silêncio, depois bloco B longo — e o whisper com uma palavra
  // atravessando o silêncio entre A e B (colou A nela). Numa janela que começa no silêncio antes de B,
  // as palavras que ele pôs em A (+ a que atravessa) aparecem logo no começo? Se sim, A é gagueira
  // delas: passam para B com o tempo da janela, e A vira som sem texto para o planejador.
  const temEnergia = energia && typeof energia.corridas === 'function';
  if (temEnergia) {
    const blocos = energia.corridas(0, dur);
    let escutas = 0;
    for (let r = 1; r + 1 < blocos.length && escutas < 8; r++) {
      const A = blocos[r], B = blocos[r + 1];
      if (A.ate - A.de > 0.8 || A.ate - A.de < 0.15 || B.de - A.ate < 0.3 || B.ate - B.de < 0.8 || A.de - blocos[r - 1].ate < 0.3) continue;
      if (energia.pico(A.de, A.ate) < 0.5 * energia.pico(B.de, Math.min(B.ate, B.de + 1))) continue;
      const atravessa = palavras.findIndex(w => w.de < A.ate + 0.05 && w.ate > B.de - 0.05);
      if (atravessa < 0) continue;
      const cands = [];
      for (let i = 0; i < palavras.length; i++) { const c = (palavras[i].de + palavras[i].ate) / 2; if (c >= A.de - 0.05 && c <= A.ate + 0.05) cands.push(i); }
      if (!cands.includes(atravessa)) cands.push(atravessa);
      cands.sort((x, y) => x - y);
      if (cands.length > 3) continue;
      const de = Math.max(0, B.de - 0.35), ate = Math.min(dur, B.de + 4);
      escutas++;
      let resp;
      try { resp = await ouvir(wav16(dados.subarray(Math.floor(de * taxa), Math.floor(ate * taxa)), taxa)); } catch { continue; }
      const rw = resp.palavras || [];
      const bate = n => cands.slice(cands.length - n).every((ci, k) => rw[k] && limpa(rw[k].texto) === limpa(palavras[ci].texto));
      let n = cands.length;
      while (n > 0 && !bate(n)) n--;        // todas as candidatas; senão só as últimas (a que atravessa)
      if (!n) continue;
      cands.slice(cands.length - n).forEach((ci, k) => { const w = palavras[ci]; w.de = Math.max(B.de - 0.1, rw[k].de + de); w.ate = Math.max(w.de + 0.05, rw[k].ate + de); w.reancorada = true; });
      aoProgredir?.(escutas, escutas, 'reouvindo');
    }
  }
  // Segunda escuta: palavra ainda esticada cobrindo dois blocos de voz separados por silêncio
  // ("pouco" de 2,2 s por cima de um som sem palavra, AD119 aos 0:12). O whisper nunca dá palavra
  // ao primeiro bloco, mas o TEMPO que ele dá à palavra oscila com o começo da janela — então a
  // pergunta é outra: numa janela que começa DEPOIS do primeiro bloco, a palavra continua lá? Se
  // sim, ela mora no bloco seguinte e o primeiro é som sem texto (começo falso, hesitação): a
  // palavra passa a começar no bloco onde foi ouvida, marcada `reancorada`, e o planejador decide.
  if (temEnergia) {
    let escutas = 0;
    for (let i = 0; i < palavras.length && escutas < 6; i++) {
      const w = palavras[i];
      if (w.ate - w.de <= PALAVRA_ESTICADA) continue;
      const runs = energia.corridas(w.de, Math.min(dur, w.ate + 4)).filter(r => r.de < w.ate);   // o último bloco com a extensão real, não cortado em w.ate
      if (runs.length < 2) continue;
      const topo = Math.max(...runs.map(r => energia.pico(r.de, r.ate)));
      const fortes = runs.filter(r => energia.pico(r.de, r.ate) >= 0.5 * topo);
      if (!fortes.length) continue;
      // o alvo é o último bloco forte; o que vem antes dele dentro da palavra pode ser fraco (começo falso
      // murmurado, "onde eu a…") — basta a palavra atravessar um silêncio ≥ 0,3 s
      const alvo = fortes[fortes.length - 1];
      const anterior = runs[runs.indexOf(alvo) - 1];
      if (!anterior || alvo.de - anterior.ate < 0.3) continue;
      const de = Math.max(0, alvo.de - 0.35), ate = Math.min(dur, Math.max(alvo.ate, palavras[i + 1] ? palavras[i + 1].de : w.ate) + 1.5);
      escutas++;
      let r;
      try { r = await ouvir(wav16(dados.subarray(Math.floor(de * taxa), Math.floor(ate * taxa)), taxa)); } catch { continue; }
      const chave = limpa(w.texto), rw = r.palavras || [];
      const k = rw.findIndex(x => limpa(x.texto) === chave);
      const achada = k >= 0 ? rw[k] : null;
      // o tempo que a janela dá à palavra oscila (até 0,3 s depois do bloco): o que vale é ela estar no bloco-alvo
      if (achada && achada.de + de >= alvo.de - 0.4 && achada.de + de <= alvo.ate + 0.3) {
        // As palavras ORIGINAIS logo antes desta que a janela também ouve logo antes dela vieram junto para
        // depois do silêncio: "…inventários que é [onde eu a…] que é a minha área" — o whisper deu o "que é"
        // à tentativa abortada; a janela limpa mostra o "que é" de verdade depois da pausa.
        let j = k - 1, q = i - 1, iguais = 0;
        while (j >= 0 && q >= 0 && iguais < 12 && !palavras[q].reancorada && limpa(rw[j].texto) === limpa(palavras[q].texto)) { j--; q--; iguais++; }
        if (iguais >= 4) {
          // 4+ palavras iguais antes: ele RECOMEÇOU a frase ("…inventários que é [onde eu a] | E na advocacia de
          // inventários que é a minha área"). As cópias entram como segunda tentativa, com o tempo da janela;
          // a regra de refeitura tira a primeira (as originais ficam onde estão, marcando a tentativa)
          const copias = rw.slice(k - iguais, k).map(x => ({ texto: x.texto, de: x.de + de, ate: x.ate + de, reancorada: true }));
          palavras.splice(i, 0, ...copias); i += copias.length;
          w.de = Math.max(alvo.de, achada.de + de);
        } else if (iguais) {
          // 1 a 3 palavras: o whisper só colou no lado errado do silêncio — passam para depois dele
          for (let m = 1; m <= iguais; m++) { const o = palavras[i - m], x = rw[k - m]; o.de = x.de + de; o.ate = Math.max(o.de + 0.05, x.ate + de); o.reancorada = true; o.movida = true; }
          w.de = Math.max(alvo.de, achada.de + de);
        } else w.de = Math.max(w.de, alvo.de);
        w.reancorada = true;
      }
      aoProgredir?.(escutas, escutas, 'reouvindo');
    }
  }
  return total;
}
