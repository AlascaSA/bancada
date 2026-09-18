// Prévia sem render: toca os brutos originais pulando os cortes, com a legenda por cima.
// Duas lentes <video>. A que vai entrar não espera parada no ponto: ela PARTE MUDA 0,3 s
// antes da emenda (o decodificador acorda frio e segura o primeiro quadro por ~300 ms —
// lição da Ilha). Na emenda, a lente que sai segura o último quadro até a que entra
// chegar no ponto, e aí trocam de lugar. Nunca display:none: as duas ficam na árvore,
// só a opacidade muda (Safari pinta preto ao revelar vídeo escondido).
// Uma terceira lente, em mix-blend-mode "screen", toca a transição em cima da emenda.
import { cueEm } from './captions.js';

const PARTIDA = 0.30;   // s antes da emenda em que a lente seguinte começa a rodar, muda
const FOLGA = 0.02;     // s antes do fim do trecho em que se considera "chegou"
const ESPERA_MAX = 24;  // voltas do laço segurando o último quadro à espera da lente nova

export class Previa {
  constructor(raiz, aoTempo) {
    this.raiz = raiz;
    this.aoTempo = aoTempo;
    this.lentes = [0, 1].map(() => {
      const v = document.createElement('video');
      v.playsInline = true; v.preload = 'auto'; v.muted = false;
      raiz.appendChild(v);
      return v;
    });
    // A transição NÃO entra como clipe: é overlay em "screen" por cima da imagem. O <video>
    // dela fica invisível só decodificando; a composição (base + overlay) é desenhada num
    // canvas, porque mix-blend-mode em <video> não funciona no Safari (aparecia opaca, preta).
    this.fx = document.createElement('video');
    this.fx.className = 'previa-fx'; this.fx.playsInline = true; this.fx.preload = 'auto';
    raiz.appendChild(this.fx);
    this.fxCanvas = document.createElement('canvas');
    this.fxCanvas.className = 'previa-fxcanvas';
    this.fxCanvas.width = 540; this.fxCanvas.height = 960;
    this.fxCtx = this.fxCanvas.getContext('2d', { alpha: false });
    raiz.appendChild(this.fxCanvas);
    this.legenda = document.createElement('div');
    this.legenda.className = 'previa-legenda';
    raiz.appendChild(this.legenda);
    this.posicaoDe = null;       // (cue) => {x, y} em frações — o app injeta (padrão + deslocamentos)
    this.formatar = null;        // (texto) => html — o app injeta (estilo com destaque desenha duas linhas)
    this._texto = null;
    this._pos = '';
    // guias do arrasto da legenda: linha na altura + linha do centro, com o rótulo em %
    this.guia = document.createElement('div');
    this.guia.className = 'previa-guia';
    this.guia.hidden = true;
    this.guia.innerHTML = '<i class="h"></i><i class="v"></i><b></b>';
    raiz.appendChild(this.guia);
    // "como vai ficar": um trecho renderizado pelo caminho do export, tocando em loop por cima
    this.render = document.createElement('div');
    this.render.className = 'previa-render';
    this.render.hidden = true;
    this.render.innerHTML = '<video loop playsinline></video><div class="previa-render-barra"><span></span><button type="button" class="bt bt-mini">Voltar à prévia</button></div>';
    this.render.querySelector('button').addEventListener('click', () => this.fecharRender());
    raiz.appendChild(this.render);
    this.ativa = 0;
    this.segmentos = []; this.cues = []; this.clipes = []; this.transicoes = [];
    this.i = 0;
    this.tocando = false;
    this.partiu = false;
    this.espera = 0;
    this.antes = 0;
    this.fxAtiva = null;
    this.relogio = null;     // setInterval: rAF para em aba escondida e a troca de lente perderia a emenda
    this._laco = this._laco.bind(this);
  }

  carregar({ clipes, segmentos, cues, transicoes = [] }) {
    this.clipes = clipes; this.segmentos = segmentos; this.cues = cues;
    this.transicoes = [...transicoes].sort((a, b) => a.inicio - b.inicio);
    this.pausar();
    this.i = 0;
    this.ativa = 0;
    this._mirar(0, 0, 0);
    this._mirarProxima();
    this._mostrar(0);
    this._pintar(0);
  }

