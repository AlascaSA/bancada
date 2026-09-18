// Leitura dos brutos no navegador: metadados, miniaturas e áudio mono 16 kHz.
// Tudo via Mediabunny (WebCodecs) — nada sai da máquina do editor.
import { Input, ALL_FORMATS, BlobSource, CanvasSink, AudioSampleSink } from 'mediabunny';

export async function abrirClipe(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error(`${file.name}: não tem faixa de vídeo`);
  const audio = await input.getPrimaryAudioTrack();
  const [duracao, largura, altura, metricas, rotacao, podeDecodificar] = await Promise.all([
    input.computeDuration(),
    video.getDisplayWidth(),
    video.getDisplayHeight(),
    video.computeFrameRateMetrics(),
    video.getRotation(),
    video.canDecode(),
  ]);
  return {
    file, nome: file.name, url: URL.createObjectURL(file),
    input, video, audio, duracao, largura, altura,
    fps: metricas.bestGuessFrameRate || 30, rotacao, podeDecodificar,
  };
}

// Um quadro por segundo, em miniatura, para desenhar a fita. Por getCanvas(t): decodifica só do
// keyframe mais perto — varrer todos os quadros (canvases) saía em tempo real no Safari com 4K.
export async function miniaturas(clipe, alturaPx = 96, cada = 1, aoProgredir) {
  const sink = new CanvasSink(clipe.video, { height: alturaPx, fit: 'contain' });
  const lista = [];
  const n = Math.max(1, Math.ceil(clipe.duracao / cada));
  for (let k = 0; k < n; k++) {
    const t = Math.min(clipe.duracao - 0.05, k * cada + Math.min(0.4, clipe.duracao / 2));
    const q = await sink.getCanvas(t);
    if (q) lista.push({ t, canvas: q.canvas });
    if (k % 10 === 0) aoProgredir?.(k / n);
  }
  return lista;
}

// Áudio inteiro do clipe em mono 16 kHz (para energia e transcrição).
export async function audioMono16k(clipe) {
  const TAXA = 16000;
  if (!clipe.audio) return { taxa: TAXA, dados: new Float32Array(Math.ceil(clipe.duracao * TAXA)) };
  const sink = new AudioSampleSink(clipe.audio);
  const pedacos = [];
  let taxa = 48000, total = 0, primeiro = null;
  for await (const s of sink.samples()) {
    if (primeiro === null) primeiro = s.timestamp;
    taxa = s.sampleRate;
    const ch = s.numberOfChannels, n = s.numberOfFrames;
    const inter = new Float32Array(n * ch);
    s.copyTo(inter, { format: 'f32', planeIndex: 0 });
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let c = 0; c < ch; c++) acc += inter[i * ch + c];
      mono[i] = acc / ch;
    }
    pedacos.push(mono);
    total += n;
    s.close();
  }
  // o primeiro sample pode não começar em 0 — o silêncio inicial entra como zeros
  const folga = Math.max(0, Math.round((primeiro || 0) * taxa));
  const cheio = new Float32Array(folga + total);
  let off = folga;
  for (const p of pedacos) { cheio.set(p, off); off += p.length; }
  return { taxa: TAXA, dados: reamostrar(cheio, taxa, TAXA) };
}

export function reamostrar(x, de, para) {
  if (de === para) return x;
  const razao = de / para;
  const n = Math.floor(x.length / razao);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * razao, k = Math.floor(p), f = p - k;
    const a = x[k], b = x[Math.min(k + 1, x.length - 1)];
    y[i] = a + (b - a) * f;
  }
  return y;
}

// Primeiro quadro útil do clipe (para a tira de filme da tela de entrada).
export async function primeiroQuadro(clipe, alturaPx = 240, t = null) {
  const sink = new CanvasSink(clipe.video, { height: alturaPx, fit: 'cover' });
  const q = await sink.getCanvas(t == null ? Math.min(0.5, clipe.duracao / 2) : Math.min(Math.max(0, t), clipe.duracao - 0.05));
  return q ? q.canvas : null;
}

// PCM de um trecho [de, ate) do clipe, nos canais e taxa nativos, recortado no sample exato.
export async function pcmTrecho(clipe, de, ate) {
  if (!clipe.audio) return null;
  const sink = new AudioSampleSink(clipe.audio);
  let taxa = 48000, canais = 2;
  const partes = [];
  for await (const s of sink.samples(de, ate)) {
    taxa = s.sampleRate; canais = s.numberOfChannels;
    const n = s.numberOfFrames;
    const inter = new Float32Array(n * canais);
    s.copyTo(inter, { format: 'f32', planeIndex: 0 });
    partes.push({ t: s.timestamp, n, inter });
    s.close();
  }
  if (!partes.length) return null;
  const total = Math.max(1, Math.round((ate - de) * taxa));
  const canal = Array.from({ length: canais }, () => new Float32Array(total));
  for (const p of partes) {
    const ini = Math.round((p.t - de) * taxa);
    for (let i = 0; i < p.n; i++) {
      const k = ini + i;
      if (k < 0 || k >= total) continue;
      for (let c = 0; c < canais; c++) canal[c][k] = p.inter[i * canais + c];
    }
  }
  return { taxa, canais: canal, n: total };
}

// Transição (overlay de film burn, light leak…): um clipe como outro qualquer + miniatura.
export async function abrirTransicao(file) {
  const c = await abrirClipe(file);
  c.id = `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  c.thumb = await primeiroQuadro(c, 90);
  c.pcm = c.audio ? await pcmTrecho(c, 0, c.duracao) : null;
  return c;
}
