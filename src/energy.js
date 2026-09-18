// Envelope de energia, limiar de silêncio (Otsu no log) e corridas de silêncio.
// Regra herdada do editor-prproj: o limiar tem que ser ABSOLUTO no clipe inteiro —
// relativo à janela inventa pausa em fala emendada.

export const HOP = 0.01; // s

export function envelope(dados, taxa, hopS = HOP) {
  const hop = Math.max(1, Math.round(taxa * hopS));
  const n = Math.floor(dados.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const ini = i * hop;
    for (let j = ini; j < ini + hop; j++) s += dados[j] * dados[j];
    env[i] = Math.sqrt(s / hop);
  }
  return env;
}

export function limiarOtsu(env) {
  const N = 64;
  const logs = new Float32Array(env.length);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < env.length; i++) {
    const v = Math.log10(env[i] + 1e-6);
    logs[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) return Infinity;
  const hist = new Float64Array(N);
  const passo = (mx - mn) / N;
  for (let i = 0; i < logs.length; i++) {
    const b = Math.min(N - 1, Math.floor((logs[i] - mn) / passo));
    hist[b]++;
  }
  const total = logs.length;
  let soma = 0;
  for (let b = 0; b < N; b++) soma += b * hist[b];
  let somaB = 0, pesoB = 0, melhor = -1, melhorB = 0;
  for (let b = 0; b < N; b++) {
    pesoB += hist[b];
    if (pesoB === 0) continue;
    const pesoF = total - pesoB;
    if (pesoF === 0) break;
    somaB += b * hist[b];
    const mB = somaB / pesoB, mF = (soma - somaB) / pesoF;
    const entre = pesoB * pesoF * (mB - mF) * (mB - mF);
    if (entre > melhor) { melhor = entre; melhorB = b; }
  }
  return Math.pow(10, mn + (melhorB + 1) * passo);
}

// Corridas contínuas abaixo do limiar, com duração mínima (s).
export function silencios(env, limiar, hopS = HOP, minimo = 0.12) {
  const out = [];
  let ini = -1;
  for (let i = 0; i <= env.length; i++) {
    const quieto = i < env.length && env[i] < limiar;
    if (quieto && ini < 0) ini = i;
    if (!quieto && ini >= 0) {
      const de = ini * hopS, ate = i * hopS;
      if (ate - de >= minimo) out.push({ de, ate });
      ini = -1;
    }
  }
  return out;
}

// Fração do tempo com fala (para detectar clipe mudo).
export function fracaoFala(env, limiar) {
  let n = 0;
  for (let i = 0; i < env.length; i++) if (env[i] >= limiar) n++;
  return env.length ? n / env.length : 0;
}

// Consultas pontuais no envelope (mesmas do fala.py): onde a fala para, onde volta.
export class Energia {
  constructor(env, limiar, hopS = HOP) { this.env = env; this.limiar = limiar; this.hop = hopS; }
  fala(t) { const i = Math.floor(t / this.hop); return i >= 0 && i < this.env.length && this.env[i] >= this.limiar; }
  // primeiro instante >= t em que o áudio silencia (null se não parar dentro do limite)
  comecaSilencio(t, limite = 0.7) {
    const i0 = Math.max(0, Math.floor(t / this.hop)), i1 = Math.min(this.env.length, i0 + Math.round(limite / this.hop));
    for (let i = i0; i < i1; i++) if (this.env[i] < this.limiar) return i * this.hop;
    return null;
  }
  // onset da fala mais perto ANTES de t: última subida silêncio→fala dentro de [t-antes, t+depois]
  onset(t, antes = 0.35, depois = 0.12) {
    const i0 = Math.max(1, Math.floor((t - antes) / this.hop)), i1 = Math.min(this.env.length, Math.floor((t + depois) / this.hop));
    let achado = null;
    for (let i = i0; i < i1; i++) if (this.env[i] >= this.limiar && this.env[i - 1] < this.limiar) achado = i * this.hop;
    return achado;
  }
  // fração de janelas com fala em [a, b]
  fracaoFala(a, b) {
    const i0 = Math.max(0, Math.floor(a / this.hop)), i1 = Math.min(this.env.length, Math.floor(b / this.hop));
    if (i1 <= i0) return 0;
    let n = 0;
    for (let i = i0; i < i1; i++) if (this.env[i] >= this.limiar) n++;
    return n / (i1 - i0);
  }
  // instante de MENOR energia em [a, b] — o vale entre duas palavras na fala contínua (onde cortar sem morder)
  vale(a, b) {
    const i0 = Math.max(0, Math.floor(a / this.hop)), i1 = Math.min(this.env.length, Math.ceil(b / this.hop));
    let m = Infinity, im = i0;
    for (let i = i0; i < i1; i++) if (this.env[i] < m) { m = this.env[i]; im = i; }
    return im * this.hop;
  }
  // maior energia em [a, b]
  pico(a, b) {
    const i0 = Math.max(0, Math.floor(a / this.hop)), i1 = Math.min(this.env.length, Math.ceil(b / this.hop));
    let m = 0;
    for (let i = i0; i < i1; i++) if (this.env[i] > m) m = this.env[i];
    return m;
  }
  // corridas de fala em [a, b] (só vãos < 0,05 s são emendados; o respiro fica separado da palavra): [{de, ate}]
  corridas(a, b) {
    const i0 = Math.max(0, Math.floor(a / this.hop)), i1 = Math.min(this.env.length, Math.ceil(b / this.hop));
    const out = [];
    let ini = null;
    for (let i = i0; i <= i1; i++) {
      const fala = i < i1 && this.env[i] >= this.limiar;
      if (fala && ini === null) ini = i;
      if (!fala && ini !== null) {
        const de = ini * this.hop, ate = i * this.hop;
        const u = out[out.length - 1];
        if (u && de - u.ate < 0.05) u.ate = ate; else out.push({ de, ate });
        ini = null;
      }
    }
    return out;
  }
  // pontos de corte de um trecho de áudio: silêncios longos onde dá para fatiar (para transcrever em pedaços)
  fatias(duracao, alvo = 60, maximo = 90) {
    const cortes = [];
    let de = 0;
    while (duracao - de > maximo) {
      // procura o silêncio mais longo entre de+alvo*0.6 e de+maximo
      let melhor = null, tam = 0, ini = null;
      const i0 = Math.floor((de + alvo * 0.6) / this.hop), i1 = Math.min(this.env.length, Math.floor((de + maximo) / this.hop));
      for (let i = i0; i <= i1; i++) {
        const quieto = i < i1 && this.env[i] < this.limiar;
        if (quieto && ini === null) ini = i;
        if (!quieto && ini !== null) { if (i - ini > tam) { tam = i - ini; melhor = (ini + i) / 2 * this.hop; } ini = null; }
      }
      const ponto = melhor ?? de + alvo;
      cortes.push([de, ponto]); de = ponto;
    }
    cortes.push([de, duracao]);
    return cortes;
  }
}