  get duracao() { return this.segmentos.length ? this.segmentos[this.segmentos.length - 1].saidaAte : 0; }

  _lente(k) { return this.lentes[k]; }

  // aponta a lente k para o trecho iSeg, `antes` segundos antes do ponto de entrada
  _mirar(k, iSeg, antes) {
    const seg = this.segmentos[iSeg];
    const v = this._lente(k);
    if (!seg) { v.pause(); v.dataset.seg = ''; return 0; }
    const url = this.clipes[seg.clipe].url;
    if (v.dataset.url !== url) { v.src = url; v.dataset.url = url; }
    const folga = Math.min(antes, seg.de);
    const alvo = seg.de - folga;
    if (Math.abs(v.currentTime - alvo) > 0.04) v.currentTime = alvo;
    v.dataset.seg = String(iSeg);
    return folga;
  }

  _mirarProxima() {
    const k = 1 - this.ativa;
    const w = this._lente(k);
    w.pause(); w.muted = true;
    this.antes = this._mirar(k, this.i + 1, PARTIDA);
    this.partiu = false;
    this.espera = 0;
  }

  _mostrar(k) {
    this.ativa = k;
    this.lentes.forEach((v, j) => { v.style.zIndex = j === k ? 2 : 1; v.style.opacity = j === k ? 1 : 0; });
  }

  tempoAtual() {
    const seg = this.segmentos[this.i];
    if (!seg) return 0;
    const v = this._lente(this.ativa);
    return seg.saidaDe + Math.min(Math.max(v.currentTime - seg.de, 0), seg.dur);
  }

  // onde a prévia está, em termos do BRUTO (clipe + segundo) — sobrevive a replanejar
  posicaoFonte() {
    const seg = this.segmentos[this.i];
    if (!seg) return null;
    const v = this._lente(this.ativa);
    return { clipe: seg.clipe, t: Math.min(Math.max(v.currentTime, seg.de), seg.ate) };
  }

  _pintar(t) {
    const c = cueEm(this.cues, t);
    const texto = c ? c.texto : '';
    if (this._texto !== texto) {
      this._texto = texto;
      if (this.formatar) this.legenda.innerHTML = this.formatar(texto); else this.legenda.textContent = texto;
    }
    if (this.posicaoDe) {
      const p = this.posicaoDe(c);
      const k = `${p.x.toFixed(4)}|${p.y.toFixed(4)}`;
      if (k !== this._pos) { this._pos = k; this.legenda.style.left = `${p.x * 100}%`; this.legenda.style.top = `${p.y * 100}%`; }
    }
    this.aoTempo?.(t);
  }

  // o estilo mudou: desenha a legenda atual de novo
  repintar() { this._texto = null; this._pintar(this.tempoAtual()); }

  // guias durante o arrasto da legenda (x, y em frações; centro = ímã ativo no eixo)
  mostrarGuia(x, y, texto, noCentro) {
    this.guia.hidden = false;
    this.guia.querySelector('.h').style.top = `${y * 100}%`;
    this.guia.querySelector('.v').hidden = !noCentro;
    const b = this.guia.querySelector('b'); b.textContent = texto; b.style.top = `${y * 100}%`;
  }
  fecharGuia() { this.guia.hidden = true; }

  _fxDesligar() {
    this.fxAtiva = null;
    this.fx.pause();
    this.fxCanvas.style.opacity = 0;
  }

