// Renderiza o MP4 final no navegador: quadros decodificados pelo WebCodecs, transição
// (overlay em blend "screen") e legenda desenhadas no canvas, áudio dos trechos emendado
// com fade curto e o som da transição misturado por cima, H.264 + AAC.
import {
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  VideoSampleSink, QUALITY_HIGH, canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { cueEm, posicaoLegenda, SEM_AJUSTE, separarDestaque } from './captions.js';
import { pcmTrecho } from './media.js';

export async function verificarCodecs() {
  const video = await canEncodeVideo('avc');
  const aac = await canEncodeAudio('aac');
  const opus = await canEncodeAudio('opus');
  return { video, audio: aac ? 'aac' : opus ? 'opus' : null };
}

// Fonte do preset em sintaxe CSS; `fonteReserva` cobre navegador sem a fonte do sistema (Helvetica → Arial).
export function fonteCss(L, tamPx) {
  return `${L.peso} ${tamPx}px "${L.fonte}"${L.fonteReserva ? ', ' + L.fonteReserva : ''}`;
}

export function desenharLegenda(ctx, texto, L, W, H, pos = { x: L.x ?? 0.5, y: L.y }) {
  if (!texto) return;
  // com destaque: [frase em peso leve, última palavra em negrito] uma sob a outra; sem: uma linha
  const linhas = L.destaque ? separarDestaque(texto) : [texto];
  const pesoDe = i => (i === 1 && L.destaque) ? (L.destaque.peso || 800) : L.peso;
  const escalaDe = i => (i === 1 && L.destaque) ? (L.destaque.escala || 1) : 1;
  let tam = L.tamanho * W;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const prepara = (i, tamanho) => { const t = tamanho * escalaDe(i); ctx.letterSpacing = `${L.espacamento * t}px`; ctx.font = fonteCss({ ...L, peso: pesoDe(i) }, t); };
  const max = L.larguraMax * W;
  const larg = Math.max(...linhas.map((t, i) => { prepara(i, tam); return ctx.measureText(t).width; }));
  if (larg > max) tam = tam * (max / larg);
  ctx.shadowColor = L.sombra.cor;
  ctx.shadowBlur = L.sombra.blur * W;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = L.sombra.dy * W;
  ctx.fillStyle = L.cor;
  const entre = (L.entrelinha || 1.1) * tam;
  const y0 = pos.y * H - (linhas.length - 1) * entre / 2;   // o bloco inteiro fica centrado em pos.y
  linhas.forEach((t, i) => { prepara(i, tam); ctx.fillText(t, pos.x * W, y0 + i * entre); });
  ctx.restore();
}

function retanguloCobrir(sw, sh, W, H) {
  const esc = Math.max(W / sw, H / sh);
  const dw = sw * esc, dh = sh * esc;
  return { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh };
}

// Lê os quadros da transição em ordem, entregando o último quadro cujo tempo <= off.
class LeitorFx {
  constructor(inst) {
    this.entrada = inst.entrada || 0;
    this.it = new VideoSampleSink(inst.clipe.video).samples(this.entrada, this.entrada + inst.dur)[Symbol.asyncIterator]();
    this.atual = null; this.prox = null; this.fim = false;
  }
  async quadroEm(off) {
    while (!this.fim) {
      if (this.prox === null) {
        const r = await this.it.next();
        if (r.done) { this.fim = true; break; }
        this.prox = r.value;
      }
      if (this.prox.timestamp - this.entrada <= off) { this.atual?.close(); this.atual = this.prox; this.prox = null; }
      else break;
    }
    return this.atual;
  }
  fechar() { this.atual?.close(); this.prox?.close(); this.it.return?.(); }
}

// Mistura o áudio da transição no trecho, no tempo de saída. Ganho 0,8 para não estourar.
function misturarFx(pcm, seg, inst, ganho = 0.8) {
  const p = inst.clipe.pcm;
  if (!p) return;
  const a = Math.max(seg.saidaDe, inst.inicio), b = Math.min(seg.saidaAte, inst.inicio + inst.dur);
  if (b <= a) return;
  const razao = p.taxa / pcm.taxa;
  for (let c = 0; c < pcm.canais.length; c++) {
    const fonte = p.canais[Math.min(c, p.canais.length - 1)];
    const dest = pcm.canais[c];
    const i0 = Math.round((a - seg.saidaDe) * pcm.taxa), i1 = Math.min(pcm.n, Math.round((b - seg.saidaDe) * pcm.taxa));
    for (let i = i0; i < i1; i++) {
      const tOut = seg.saidaDe + i / pcm.taxa;
      const j = Math.round((tOut - inst.inicio + (inst.entrada || 0)) * pcm.taxa * razao);
      if (j >= 0 && j < fonte.length) dest[i] += fonte[j] * ganho;
    }
  }
}

export async function renderizar({ clipes, segmentos, cues, transicoes = [], preset, fps, ajusteLegenda = SEM_AJUSTE, aoProgredir, sinal }) {
  const W = preset.saida.largura, H = preset.saida.altura;
  const codecs = await verificarCodecs();
  if (!codecs.video) throw new Error('Este navegador não codifica H.264 (WebCodecs). Use Chrome, Edge ou Safari 26.');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const fxCanvas = document.createElement('canvas');
  fxCanvas.width = W; fxCanvas.height = H;
  const fxCtx = fxCanvas.getContext('2d', { alpha: false });
  await document.fonts.load(fonteCss(preset.legenda, 40));
  if (preset.legenda.destaque) await document.fonts.load(fonteCss({ ...preset.legenda, peso: preset.legenda.destaque.peso || 800 }, 40));

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const fonteVideo = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(fonteVideo, { frameRate: fps });
  const temAudio = codecs.audio && clipes.some(c => c.audio);
  let fonteAudio = null;
  if (temAudio) {
    fonteAudio = new AudioBufferSource({ codec: codecs.audio, quality: QUALITY_HIGH });
    output.addAudioTrack(fonteAudio);
  }
  await output.start();

  const total = segmentos.reduce((s, x) => s + x.dur, 0);
  const passo = 1 / fps;
  const fx = [...transicoes].sort((a, b) => a.inicio - b.inicio);
  const leitores = new Map();
  let feito = 0, ultimoT = -1;
  try {
    for (const seg of segmentos) {
      if (sinal?.aborted) throw new DOMException('cancelado', 'AbortError');
      const clipe = clipes[seg.clipe];
      // ---- vídeo
      const sink = new VideoSampleSink(clipe.video);
      const r = retanguloCobrir(clipe.largura, clipe.altura, W, H);
      for await (const sample of sink.samples(seg.de, seg.ate)) {
        const t = sample.timestamp;
        if (t < seg.de - passo / 2 || t >= seg.ate) { sample.close(); continue; }
        const outT = seg.saidaDe + Math.max(0, t - seg.de);
        if (outT <= ultimoT + passo * 0.5) { sample.close(); continue; }
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        sample.draw(ctx, r.dx, r.dy, r.dw, r.dh);
        // transição por cima, em "screen" (film burn e light leak têm fundo preto)
        const inst = fx.find(x => outT >= x.inicio && outT < x.inicio + x.dur);
        if (inst) {
          let leitor = leitores.get(inst);
          if (!leitor) { leitor = new LeitorFx(inst); leitores.set(inst, leitor); }
          const q = await leitor.quadroEm(outT - inst.inicio);
          if (q) {
            // o quadro da transição passa por um canvas intermediário: desenhar VideoFrame direto
            // com globalCompositeOperation 'screen' apagava a base no WebKit (saía flare sobre preto)
            const rf = retanguloCobrir(q.displayWidth, q.displayHeight, W, H);
            fxCtx.fillStyle = '#000';
            fxCtx.fillRect(0, 0, W, H);
            q.draw(fxCtx, rf.dx, rf.dy, rf.dw, rf.dh);
            ctx.globalCompositeOperation = 'screen';
            ctx.drawImage(fxCanvas, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        for (const [k, l] of leitores) if (outT >= k.inicio + k.dur) { l.fechar(); leitores.delete(k); }
        const cue = cueEm(cues, outT + passo / 2);
        desenharLegenda(ctx, cue?.texto, preset.legenda, W, H, posicaoLegenda(cue, preset.legenda, ajusteLegenda));
        await fonteVideo.add(outT, passo);
        ultimoT = outT;
        sample.close();
        feito = seg.saidaDe + (t - seg.de);
        aoProgredir?.(Math.min(0.995, feito / total), outT);
        if (sinal?.aborted) throw new DOMException('cancelado', 'AbortError');
      }
      // ---- áudio do trecho + som das transições que caem nele, fade de 4 ms nas pontas
      if (fonteAudio && clipe.audio) {
        const pcm = await pcmTrecho(clipe, seg.de, seg.ate);
        if (pcm) {
          for (const inst of fx) misturarFx(pcm, seg, inst);
          const fade = Math.min(Math.round(pcm.taxa * 0.004), Math.floor(pcm.n / 2));
          const buf = new AudioBuffer({ numberOfChannels: pcm.canais.length, length: pcm.n, sampleRate: pcm.taxa });
          for (let c = 0; c < pcm.canais.length; c++) {
            const ch = pcm.canais[c];
            for (let i = 0; i < fade; i++) { const g = i / fade; ch[i] *= g; ch[pcm.n - 1 - i] *= g; }
            for (let i = 0; i < pcm.n; i++) { if (ch[i] > 1) ch[i] = 1; else if (ch[i] < -1) ch[i] = -1; }
            buf.copyToChannel(ch, c);
          }
          await fonteAudio.add(buf);
        }
      }
    }
    for (const l of leitores.values()) l.fechar();
    fonteVideo.close();
    fonteAudio?.close();
    await output.finalize();
  } catch (e) {
    for (const l of leitores.values()) l.fechar();
    try { await output.cancel(); } catch {}
    throw e;
  }
  aoProgredir?.(1, total);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// Recorta o plano (trechos, legendas, transições) para uma janela [de, ate) do tempo de saída,
// reposicionando tudo para começar em 0 — serve para renderizar só o entorno de uma emenda
// pelo MESMO caminho do export final ("como vai ficar" de verdade).
export function recortarJanela({ segmentos, cues, transicoes = [] }, de, ate) {
  const seg = [];
  for (const x of segmentos) {
    const a = Math.max(x.saidaDe, de), b = Math.min(x.saidaAte, ate);
    if (b - a <= 0.02) continue;
    const dDe = a - x.saidaDe;
    seg.push({ clipe: x.clipe, de: x.de + dDe, ate: x.de + dDe + (b - a), dur: b - a, saidaDe: a - de, saidaAte: b - de });
  }
  const cu = cues.filter(c => c.ate > de && c.de < ate).map(c => ({ ...c, de: Math.max(0, c.de - de), ate: Math.min(ate - de, c.ate - de) }));
  const fx = transicoes.filter(t => t.inicio + t.dur > de && t.inicio < ate).map(t => ({ ...t, inicio: t.inicio - de }));
  return { segmentos: seg, cues: cu, transicoes: fx };
}