// O whisper cola o silêncio na palavra vizinha: "ensina, [respiro] que" vira `que` começando no fim
// de "ensina," e durando o respiro inteiro. Uma palavra não pode começar nem terminar em silêncio:
// se o começo dela cai num buraco ≥ `buraco` s, ela começa na corrida forte seguinte; se o fim dela
// sobra depois da última corrida forte, ela acaba onde o som acaba. Devolve cópias — o estado do app
// guarda o que o whisper disse. Guarda contra relógio atrasado: se há uma corrida forte "órfã" logo
// antes da palavra (som que a palavra anterior não cobre), o whisper está atrasado ali e nada se mexe.
export function encostarPalavras(palavras, E, { buraco = 0.2 } = {}) {
  if (!E || !palavras?.length) return palavras || [];
  const out = palavras.map(w => ({ ...w }));
  // o whisper às vezes devolve tempos sobrepostos ("advocacia 151,30-151,80 | para 151,47-151,70"): a ordem do texto manda
  for (let i = 1; i < out.length; i++) { if (out[i].de < out[i - 1].ate) out[i].de = out[i - 1].ate; if (out[i].ate < out[i].de + 0.02) out[i].ate = out[i].de + 0.02; }
  for (let i = 0; i < out.length; i++) {
    const w = out[i], p = out[i - 1];
    if (w.ate - w.de < buraco + 0.05) continue;                       // curta demais para esconder um buraco
    const runs = E.corridas(w.de - 0.05, w.ate + 0.05);
    if (!runs.length) continue;
    const picos = runs.map(r => E.pico(r.de, r.ate));
    const topo = Math.max(...picos);
    const fortes = runs.filter((r, k) => picos[k] >= 0.5 * topo);
    // começo: primeira corrida forte que ainda dura depois de w.de + 0.1 (a cauda da anterior não conta)
    const primeira = fortes.find(r => r.ate > w.de + 0.1);
    if (primeira && primeira.de - w.de >= buraco && primeira.de < w.ate - 0.02) {
      const lim = 0.5 * E.pico(primeira.de, primeira.ate);
      const anteriores = out.slice(Math.max(0, i - 6), i);                // as últimas palavras explicam o som antes desta?
      const orfa = E.corridas(w.de - 0.6, w.de + 0.05).some(r => {
        if (r.ate < w.de - 0.5 || E.pico(r.de, r.ate) < lim) return false;
        const caudaDe = Math.max(r.de, r.ate - 0.3);
        return !anteriores.some(q => caudaDe < q.ate + 0.05 && r.ate > q.de - 0.05);   // som forte que nenhuma anterior explica
      });
      if (!orfa) w.de = primeira.de;
    }
    // fim: última corrida forte que começa antes de w.ate − 0.1; o que sobra depois dela é silêncio
    const ultima = [...fortes].reverse().find(r => r.de < w.ate - 0.1);
    if (ultima && w.ate - ultima.ate >= buraco && ultima.ate > w.de + 0.02) w.ate = ultima.ate;
  }
  return out;
}