  // compõe base + transição no canvas (cover nos dois), em "screen"
  _fxPintar() {
    const c = this.fxCanvas, ctx = this.fxCtx, W = c.width, H = c.height;
    const base = this._lente(this.ativa);
    const cobrir = (sw, sh) => { const e = Math.max(W / sw, H / sh); const dw = sw * e, dh = sh * e; return [(W - dw) / 2, (H - dh) / 2, dw, dh]; };
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (base.videoWidth) ctx.drawImage(base, ...cobrir(base.videoWidth, base.videoHeight));
    if (this.fx.videoWidth && this.fx.readyState >= 2) {
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(this.fx, ...cobrir(this.fx.videoWidth, this.fx.videoHeight));
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // liga a transição cujo intervalo cobre t (e desliga quando passa)
  _fx(t) {
    const inst = this.transicoes.find(x => t >= x.inicio - 0.05 && t < x.inicio + x.dur);
    if (inst && this.fxAtiva !== inst) {
      this.fxAtiva = inst;
      const f = this.fx;
      if (f.dataset.url !== inst.clipe.url) { f.src = inst.clipe.url; f.dataset.url = inst.clipe.url; }
      f.currentTime = (inst.entrada || 0) + Math.max(0, t - inst.inicio);
      f.muted = false;
      f.play().catch(() => {});
      this.fxCanvas.style.opacity = 1;
    } else if (!inst && this.fxAtiva) {
      this._fxDesligar();
    }
    if (this.fxAtiva) this._fxPintar();
  }

  // blob null = ainda renderizando (só o rótulo muda; sem src vazio, que o WebKit acusa como erro)
  mostrarRender(blob, rotulo) {
    this.pausar();
    const v = this.render.querySelector('video');
    this.render.querySelector('span').textContent = rotulo;
    this.render.hidden = false;
    if (!blob) return;
    if (v.dataset.url) URL.revokeObjectURL(v.dataset.url);
    const url = URL.createObjectURL(blob);
    v.src = url; v.dataset.url = url;
    v.play().catch(() => {});
  }

  fecharRender() {
    const v = this.render.querySelector('video');
    v.pause();
    this.render.hidden = true;
  }

  async tocar() {
    this.fecharRender();
    if (!this.segmentos.length || this.tocando) return;
    this.tocando = true;
    const v = this._lente(this.ativa);
    v.muted = false;
    try { await v.play(); } catch {}
    clearInterval(this.relogio);
    this.relogio = setInterval(this._laco, 20);
  }

  pausar() {
    this.tocando = false;
    clearInterval(this.relogio); this.relogio = null;
    this.lentes.forEach(v => v.pause());
    this._fxDesligar();
    if (this.partiu) this._mirarProxima();
  }

  irPara(t) {
    t = Math.max(0, Math.min(t, this.duracao - 0.01));
    let i = this.segmentos.findIndex(s => t >= s.saidaDe && t < s.saidaAte);
    if (i < 0) i = this.segmentos.length - 1;
    const seg = this.segmentos[i];
    const estava = this.tocando;
    this.tocando = false;
    clearInterval(this.relogio); this.relogio = null;
    this.lentes.forEach(v => v.pause());
    this._fxDesligar();
    this.i = i;
    const v = this._lente(this.ativa);
    const url = this.clipes[seg.clipe].url;
    if (v.dataset.url !== url) { v.src = url; v.dataset.url = url; }
    v.dataset.seg = String(i);
    v.currentTime = seg.de + (t - seg.saidaDe);
    this._mirarProxima();
    this._pintar(t);
    if (estava) this.tocar();
  }

  _laco() {
    if (!this.tocando) { clearInterval(this.relogio); this.relogio = null; return; }
    const seg = this.segmentos[this.i];
    if (!seg) { this.pausar(); return; }
    const v = this._lente(this.ativa);
    const w = this._lente(1 - this.ativa);
    const prox = this.segmentos[this.i + 1];
    const t = v.currentTime;

    if (prox && !this.partiu && t >= seg.ate - this.antes) {
      this.partiu = true;
      w.muted = true;
      w.play().catch(() => {});
    }

    if (t >= seg.ate - FOLGA || v.ended) {
      if (!prox) {
        this.pausar();
        this._pintar(this.duracao);
        this.aoFim?.();
        return;
      }
      v.pause();
      const chegou = w.currentTime >= prox.de - 0.05 || w.paused || this.espera >= ESPERA_MAX;
      if (!chegou) {
        this.espera++;
        this._pintar(seg.saidaAte);
        this._fx(seg.saidaAte);
        return;
      }
      this.i += 1;
      const k = 1 - this.ativa;
      if (w.paused || Math.abs(w.currentTime - prox.de) > 0.25) { w.currentTime = prox.de; w.play().catch(() => {}); }
      this._mostrar(k);
      w.muted = false;
      v.muted = true;
      this._mirarProxima();
    }
    const agora = this.tempoAtual();
    this._pintar(agora);
    this._fx(agora);
  }
}
