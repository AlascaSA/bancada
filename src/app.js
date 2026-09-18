// Bancada — orquestra: brutos → áudio → transcrição → cortes → legendas → revisão → MP4.
import { abrirClipe, miniaturas, audioMono16k, primeiroQuadro, abrirTransicao } from './media.js';
import { envelope, limiarOtsu, silencios, fracaoFala, Energia } from './energy.js';
import { wav16, transcrever, transcreverFatiado } from './transcribe.js';
import { planejarCortes, montarSegmentos, corteManual, ROTULO, reservarIds } from './cuts.js';
import { listar, carregar, gravar, gravarMidia, apagar, urlMidia, novoId, empacotarEnvelope, desempacotarEnvelope, mesmoArquivo, haQuanto } from './projetos.js';
import { legendar, larguraVisual, cueEm, posicaoLegenda, separarDestaque } from './captions.js';
import { renderizar, verificarCodecs, recortarJanela } from './render.js';
import { Previa } from './preview.js';
import { revisarTentativas } from './revisao.js';

const $ = s => document.querySelector(s);
const PX_POR_S = 32;
const PROFESSORES = ['jaylton', 'pablo', 'andre'];
// fontes empacotadas em fonts/ (OFL) + as do sistema; pesos = instâncias que existem de verdade
const FONTES = [
  { id: 'Inter', pesos: [300, 400, 500, 600, 700, 800, 900] },
  { id: 'Montserrat', pesos: [300, 400, 500, 600, 700, 800, 900] },
  { id: 'Poppins', pesos: [300, 400, 600, 700, 800] },
  { id: 'Roboto', pesos: [300, 400, 500, 700, 900] },
  { id: 'Helvetica', reserva: 'Arial, sans-serif', pesos: [400, 700] },
];
const NOME_PESO = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

const E = {
  professor: 'jaylton', preset: null, presets: {},
  clipes: [], cortes: [], segmentos: [], cues: [],
  fase: 'vazio', alteracoes: 0, edicoes: new Map(), cueAtiva: 0,
  estilo: {},                             // ajustes do editor por cima do preset.legenda (fonte, peso, tamanho…), por professor
  projeto: null,                          // {id, nome, criadoEm, editadoEm, midiaEm} — o projeto aberto (autosave em /api/projetos)
  pedido: null,                           // projeto escolhido na lista esperando os brutos: {proj, tem: File[]}
  quem: (() => { try { return localStorage.getItem('bancada.quem') || ''; } catch { return ''; } })(),
  legendaBloco: { dx: 0, dy: 0 },        // deslocamento de TODAS as legendas (frações da saída)
  deslocs: new Map(),                     // deslocamento próprio de uma legenda, por chave no bruto
  modoMover: 'todas',                     // arrasto na prévia: 'todas' (bloco) ou 'uma' (só a atual)
  transicoes: [], emendaFx: new Map(),   // biblioteca de overlays; por emenda: {id, deslocamento, entrada, dur}
  revisao: {},                            // tentativas abandonadas que a IA apontou (por clipe) — entra no planejador e no projeto salvo
  fluxo: null,                            // projeto vindo do robô: {etapa: 'editor'|'final'|'entregue', bruto, saida, pedirRender, historico…}
  feedback: [],                           // correções da equipe nos cortes, com o porquê — diário que vira regra
  reportes: [],                           // erros reportados num ponto do vídeo: {quando, quem, tipo, texto, tSaida, clipe, tClipe, trecho}
  exemplos: [],                           // reportes/correções anteriores do professor (do diário) que entram no prompt da revisão por IA
  irPara: null,                           // veio do diário (?abrir=<id>&clipe=&t=): vai para esse ponto quando a mesa abrir
  regras: '',                             // regras do professor escritas pela equipe (entram na revisão por IA)
  robo: new URLSearchParams(location.search).has('robo'),   // sem gesto humano: o robô dirige a página pelo window.__bancada
  revisando: null,                        // projeto aberto no visualizador de revisão (sem os brutos)
  fxSelecionada: null,
  tempos: { solto: 0, etapas: {}, pronto: 0, exportar: 0, renderFim: 0, fim: 0 },
};
let previa, relogioId, abortar = null;

// ---------- utilidades
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; };
const fmtRel = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const agora = () => performance.now() / 1000;
const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };

async function etapa(nome, rotulo, fn) {
  marcarEtapa(nome, rotulo, 'agora');
  const t0 = agora();
  try {
    const r = await fn();
    E.tempos.etapas[nome] = agora() - t0;
    marcarEtapa(nome, rotulo, 'feita');
    return r;
  } catch (e) {
    marcarEtapa(nome, rotulo, 'erro');
    throw e;
  }
}
// texto miúdo dentro da etapa (clipe, %, pedaços) — para não parecer travado
function detalheEtapa(nome, texto) {
  const li = $('#etapas').querySelector(`[data-etapa="${nome}"]`);
  if (li) li.querySelector('.t').textContent = texto;
}
function marcarEtapa(nome, rotulo, estado) {
  const ol = $('#etapas');
  ol.hidden = false;
  let li = ol.querySelector(`[data-etapa="${nome}"]`);
  if (!li) { li = el('li'); li.dataset.etapa = nome; li.append(el('span', null, rotulo), el('span', 't')); ol.append(li); }
  li.className = estado;
  const t = E.tempos.etapas[nome];
  li.querySelector('.t').textContent = t != null ? `${t.toFixed(1)} s` : '';
}

// ---------- presets
async function carregarPresets() {
  for (const p of PROFESSORES) E.presets[p] = await (await fetch(`presets/${p}.json`)).json();
  const grupo = $('#professores');
  for (const p of PROFESSORES) {
    const pr = E.presets[p];
    const b = el('button', null);
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.professor = p;
    b.setAttribute('aria-checked', String(p === E.professor));
    b.title = pr.descricao;
    if (pr.foto) { const f = el('img', 'prof-foto'); f.src = pr.foto; f.alt = ''; f.width = 22; f.height = 22; b.append(f); }
    b.append(el('span', null, pr.nome));
    if (pr.teste) b.append(el('i', 'tag-teste', 'teste'));
    if (pr.pendente) b.disabled = true;
    b.addEventListener('click', () => escolherProfessor(p));
    grupo.append(b);
  }
  E.preset = E.presets[E.professor];
  aplicarPadrao(E.preset);
}
function escolherProfessor(p) {
  if (E.presets[p].pendente) return;
  E.professor = p; E.preset = E.presets[p];
  carregarRegras();
  $('#professores').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.professor === p)));
  aplicarPadrao(E.preset);
  if (E.fase === 'pronto') replanejar(true);
  else if (E.fase === 'vazio') desenharProjetos();
}
// Tema (cor do professor, a mesma da Central de Gravação), cartão do padrão e estilo da legenda da prévia.
function aplicarPadrao(pr) {
  const s = document.documentElement.style;
  document.documentElement.dataset.professor = pr.id;
  if (pr.tema) { s.setProperty('--brand', pr.tema.cor); s.setProperty('--brand-2', pr.tema.cor2 || pr.tema.cor); }
  $('#padraoNome').textContent = pr.nome;
  $('#padraoDesc').textContent = pr.descricao;
  const foto = $('#padraoFoto');
  if (foto) { foto.src = pr.foto || ''; foto.alt = pr.nome; }
  E.estilo = carregarEstilo(pr.id);
  aplicarEstilo();
}
// ---------- estilo da legenda: preset do professor + ajustes do editor (guardados por professor no navegador)
const estiloLegenda = () => ({ ...E.preset.legenda, ...E.estilo });
const presetAtual = () => ({ ...E.preset, legenda: estiloLegenda() });
function carregarEstilo(id) { try { return JSON.parse(localStorage.getItem(`bancada.estilo.${id}`) || '{}'); } catch { return {}; } }
function salvarEstilo() { try { if (Object.keys(E.estilo).length) localStorage.setItem(`bancada.estilo.${E.professor}`, JSON.stringify(E.estilo)); else localStorage.removeItem(`bancada.estilo.${E.professor}`); } catch {} }
const escapa = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// html da legenda na prévia e no espécime: com destaque, duas linhas (a de baixo em negrito)
function formatarLegenda(texto) {
  const L = estiloLegenda();
  if (!L.destaque) return escapa(texto);
  const [a, b] = separarDestaque(texto);
  return b == null ? `<span class="l2">${escapa(a)}</span>` : `<span class="l1">${escapa(a)}</span><span class="l2">${escapa(b)}</span>`;
}
function aplicarEstilo() {
  const L = estiloLegenda();
  aplicarEstiloLegenda(L);
  const esp = $('#padraoEspecime');
  if (esp) {
    esp.querySelector('.especime-texto').innerHTML = formatarLegenda('quando o cliente pergunta,');
    esp.querySelector('.apoio').textContent = `${L.fonte} ${NOME_PESO[L.peso] || L.peso}${L.destaque ? ` + ${NOME_PESO[L.destaque.peso] || L.destaque.peso} na linha de baixo` : ''} · ${Math.round(L.tamanho * E.preset.saida.largura)} px · ${Math.round(L.y * 100)}% da altura`;
  }
  desenharPainelEstilo();
  if (previa) { previa.repintar(); }
}
// A legenda da prévia é um <div> em CSS; o estilo do preset (mesmos números do render) entra por variáveis.
// cqw = fração da largura da prévia, igual ao `tamanho * W` do canvas.
function aplicarEstiloLegenda(L) {
  const s = document.documentElement.style, pc = v => `${(v * 100).toFixed(2)}cqw`;
  s.setProperty('--leg-fonte', `"${L.fonte}"${L.fonteReserva ? ', ' + L.fonteReserva : ''}`);
  s.setProperty('--leg-peso', String(L.peso));
  s.setProperty('--leg-cor', L.cor);
  s.setProperty('--leg-tam', pc(L.tamanho));
  s.setProperty('--leg-y', `${(L.y * 100).toFixed(1)}%`);
  s.setProperty('--leg-esp', `${L.espacamento}em`);
  s.setProperty('--leg-sombra', `0 ${pc(L.sombra.dy)} ${pc(L.sombra.blur)} ${L.sombra.cor}`);
  s.setProperty('--leg-peso2', String(L.destaque ? (L.destaque.peso || 800) : L.peso));
  s.setProperty('--leg-esc2', String(L.destaque ? (L.destaque.escala || 1) : 1));
  s.setProperty('--leg-entrelinha', String(L.entrelinha || 1.1));
  document.documentElement.classList.toggle('leg-destaque', !!L.destaque);
}

// painel "Estilo da legenda" (mesa): fonte, peso, tamanho, espaçamento, destaque, entrelinha
function desenharPainelEstilo() {
  const L = estiloLegenda(), fonte = FONTES.find(f => f.id === L.fonte) || FONTES[0];
  const sel = (id, opcoes, valor, rotulo = v => v) => {
    const el_ = $(id); el_.innerHTML = '';
    for (const o of opcoes) { const op = document.createElement('option'); op.value = o; op.textContent = rotulo(o); el_.append(op); }
    if (!opcoes.includes(valor)) { const op = document.createElement('option'); op.value = valor; op.textContent = rotulo(valor); el_.append(op); }
    el_.value = String(valor);
  };
  sel('#estFonte', FONTES.map(f => f.id), L.fonte);
  sel('#estPeso', fonte.pesos, L.peso, v => `${NOME_PESO[v] || v} ${v}`);
  $('#estTamanho').value = L.tamanho; $('#estTamanhoV').textContent = `${Math.round(L.tamanho * E.preset.saida.largura)} px`;
  $('#estEspaco').value = L.espacamento; $('#estEspacoV').textContent = `${Math.round(L.espacamento * 100)}%`;
  $('#estDestaque').checked = !!L.destaque;
  $('#estDestaqueOpcoes').hidden = !L.destaque;
  sel('#estPesoDestaque', fonte.pesos.filter(p => p >= 500), L.destaque ? (L.destaque.peso || 800) : 800, v => `${NOME_PESO[v] || v} ${v}`);
  $('#estEntrelinha').value = L.entrelinha || 1.1; $('#estEntrelinhaV').textContent = `${(L.entrelinha || 1.1).toFixed(2)}`;
  $('#btEstiloPadrao').disabled = !Object.keys(E.estilo).length;
}
function ligarPainelEstilo() {
  const muda = (k, v) => {
    const base = E.preset.legenda[k];
    if (JSON.stringify(v) === JSON.stringify(base)) delete E.estilo[k]; else E.estilo[k] = v;
    salvarEstilo(); aplicarEstilo();
    if (E.fase === 'pronto') { E.alteracoes++; desenharCues(); }
  };
  $('#estFonte').addEventListener('change', ev => {
    const f = FONTES.find(x => x.id === ev.target.value), L = estiloLegenda();
    muda('fonte', f.id);
    // reserva do sistema (Helvetica → Arial) e peso que a fonte tem de verdade
    if (f.reserva) E.estilo.fonteReserva = f.reserva; else if (E.preset.legenda.fonteReserva) E.estilo.fonteReserva = null; else delete E.estilo.fonteReserva;
    if (!f.pesos.includes(L.peso)) muda('peso', f.pesos.reduce((m, p) => Math.abs(p - L.peso) < Math.abs(m - L.peso) ? p : m));
    if (L.destaque && !f.pesos.includes(L.destaque.peso)) muda('destaque', { ...L.destaque, peso: f.pesos[f.pesos.length - 1] });
    salvarEstilo(); aplicarEstilo();
  });
  $('#estPeso').addEventListener('change', ev => muda('peso', +ev.target.value));
  $('#estTamanho').addEventListener('input', ev => muda('tamanho', +ev.target.value));
  $('#estEspaco').addEventListener('input', ev => muda('espacamento', +ev.target.value));
  $('#estDestaque').addEventListener('change', ev => {
    const f = FONTES.find(x => x.id === estiloLegenda().fonte) || FONTES[0];
    muda('destaque', ev.target.checked ? (E.preset.legenda.destaque || { peso: f.pesos[f.pesos.length - 1], escala: 1 }) : null);
    muda('linhas', ev.target.checked ? 2 : 1);
  });
  $('#estPesoDestaque').addEventListener('change', ev => muda('destaque', { ...(estiloLegenda().destaque || {}), peso: +ev.target.value }));
  $('#estEntrelinha').addEventListener('input', ev => muda('entrelinha', +ev.target.value));
  $('#btEstiloPadrao').addEventListener('click', () => { E.estilo = {}; salvarEstilo(); aplicarEstilo(); if (E.fase === 'pronto') { E.alteracoes++; desenharCues(); } });
}

// tira de filme vazia: 01 sólido, 02-04 tracejados, o quinto é "quantos forem"
function slotsVazios() {
  const raiz = $('#slots'); raiz.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const d = el('div', 'slot' + (i === 0 ? ' primeiro' : '') + (i === 4 ? ' mais' : ''));
    d.style.setProperty('--i', i);
    d.append(el('span', null, i === 4 ? '…' : String(i + 1).padStart(2, '0')));
    raiz.append(d);
  }
}
function slotCheio(i, clipe, quadro) {
  const raiz = $('#slots');
  if (i === 0) raiz.innerHTML = '';
  const d = el('div', 'slot cheio'); d.style.setProperty('--i', i);
  if (quadro) d.append(quadro);
  d.append(el('span', 'num', String(i + 1).padStart(2, '0')), el('span', 'dur tnum', fmt(clipe.duracao)));
  raiz.append(d);
  raiz.style.gridTemplateColumns = `repeat(${Math.max(5, i + 1)}, minmax(0, 1fr))`;
}

// ---------- entrada
function ordenar(files) {
  const num = f => { const m = f.name.match(/(\d+)/); return m ? parseInt(m[1], 10) : Infinity; };
  return [...files].sort((a, b) => num(a) - num(b) || a.name.localeCompare(b.name));
}
const entrar = files => E.pedido ? receberParaProjeto(files) : receber(files);
async function receber(files) {
  files = ordenar([...files].filter(f => /\.(mp4|mov|m4v|webm)$/i.test(f.name) || f.type.startsWith('video/')));
  if (!files.length) return mostrarErro('Nenhum vídeo entre os arquivos soltos.');
  if (E.fase !== 'vazio') return;
  E.fase = 'lendo';
  E.tempos.solto = agora();
  $('#soltaTexto').hidden = true;
  $('#solta').classList.add('ocupada');
  $('#solta').removeAttribute('role'); $('#solta').removeAttribute('tabindex');
  $('#erro').hidden = true;
  const ol = $('#brutos'); ol.hidden = false; ol.innerHTML = '';
  // as cinco etapas aparecem de uma vez, como uma régua; cada uma acende na sua hora
  for (const [n, r] of [['ler', 'Lendo os brutos'], ['audio', 'Ouvindo o áudio'], ['transcrever', 'Transcrevendo'], ['cortar', 'Cortando'], ['revisar', 'Revisando'], ['legendar', 'Legendando']]) marcarEtapa(n, r, 'pendente');
  try {
    await etapa('ler', 'Lendo os brutos', async () => {
      for (const [i, f] of files.entries()) {
        const c = await abrirClipe(f);
        if (!c.podeDecodificar) throw new Error(`${f.name}: o navegador não decodifica este vídeo.`);
        E.clipes.push(c);
        slotCheio(i, c, await primeiroQuadro(c));
        const li = el('li');
        li.append(el('span', 'num tnum', String(i + 1).padStart(2, '0')), (() => {
          const d = el('div'); d.append(el('div', 'nome', c.nome), el('div', 'meta', `${c.largura}×${c.altura} · ${c.fps.toFixed(2)} fps · ${fmt(c.duracao)}`)); return d;
        })(), el('span', 'apoio tnum', `${(f.size / 1e6).toFixed(1)} MB`));
        ol.append(li);
      }
    });
    await etapa('audio', 'Ouvindo o áudio', async () => {
      for (const [i, c] of E.clipes.entries()) {
        const rotulo = E.clipes.length > 1 ? `${String(i + 1).padStart(2, '0')} · ` : '';
        detalheEtapa('audio', `${rotulo}decodificando o áudio`);
        const a = await audioMono16k(c);
        c.audio16 = a;
        const env = envelope(a.dados, a.taxa);
        const limiar = limiarOtsu(env);
        c.energia = new Energia(env, limiar);
        c.silencios = silencios(env, limiar);
        c.semFala = fracaoFala(env, limiar) < 0.05;
        c.thumbs = await miniaturas(c, 74, 1, f => detalheEtapa('audio', `${rotulo}miniaturas ${Math.round(f * 100)}%`));
      }
      detalheEtapa('audio', '');
    });
    await etapa('transcrever', 'Transcrevendo', async () => {
      const total = E.clipes.filter(c => !c.semFala).length;
      let feitos = 0;
      await Promise.all(E.clipes.map(async (c, i) => {
        if (c.semFala) { c.palavras = []; return; }
        const rotulo = E.clipes.length > 1 ? `${String(i + 1).padStart(2, '0')} · ` : '';
        // o mesmo bruto transcrito de novo tem que dar as MESMAS palavras: o whisper varia entre rodadas e isso
        // mudava os cortes de um vídeo que já estava bom. A transcrição fica guardada por arquivo (nome + tamanho +
        // duração + versão do processo); reabrir um bruto conhecido não gasta Groq
        const chave = await chaveTranscricao(c);
        const guardada = chave ? await lerTranscricao(chave) : null;
        if (guardada) { c.palavras = guardada.palavras; c.texto = guardada.texto; c.recuperadas = guardada.recuperadas || 0; c.transcricaoGuardada = true; detalheEtapa('transcrever', `${rotulo}transcrição guardada`); feitos++; return; }
        const fatias = c.energia.fatias(c.duracao);
        const r = await transcreverFatiado(c.audio16.dados, c.audio16.taxa, fatias, { energia: c.energia, aoProgredir: (n, m, fase) => detalheEtapa('transcrever', fase === 'reouvindo' ? `${rotulo}reouvindo ${n} de ${m} trechos engolidos` : `${rotulo}${n} de ${m} pedaços`) });
        c.palavras = r.palavras;
        c.texto = r.texto;
        c.recuperadas = r.recuperadas || 0;
        if (chave) guardarTranscricao(chave, { palavras: c.palavras, texto: c.texto, recuperadas: c.recuperadas }).catch(e => console.warn('guardar transcrição', e));
        feitos++;
        if (total > 1) detalheEtapa('transcrever', `${feitos} de ${total} brutos`);
      }));
      detalheEtapa('transcrever', '');
    });
    await etapa('cortar', 'Cortando', async () => { E.cortes = planejarCortes(E.clipes, E.preset); E.segmentos = montarSegmentos(E.clipes, E.cortes); });
    // onde ele "caçou" a frase (3+ refeituras encadeadas), a IA lê o trecho e fica só com a última tomada de cada ideia
    await etapa('revisar', 'Revisando', async () => {
      E.revisao = await revisarTentativas(E.clipes, E.cortes, { aoProgredir: (n, m) => detalheEtapa('revisar', `${n} de ${m} trechos`), regras: E.regras, exemplos: E.exemplos });
      if (Object.keys(E.revisao).length) { E.cortes = planejarCortes(E.clipes, E.preset, E.revisao); E.segmentos = montarSegmentos(E.clipes, E.cortes); }
      detalheEtapa('revisar', '');
    });
    await etapa('legendar', 'Legendando', async () => { E.cues = legendar(E.clipes, E.segmentos, E.preset); });
  } catch (e) {
    console.error(e);
    mostrarErro(e.message || String(e));
    E.fase = 'erro';
    return;
  }
  E.fase = 'pronto';
  E.tempos.pronto = agora();
  E.projeto = { id: novoId(), nome: E.robo ? files[0].name.replace(/\.[^.]+$/, '') : nomePadraoProjeto(), criadoEm: Date.now(), editadoEm: 0, midiaEm: 0 };
  abrirMesa();
  iniciarAutosave();
}
function mostrarErro(m) { $('#erroTexto').textContent = m; $('#erro').hidden = false; }

// ---------- mesa
function abrirMesa() {
  $('#entrada').hidden = true;
  $('#mesa').hidden = false;
  $('#projetoCab').hidden = false;
  $('#projetoNome').value = E.projeto?.nome || '';
  desenharFluxo();
  $('#reporteMesa').hidden = true;
  listaReportes($('#mesaReportes'), E.reportes, r => previa?.irPara(tempoSaidaDe(E.segmentos, r.clipe, r.tClipe)));
  if (!previa) {
    previa = new Previa($('#previa'), aoTempoPrevia);
    previa.posicaoDe = c => posicaoLegenda(c, estiloLegenda(), E.legendaBloco);
    previa.formatar = formatarLegenda;
    ligarArrastoLegenda();
  }
  previa.aoFim = () => alternarPlay(false);
  desenharTudo();
  atualizarTempos();
}
function replanejar(tudo) {
  // a prévia não volta ao começo: guarda onde estava (no BRUTO) e a rolagem da fita
  const pos = previa ? previa.posicaoFonte() : null;
  const rolagem = $('#fita').scrollLeft;
  if (tudo) E.cortes = planejarCortes(E.clipes, E.preset, E.revisao);
  E.segmentos = montarSegmentos(E.clipes, E.cortes);
  E.cues = legendar(E.clipes, E.segmentos, E.preset);
  for (const c of E.cues) { const k = chave(c); if (E.edicoes.has(k)) { c.texto = E.edicoes.get(k); c.editada = true; } if (E.deslocs.has(k)) c.desloc = E.deslocs.get(k); }
  desenharTudo();
  if (pos) previa.irPara(saidaDeFonte(pos.clipe, pos.t));
  $('#fita').scrollLeft = rolagem;
}
// tempo de saída correspondente a um ponto do bruto (se caiu num corte, o trecho seguinte)
function saidaDeFonte(ci, t) {
  const s = E.segmentos.find(x => x.clipe === ci && t >= x.de && t < x.ate);
  if (s) return s.saidaDe + (t - s.de);
  const prox = E.segmentos.find(x => x.clipe === ci && x.de >= t) || E.segmentos.find(x => x.clipe > ci);
  return prox ? prox.saidaDe : 0;
}
// emenda = fronteira entre dois trechos consecutivos; a chave vive no bruto (sobrevive a liga/desliga)
const chaveEmenda = segA => `${segA.clipe}|${segA.ate.toFixed(2)}`;
// entrada padrão de uma transição numa emenda: inteira, centrada na emenda
function novaFx(tr) { return { id: tr.id, deslocamento: -tr.duracao / 2, entrada: 0, dur: tr.duracao }; }
function instanciasFx() {
  const out = [];
  for (let i = 1; i < E.segmentos.length; i++) {
    const a = E.segmentos[i - 1];
    const fx = E.emendaFx.get(chaveEmenda(a));
    const tr = fx && E.transicoes.find(x => x.id === fx.id);
    if (tr) out.push({ inicio: a.saidaAte + fx.deslocamento, dur: fx.dur, entrada: fx.entrada, clipe: tr, chave: chaveEmenda(a), fx, emenda: a.saidaAte });
  }
  return out;
}
const chave = c => `${c.segmento.clipe}|${(c.segmento.de + (c.de - c.segmento.saidaDe)).toFixed(2)}`;

function desenharTudo() {
  desenharFita();
  desenharCortes();
  desenharCues();
  previa.carregar({ clipes: E.clipes, segmentos: E.segmentos, cues: E.cues, transicoes: instanciasFx() });
  const dur = previa.duracao;
  const bruto = E.clipes.reduce((s, c) => s + c.duracao, 0);
  $('#fitaResumo').textContent = `${E.clipes.length} brutos · ${fmt(bruto)} → ${fmt(dur)} no ar · clique vai ao ponto, arrastar marca corte`;
  $('#tempoPrevia').textContent = `0:00,0 / ${fmt(dur).replace('.', ',')}`;
  $('#scrub').value = 0;
}

function desenharFita() {
  const fita = $('#fita'); fita.innerHTML = '';
  const camada = el('div', 'camada-fx'); camada.id = 'camadaFx';
  camada.append(el('span', 'camada-rotulo', 'transições'));
  fita.append(camada);
  const trilhos = el('div', 'trilhos'); fita.append(trilhos);
  E.clipes.forEach((c, ci) => {
    const trilho = el('div', 'trilho');
    const w = Math.max(8, Math.round(c.duracao * PX_POR_S));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = 74;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#1b212b'; ctx.fillRect(0, 0, w, 74);
    for (const th of c.thumbs) {
      const x = Math.round(th.t * PX_POR_S) - Math.round(PX_POR_S / 2);
      const esc = 74 / th.canvas.height, tw = th.canvas.width * esc;
      ctx.drawImage(th.canvas, x, 0, tw, 74);
    }
    trilho.style.width = `${w}px`;
    trilho.append(cv, el('span', 'rotulo', String(ci + 1).padStart(2, '0')));
    for (const k of E.cortes.filter(x => x.clipe === ci)) {
      const m = el('div', 'corte-mapa' + (k.ligado ? '' : ' solto') + (k.tipo === 'manual' ? ' manual' : ''));
      m.style.left = `${k.de * PX_POR_S}px`; m.style.width = `${Math.max(3, k.dur * PX_POR_S)}px`;
      m.title = `${ROTULO[k.tipo]} · ${k.dur.toFixed(1)} s · clique para ${k.ligado ? 'manter' : 'cortar'} · arraste para marcar outro corte`;
      m._corte = k;   // o clique no marcador liga/desliga; o arrasto começa em qualquer lugar da fita, inclusive em cima de um corte
      trilho.append(m);
    }
    // clique = ir para o ponto (ou ligar/desligar, se foi num corte); arrastar = marcar um corte novo (do editor),
    // começando onde for — também por cima de um corte desligado (senão não dava para fazer o corte do tamanho certo)
    let arrasto = null;
    trilho.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      const x0 = (ev.clientX - trilho.getBoundingClientRect().left) / PX_POR_S;
      arrasto = { x0, x1: x0, caixa: null, marcador: ev.target.closest('.corte-mapa') };
      trilho.setPointerCapture(ev.pointerId);
    });
    trilho.addEventListener('pointermove', ev => {
      if (!arrasto) return;
      arrasto.x1 = Math.max(0, Math.min(c.duracao, (ev.clientX - trilho.getBoundingClientRect().left) / PX_POR_S));
      if (Math.abs(arrasto.x1 - arrasto.x0) * PX_POR_S < 4) return;
      if (!arrasto.caixa) { arrasto.caixa = el('div', 'selecao'); trilho.append(arrasto.caixa); }
      const a = Math.min(arrasto.x0, arrasto.x1), b = Math.max(arrasto.x0, arrasto.x1);
      arrasto.caixa.style.left = `${a * PX_POR_S}px`; arrasto.caixa.style.width = `${(b - a) * PX_POR_S}px`;
    });
    trilho.addEventListener('pointerup', ev => {
      if (!arrasto) return;
      const { x0, x1, caixa, marcador } = arrasto; arrasto = null;
      caixa?.remove();
      if (Math.abs(x1 - x0) >= 0.15) {
        const km = corteManual(ci, x0, x1); E.cortes.push(km); anotarFeedback(km, 'cortou à mão', 'a IA não viu');
        E.cortes.sort((p, q) => p.clipe - q.clipe || p.de - q.de);
        E.alteracoes++;
        replanejar(false);
        return;
      }
      if (marcador?._corte) { alternarCorte(marcador._corte); return; }
      const x = x0;
      const seg = E.segmentos.find(s => s.clipe === ci && x >= s.de && x < s.ate) || E.segmentos.find(s => s.clipe === ci && s.de >= x) || E.segmentos.find(s => s.clipe === ci);
      if (seg) previa.irPara(seg.saidaDe + Math.min(Math.max(x - seg.de, 0), seg.dur));
    });
    trilhos.append(trilho);
  });
  const agulha = el('div', 'agulha'); agulha.id = 'agulha'; fita.append(agulha);
  camada.style.width = `${trilhos.scrollWidth + 24}px`;
  desenharMarcasFx();
}

// emendas da fita com a posição em px (fim do trecho A e começo do trecho B)
function emendasNaFita() {
  const trilhos = $('#fita').querySelectorAll('.trilho');
  const out = [];
  for (let i = 1; i < E.segmentos.length; i++) {
    const a = E.segmentos[i - 1], b = E.segmentos[i];
    const ta = trilhos[a.clipe], tb = trilhos[b.clipe];
    if (!ta || !tb) continue;
    out.push({ chave: chaveEmenda(a), a, b, xA: ta.offsetLeft + a.ate * PX_POR_S, xB: tb.offsetLeft + b.de * PX_POR_S });
  }
  return out;
}
function emendaMaisPerto(x, limite = 48) {
  let melhor = null, dist = Infinity;
  for (const e of emendasNaFita()) {
    const d = x >= Math.min(e.xA, e.xB) && x <= Math.max(e.xA, e.xB) ? 0 : Math.min(Math.abs(x - e.xA), Math.abs(x - e.xB));
    if (d < dist) { dist = d; melhor = e; }
  }
  return dist <= limite ? melhor : null;
}
// blocos na camada de cima: um por emenda com transição. Arrastar move (deslocamento),
// as bordas aparam (entrada / duração), clique seleciona, Delete tira, duplo clique mostra como fica.
function desenharMarcasFx() {
  const camada = $('#camadaFx');
  if (!camada) return;
  camada.querySelectorAll('.fx-bloco').forEach(m => m.remove());
  for (const e of emendasNaFita()) {
    const fx = E.emendaFx.get(e.chave);
    const tr = fx && E.transicoes.find(t => t.id === fx.id);
    if (!tr) continue;
    const b = el('div', 'fx-bloco' + (E.fxSelecionada === e.chave ? ' selecionado' : ''));
    b.tabIndex = 0;
    b.dataset.chave = e.chave;
    b.append(el('i', 'borda esq'), el('span', 'nome', tr.nome.replace(/\.[^.]+$/, '')), el('span', 'tempo tnum'), el('i', 'borda dir'));
    posicionarBloco(b, e, fx);
    b.title = 'Arraste para mover · bordas aparam · duplo clique mostra como fica · Delete tira';
    b.addEventListener('pointerdown', ev => iniciarArrastoBloco(ev, b, e, fx, tr));
    b.addEventListener('dblclick', ev => { ev.stopPropagation(); verEmenda(e.chave); });
    b.addEventListener('keydown', ev => { if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); E.emendaFx.delete(e.chave); E.fxSelecionada = null; E.alteracoes++; replanejar(false); } });
    camada.append(b);
  }
}
function posicionarBloco(b, e, fx) {
  b.style.left = `${e.xA + fx.deslocamento * PX_POR_S}px`;
  b.style.width = `${Math.max(18, fx.dur * PX_POR_S)}px`;
  const rel = fx.deslocamento + fx.dur / 2;   // onde o centro cai em relação à emenda
  b.querySelector('.tempo').textContent = `${fx.dur.toFixed(1)} s${Math.abs(rel) >= 0.05 ? ` · ${rel > 0 ? '+' : '−'}${Math.abs(rel).toFixed(1)}` : ''}`;
}
function iniciarArrastoBloco(ev, b, e, fx, tr) {
  if (ev.button !== 0) return;
  ev.stopPropagation(); ev.preventDefault();
  E.fxSelecionada = e.chave;
  document.querySelectorAll('.fx-bloco.selecionado').forEach(x => x.classList.remove('selecionado'));
  b.classList.add('selecionado'); b.focus();
  const modo = ev.target.classList.contains('esq') ? 'esq' : ev.target.classList.contains('dir') ? 'dir' : 'mover';
  const x0 = ev.clientX, d0 = fx.deslocamento, en0 = fx.entrada, du0 = fx.dur;
  let mexeu = false;
  b.setPointerCapture(ev.pointerId);
  b.classList.add('arrastando');
  const mover = mv => {
    const dx = (mv.clientX - x0) / PX_POR_S;
    if (Math.abs(mv.clientX - x0) > 2) mexeu = true;
    if (modo === 'mover') {
      let d = d0 + dx;
      const centro = d + fx.dur / 2;                       // ímã: centro na emenda
      if (Math.abs(centro) * PX_POR_S < 5) d = -fx.dur / 2;
      fx.deslocamento = d;
    } else if (modo === 'dir') {
      fx.dur = Math.min(tr.duracao - fx.entrada, Math.max(0.2, du0 + dx));
    } else {
      const corte = Math.max(-en0, Math.min(du0 - 0.2, dx)); // aparar pela esquerda: entra mais tarde no arquivo
      fx.entrada = en0 + corte; fx.deslocamento = d0 + corte; fx.dur = du0 - corte;
    }
    posicionarBloco(b, e, fx);
  };
  const soltar = () => {
    b.removeEventListener('pointermove', mover);
    b.removeEventListener('pointerup', soltar);
    b.removeEventListener('pointercancel', soltar);
    b.classList.remove('arrastando');
    if (mexeu) { E.alteracoes++; previa.carregar({ clipes: E.clipes, segmentos: E.segmentos, cues: E.cues, transicoes: instanciasFx() }); previa.irPara(Math.max(0, e.a.saidaAte + fx.deslocamento - 0.3)); }
  };
  b.addEventListener('pointermove', mover);
  b.addEventListener('pointerup', soltar);
  b.addEventListener('pointercancel', soltar);
}
// Renderiza só o entorno da emenda (1,5 s antes, 2 s depois) pelo caminho do export e mostra em loop.
async function verEmenda(chaveE) {
  const i = E.segmentos.findIndex((x, k) => k > 0 && chaveEmenda(E.segmentos[k - 1]) === chaveE);
  if (i < 1) return;
  const T = E.segmentos[i - 1].saidaAte;
  const de = Math.max(0, T - 1.5), ate = Math.min(previa.duracao, T + 2);
  const janela = recortarJanela({ segmentos: E.segmentos, cues: E.cues, transicoes: instanciasFx() }, de, ate);
  const a = E.segmentos[i - 1], b = E.segmentos[i];
  const rotulo = a.clipe === b.clipe ? `corte em ${fmt(T)} · renderizando…` : `emenda ${String(a.clipe + 1).padStart(2, '0')} → ${String(b.clipe + 1).padStart(2, '0')} · renderizando…`;
  previa.mostrarRender(null, rotulo);
  try {
    const blob = await renderizar({ clipes: E.clipes, ...janela, preset: presetAtual(), fps: E.clipes[0].fps, ajusteLegenda: E.legendaBloco });
    previa.mostrarRender(blob, rotulo.replace(' · renderizando…', ' · como vai ficar (loop)'));
  } catch (e) {
    console.error(e);
    previa.fecharRender();
    alert(`Não deu para renderizar o trecho: ${e.message}`);
  }
}
function soltarFxNaEmenda(id, x) {
  const e = emendaMaisPerto(x);
  const tr = E.transicoes.find(t => t.id === id);
  if (!e || !tr) return false;
  E.emendaFx.set(e.chave, novaFx(tr));
  E.fxSelecionada = e.chave;
  E.alteracoes++;
  replanejar(false);
  return true;
}
function ligarArrastoNaFita() {
  const fita = $('#fita');
  let alvo = null;
  const xDoEvento = ev => ev.clientX - fita.getBoundingClientRect().left + fita.scrollLeft;
  fita.addEventListener('dragover', ev => {
    const temFx = ev.dataTransfer.types.includes('text/bancada-fx'), temArq = ev.dataTransfer.types.includes('Files');
    if (!temFx && !temArq) return;
    ev.preventDefault(); ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'copy';
    const e = emendaMaisPerto(xDoEvento(ev));
    if (!alvo) { alvo = el('div', 'emenda-alvo'); alvo.append(el('span', null, 'transição aqui')); fita.append(alvo); }
    alvo.hidden = !e;
    if (e) alvo.style.left = `${e.xA}px`;
  });
  fita.addEventListener('dragleave', ev => { if (!fita.contains(ev.relatedTarget)) { alvo?.remove(); alvo = null; } });
  fita.addEventListener('drop', async ev => {
    const id = ev.dataTransfer.getData('text/bancada-fx');
    const arquivos = [...(ev.dataTransfer.files || [])].filter(f => /\.(mp4|mov|m4v|webm)$/i.test(f.name) || f.type.startsWith('video/'));
    if (!id && !arquivos.length) return;
    ev.preventDefault(); ev.stopPropagation();
    const x = xDoEvento(ev);
    alvo?.remove(); alvo = null;
    if (id) { soltarFxNaEmenda(id, x); return; }
    // arquivo vindo do Finder: vira transição da biblioteca e já cai na emenda mais perto
    await receberFx(arquivos);
    const nova = E.transicoes[E.transicoes.length - 1];
    if (nova && !soltarFxNaEmenda(nova.id, x)) desenharCortes();
  });
}

function alternarCorte(k) {
  if (k.tipo === 'manual') { E.cortes = E.cortes.filter(x => x !== k); esquecerFeedback(k, 'cortou à mão'); } // corte do editor desligado some
  else { k.ligado = !k.ligado; k._porque = !k.ligado; if (k.ligado) esquecerFeedback(k, 'manteve'); }
  E.alteracoes++;
  replanejar(false);
}
// ---------- feedback («não faz isso»): cada corte da IA que o editor desliga leva um porquê; cada corte à mão é «a IA não viu»
const PORQUES = ['era ênfase, não erro', 'era pausa boa', 'cortou cedo demais', 'cortou tarde demais', 'outro motivo…'];
const textoDoTrecho = k => (E.clipes[k.clipe]?.palavras || []).filter(w => w.ate > k.de && w.de < k.ate).map(w => w.texto).join(' ').slice(0, 160);
function anotarFeedback(k, acao, porque) {
  E.feedback.push({ quando: Date.now(), quem: E.quem || '', clipe: k.clipe, de: +k.de.toFixed(2), ate: +k.ate.toFixed(2), tipo: k.tipo, motivo: k.motivo || '', texto: textoDoTrecho(k), acao, porque });
  salvoAss = '';
}
function esquecerFeedback(k, acao) { E.feedback = E.feedback.filter(f => !(f.acao === acao && f.clipe === k.clipe && f.de === +k.de.toFixed(2))); salvoAss = ''; }
function linhaPorque(k) {
  const row = el('div', 'porque');
  row.append(el('span', 'apoio', 'Por quê?'));
  for (const p of PORQUES) {
    const b = el('button', 'porque-chip', p); b.type = 'button';
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      let porque = p;
      if (p.endsWith('…')) { const t = prompt('Qual foi o motivo?', ''); if (t == null) return; porque = t.trim() || 'outro motivo'; }
      anotarFeedback(k, 'manteve', porque); k._porque = false; desenharCortes();
    });
    row.append(b);
  }
  const x = el('button', 'porque-fechar', '×'); x.type = 'button'; x.title = 'Sem motivo'; x.addEventListener('click', ev => { ev.stopPropagation(); k._porque = false; desenharCortes(); });
  row.append(x);
  return row;
}

function desenharCortes() {
  const ul = $('#cortes'); ul.innerHTML = '';
  const ligados = E.cortes.filter(k => k.ligado);
  const tirado = ligados.reduce((s, k) => s + k.dur, 0);
  $('#cortesResumo').textContent = E.cortes.length ? `${ligados.length} de ${E.cortes.length} · tira ${tirado.toFixed(1)} s` : '';
  desenharFxBiblioteca();
  if (!E.cortes.length && E.clipes.length < 2) { ul.append(el('li', 'vazio', 'Nenhuma pausa para cortar.')); return; }
  E.clipes.forEach((c, ci) => {
    for (const k of E.cortes.filter(x => x.clipe === ci)) {
      const li = el('li', 'corte-linha' + (k.ligado ? '' : ' desligado'));
      const sw = el('button', 'sw'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(k.ligado));
      sw.setAttribute('aria-label', `Cortar ${ROTULO[k.tipo]}`);
      sw.addEventListener('click', () => alternarCorte(k));
      const txt = el('div');
      txt.append(el('div', 'quando tnum', `${String(k.clipe + 1).padStart(2, '0')} · ${fmt(k.de)} → ${fmt(k.ate)}`), el('div', 'tipo' + (k.tipo === 'refeitura' || k.tipo === 'fala-nao-transcrita' || k.tipo === 'sobra' ? ' tipo-erro' : ''), `${ROTULO[k.tipo]} · ${k.dur.toFixed(1)} s${k.motivo && k.tipo !== 'pausa' && k.tipo !== 'pausa-frase' ? ' · ' + k.motivo : ''}`));
      li.append(sw, txt);
      // cabeça e rabo são a emenda entre brutos (linha própria abaixo); pausa e corte manual têm a sua
      const interno = k.tipo !== 'cabeca' && k.tipo !== 'rabo';
      if (k.ligado && interno) li.append(seletorFx(`${k.clipe}|${k.de.toFixed(2)}`));
      else li.append(el('span', 'apoio', k.ligado ? 'sai' : 'fica'));
      li.addEventListener('dblclick', () => irParaCorte(k));
      if (k._porque && !k.ligado) li.append(linhaPorque(k));
      ul.append(li);
    }
    if (ci < E.clipes.length - 1) {
      const ultimo = [...E.segmentos].reverse().find(x => x.clipe === ci);
      const li = el('li', 'corte-linha emenda-linha');
      const marca = el('span', 'emenda-marca'); marca.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><path d="M4 12h16M14 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const txt = el('div');
      txt.append(el('div', 'quando', `${String(ci + 1).padStart(2, '0')} → ${String(ci + 2).padStart(2, '0')}`), el('div', 'tipo', 'emenda entre brutos'));
      li.append(marca, txt, ultimo ? seletorFx(chaveEmenda(ultimo)) : el('span', 'apoio', ''));
      ul.append(li);
    }
  });
}
function seletorFx(chaveE) {
  const caixa = el('span', 'fx-caixa');
  const sel = seletorFxSelect(chaveE);
  caixa.append(sel);
  if (E.emendaFx.get(chaveE)) {
    const b = el('button', 'bt bt-mini bt-ver', 'Ver'); b.type = 'button'; b.title = 'Renderiza só este trecho e mostra como vai ficar';
    b.addEventListener('click', () => verEmenda(chaveE));
    caixa.append(b);
  }
  return caixa;
}
function seletorFxSelect(chaveE) {
  const sel = document.createElement('select');
  sel.className = 'fx-sel'; sel.setAttribute('aria-label', 'Transição nesta emenda');
  sel.append(new Option('sem transição', ''));
  for (const t of E.transicoes) sel.append(new Option(t.nome.replace(/\.[^.]+$/, ''), t.id));
  sel.value = E.emendaFx.get(chaveE)?.id || '';
  if (!E.transicoes.length) sel.title = 'Adicione transições no botão acima';
  sel.addEventListener('change', () => {
    const tr = E.transicoes.find(t => t.id === sel.value);
    if (tr) E.emendaFx.set(chaveE, novaFx(tr)); else E.emendaFx.delete(chaveE);
    E.alteracoes++;
    replanejar(false);
  });
  return sel;
}
function desenharFxBiblioteca() {
  const ul = $('#fxLista'); ul.innerHTML = '';
  for (const t of E.transicoes) {
    const li = el('li', 'fx-chip');
    if (t.thumb) li.append(t.thumb);
    li.append(el('span', null, t.nome.replace(/\.[^.]+$/, '')), el('span', 'apoio tnum', `${t.duracao.toFixed(1)} s`));
    li.title = `${t.largura}×${t.altura}${t.audio ? ' · com som' : ''} — arraste para uma emenda na fita`;
    li.draggable = true;
    li.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/bancada-fx', t.id); ev.dataTransfer.effectAllowed = 'copy'; li.classList.add('arrastando'); });
    li.addEventListener('dragend', () => li.classList.remove('arrastando'));
    ul.append(li);
  }
  $('#fxVazio').hidden = E.transicoes.length > 0;
  $('#btFxTodas').hidden = E.transicoes.length === 0 || E.clipes.length < 2;
}
async function receberFx(files) {
  for (const f of [...files]) {
    try { E.transicoes.push(await abrirTransicao(f)); }
    catch (e) { console.error(e); mostrarErro(`${f.name}: não deu para ler como transição.`); }
  }
  E.alteracoes++;
  desenharCortes();
}
// atalho: a mesma transição em todas as emendas entre brutos
function fxEmTodasEmendas() {
  const tr = E.transicoes[E.transicoes.length - 1];
  if (!tr) return;
  E.clipes.forEach((c, ci) => {
    if (ci >= E.clipes.length - 1) return;
    const ultimo = [...E.segmentos].reverse().find(x => x.clipe === ci);
    if (ultimo) E.emendaFx.set(chaveEmenda(ultimo), novaFx(tr));
  });
  E.alteracoes++;
  replanejar(false);
}
function irParaCorte(k) {
  const seg = E.segmentos.find(s => s.clipe === k.clipe && s.ate <= k.de + 0.01 && s.ate >= k.de - 0.6) || E.segmentos.find(s => s.clipe === k.clipe && s.de >= k.ate - 0.01);
  if (seg) previa.irPara(seg.ate <= k.de + 0.01 ? Math.max(seg.saidaDe, seg.saidaAte - 1.5) : seg.saidaDe);
}

function desenharCues() {
  const ul = $('#cues'); ul.innerHTML = '';
  $('#cuesResumo').textContent = E.cues.length ? `${E.cues.length} legendas · estilo ${E.preset.nome}` : '';
  if (!E.cues.length) { ul.append(el('li', 'vazio', 'Sem fala reconhecida.')); return; }
  for (const c of E.cues) {
    const li = el('li', 'cue-linha'); li.dataset.id = c.id;
    const q = el('button', 'quando tnum', fmt(c.de).replace('.', ',')); q.type = 'button'; q.style.cssText = 'border:0;background:none;cursor:pointer;text-align:left;padding:0';
    q.addEventListener('click', () => previa.irPara(c.de + 0.02));
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = c.texto; inp.spellcheck = true;
    inp.setAttribute('aria-label', `Legenda em ${fmt(c.de)}`);
    marcarLargura(inp, c.texto);
    if (c.editada) inp.classList.add('editada');
    inp.addEventListener('change', () => {
      c.texto = inp.value.trim(); c.editada = true; E.alteracoes++;
      E.edicoes.set(chave(c), c.texto);
      inp.classList.add('editada'); marcarLargura(inp, c.texto);
      previa._pintar(previa.tempoAtual());
    });
    li.append(q, inp);
    if (c.desloc) {
      const pin = el('button', 'cue-pino', null); pin.type = 'button';
      pin.title = 'Esta legenda tem posição própria — clique para voltar ao bloco';
      pin.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><path d="M12 3v10M7 8l5 5 5-5M5 21h14"/></svg>';
      pin.addEventListener('click', () => { delete c.desloc; E.deslocs.delete(chave(c)); E.alteracoes++; desenharCues(); previa._pintar(previa.tempoAtual()); atualizarMover(); });
      li.append(pin);
    }
    ul.append(li);
  }
}
function marcarLargura(inp, texto) { inp.classList.toggle('larga', larguraVisual(texto) > estiloLegenda().larguraEm * 1.15); inp.title = larguraVisual(texto) > estiloLegenda().larguraEm * 1.15 ? 'Mais larga que o padrão: vai encolher na tela' : ''; }

// ---------- legenda movível: arrasta na prévia; "todas" move o bloco, "uma" dá posição própria à legenda atual
const prender = (v, a, b) => Math.min(b, Math.max(a, v));
function ligarArrastoLegenda() {
  const leg = previa.legenda;
  leg.addEventListener('pointerdown', ev => {
    if (E.fase !== 'pronto' || ev.button !== 0) return;
    const cue = cueEm(E.cues, previa.tempoAtual());
    if (!cue) return;
    ev.preventDefault();
    leg.setPointerCapture(ev.pointerId);
    alternarPlay(false);
    const r = $('#previa').getBoundingClientRect();
    const L = estiloLegenda(), modo = E.modoMover, x0 = ev.clientX, y0 = ev.clientY;
    const ini = posicaoLegenda(cue, L, E.legendaBloco);
    const proprio = cue.desloc || { dx: 0, dy: 0 };
    // o que se move: a legenda (modo "uma") ou o bloco (modo "todas"; a legenda atual pode ter
    // deslocamento próprio por cima, que se mantém). Ímãs: centro horizontal e altura de referência.
    const ref = modo === 'uma' ? proprio : { dx: 0, dy: 0 };   // o que fica FORA do alvo
    const base = modo === 'uma' ? E.legendaBloco : { dx: 0, dy: 0 };
    const xIma = (L.x ?? 0.5) + base.dx, yIma = L.y + base.dy;
    let mexeu = false;
    leg.classList.add('arrastando');
    const mover = e => {
      // alvo = posição do que está sendo movido (sem a parte que fica fora)
      let ax = ini.x - ref.dx + (e.clientX - x0) / r.width, ay = ini.y - ref.dy + (e.clientY - y0) / r.height;
      const noCentro = Math.abs(ax - 0.5) < 0.02;
      if (noCentro) ax = 0.5;
      if (Math.abs(ay - yIma) < 0.012) ay = yIma;
      if (Math.abs(ax - xIma) < 0.012) ax = xIma;
      ax = prender(ax, 0.08, 0.92); ay = prender(ay, 0.04, 0.96);
      if (modo === 'uma') {
        cue.desloc = { dx: ax - xIma, dy: ay - yIma };
        if (!cue.desloc.dx && !cue.desloc.dy) { delete cue.desloc; E.deslocs.delete(chave(cue)); }
        else E.deslocs.set(chave(cue), cue.desloc);
      } else {
        E.legendaBloco = { dx: ax - (L.x ?? 0.5), dy: ay - L.y };
      }
      mexeu = true;
      previa._pintar(previa.tempoAtual());
      const x = ax + ref.dx, y = ay + ref.dy;
      previa.mostrarGuia(x, y, `${Math.round(y * 100)}%${noCentro ? '' : ` · ${Math.round(x * 100)}%`}`, noCentro);
    };
    const soltar = () => {
      leg.removeEventListener('pointermove', mover); leg.removeEventListener('pointerup', soltar); leg.removeEventListener('pointercancel', soltar);
      leg.classList.remove('arrastando');
      previa.fecharGuia();
      if (mexeu) { E.alteracoes++; desenharCues(); atualizarMover(); }
    };
    leg.addEventListener('pointermove', mover); leg.addEventListener('pointerup', soltar); leg.addEventListener('pointercancel', soltar);
  });
  $('#moverModo').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-modo]'); if (!b) return;
    E.modoMover = b.dataset.modo; atualizarMover();
  });
  $('#btMoverPadrao').addEventListener('click', () => {
    if (E.modoMover === 'uma') {
      const cue = cueEm(E.cues, previa.tempoAtual());
      if (cue?.desloc) { delete cue.desloc; E.deslocs.delete(chave(cue)); E.alteracoes++; }
    } else if (E.legendaBloco.dx || E.legendaBloco.dy) { E.legendaBloco = { dx: 0, dy: 0 }; E.alteracoes++; }
    desenharCues(); previa._pintar(previa.tempoAtual()); atualizarMover();
  });
  atualizarMover();
}
function atualizarMover() {
  $('#moverModo').querySelectorAll('button[data-modo]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.modo === E.modoMover)));
  const L = estiloLegenda(), cue = previa ? cueEm(E.cues, previa.tempoAtual()) : null;
  const p = posicaoLegenda(E.modoMover === 'uma' ? cue : null, L, E.legendaBloco);
  const pct = v => `${Math.round(v * 100)}%`;
  const noPadrao = E.modoMover === 'uma' ? !cue?.desloc : !(E.legendaBloco.dx || E.legendaBloco.dy);
  $('#moverOnde').textContent = `altura ${pct(p.y)}${Math.abs(p.x - 0.5) > 0.001 ? ` · largura ${pct(p.x)}` : ''}`;
  $('#btMoverPadrao').disabled = noPadrao;
  const n = E.cues.filter(c => c.desloc).length;
  const estado = E.modoMover === 'uma' ? (cue?.desloc ? 'posição própria' : cue ? 'segue o bloco' : 'sem legenda aqui') : (noPadrao ? 'no padrão' : 'bloco movido');
  $('#moverProprias').textContent = `${estado}${n && E.modoMover === 'todas' ? ` · ${n} com posição própria` : ''}`;
}

// ---------- transcrição guardada por bruto (mesma gravação → mesmas palavras; ver etapa "Transcrevendo")
const VERSAO_TRANSCRICAO = 3;   // subir quando o processo de transcrição/reouvir mudar, para refazer as guardadas
async function chaveTranscricao(c) {
  try {
    const dados = new TextEncoder().encode(`${VERSAO_TRANSCRICAO}|${c.nome}|${c.file.size}|${c.duracao.toFixed(2)}`);
    const h = await crypto.subtle.digest('SHA-256', dados);
    return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
async function lerTranscricao(chave) {
  try { const r = await fetch(`/api/transcricao/${chave}`, { cache: 'no-store' }); if (!r.ok) return null; const d = await r.json(); return d && Array.isArray(d.palavras) ? d : null; } catch { return null; }
}
async function guardarTranscricao(chave, dados) {
  const r = await fetch(`/api/transcricao/${chave}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
  if (!r.ok) throw new Error(`transcrição ${r.status}`);
}

// ---------- projetos: autosave no servidor, lista com capa e loop, reabrir soltando os brutos
const nomePadraoProjeto = () => { const d = new Date(); return `${E.preset.nome} · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function montarProjeto() {
  const T = E.tempos, t0 = agora();
  return {
    id: E.projeto.id, professor: E.professor, nome: E.projeto.nome, criadoEm: E.projeto.criadoEm, editadoPor: E.quem || '', midiaEm: E.projeto.midiaEm || 0,
    versao: 1, duracao: previa ? previa.duracao : 0,
    brutos: E.clipes.map(c => ({
      nome: c.nome, tamanho: c.file.size, duracao: c.duracao, fps: c.fps, largura: c.largura, altura: c.altura,
      semFala: !!c.semFala, palavras: c.palavras || [], texto: c.texto || '', recuperadas: c.recuperadas || 0,
      energia: c.energia ? { ...empacotarEnvelope(c.energia.env), limiar: c.energia.limiar, hop: c.energia.hop } : null,
    })),
    transicoes: E.transicoes.map(t => ({ id: t.id, nome: t.nome, tamanho: t.file.size })),
    emendaFx: [...E.emendaFx], cortes: E.cortes, edicoes: [...E.edicoes], deslocs: [...E.deslocs], legendaBloco: E.legendaBloco,
    estilo: E.estilo, modoMover: E.modoMover, alteracoes: E.alteracoes, revisao: E.revisao,
    fluxo: E.fluxo, feedback: E.feedback, reportes: E.reportes,
    tempos: { etapas: T.etapas, dSolto: t0 - T.solto, dPronto: T.pronto ? T.pronto - T.solto : null, dExportar: T.exportar ? T.exportar - T.solto : null, dRenderFim: T.renderFim ? T.renderFim - T.solto : null, dFim: T.fim ? T.fim - T.solto : null },
  };
}
// o que muda o projeto (fora a transcrição, que não muda): assina para gravar só quando mudou
const assinaturaProjeto = () => JSON.stringify([E.alteracoes, E.projeto?.nome, E.estilo, E.cortes.map(k => [k.id, k.ligado, k.de, k.ate]), [...E.emendaFx], [...E.edicoes], [...E.deslocs], E.legendaBloco, E.modoMover, E.transicoes.length, E.fluxo && [E.fluxo.etapa, E.fluxo.pedirRender, E.fluxo.saida?.driveId, E.fluxo.saida?.assinatura], E.feedback.length, E.reportes.length]);
// o que muda o VÍDEO exportado (sem contador, sem nome): é o que o robô guarda ao renderizar, para saber se a mesa mudou depois
const assinaturaPlano = () => JSON.stringify([E.cortes.map(k => [k.clipe, k.ligado, +k.de.toFixed(3), +k.ate.toFixed(3)]), [...E.emendaFx], [...E.edicoes], [...E.deslocs], E.legendaBloco, E.estilo, E.transicoes.map(t => t.id)]);
let autosaveId = null, salvoAss = '', vistaAss = '', salvando = false, midiaAss = '', midiaEm = 0;
function estadoSalvar(estado, texto) {
  const c = $('#chipSalvo'); c.className = `chip ${estado}`; c.innerHTML = `<i class="ponto"></i>${texto}`;
}
function iniciarAutosave() {
  if (autosaveId) clearInterval(autosaveId);
  salvoAss = ''; vistaAss = ''; midiaAss = '';
  autosaveId = setInterval(tentarSalvar, 3000);
  tentarSalvar(true);
}
// grava quando a assinatura ficou igual por um tique (3 s parado) — KV grátis tem 1.000 escritas/dia na conta
async function tentarSalvar(forcar) {
  if (!E.projeto || salvando || (E.fase !== 'pronto' && E.fase !== 'exportando')) return;
  // mesa mudou depois do render do robô → pede render novo (o robô lê isso na lista); voltou ao que estava → não pede
  if (E.fluxo?.saida?.assinatura && !E.robo && E.fluxo.etapa !== 'entregue') { const pedir = assinaturaPlano() !== E.fluxo.saida.assinatura; if (pedir !== !!E.fluxo.pedirRender) { E.fluxo.pedirRender = pedir; desenharFluxo(); } }
  const a = assinaturaProjeto();
  if (a === salvoAss) return;
  if (!forcar && a !== vistaAss) { vistaAss = a; estadoSalvar('pendente', 'não salvo'); return; }
  salvando = true; estadoSalvar('salvando', 'salvando…');
  try {
    const proj = montarProjeto();
    const r = await gravar(proj);
    E.projeto.editadoEm = r.editadoEm; salvoAss = a;
    anotarRecente({ id: proj.id, nome: proj.nome, editadoEm: r.editadoEm, editadoPor: proj.editadoPor, duracao: proj.duracao, brutos: proj.brutos.length, midiaEm: E.projeto.midiaEm || 0, fluxo: resumoFluxo(E.fluxo), feedback: E.feedback.length + E.reportes.length });
    estadoSalvar('ok', 'salvo');
    await atualizarMidiaProjeto();
  } catch (e) { console.warn('autosave', e); estadoSalvar('falhou', 'não salvou'); }
  finally { salvando = false; }
}
// capa (1º quadro da saída) e loop de 4 s renderizado pelo caminho do export, em 270x480: só quando
// o começo do vídeo ou o estilo mudou, e no máximo a cada 60 s
async function atualizarMidiaProjeto() {
  if (!E.projeto || !E.segmentos.length || E.fase !== 'pronto') return;
  const janela = recortarJanela({ segmentos: E.segmentos, cues: E.cues, transicoes: instanciasFx() }, 0, 4);
  const a = JSON.stringify([janela, estiloLegenda(), E.legendaBloco]);
  if (a === midiaAss || (midiaEm && agora() - midiaEm < 60)) return;
  midiaAss = a; midiaEm = agora();
  try {
    const seg = E.segmentos[0], c = E.clipes[seg.clipe];
    const q = await primeiroQuadro(c, 480, seg.de + 0.3);
    const capa = q ? await new Promise(ok => q.toBlob(ok, 'image/jpeg', 0.82)) : null;
    const preset = { ...presetAtual(), saida: { largura: 270, altura: 480 } };
    const loop = await renderizar({ clipes: E.clipes, ...janela, preset, fps: Math.min(30, c.fps), ajusteLegenda: E.legendaBloco });
    if (capa) await gravarMidia(E.projeto.id, 'capa', capa);
    await gravarMidia(E.projeto.id, 'preview', loop);
    E.projeto.midiaEm = Date.now();
    salvoAss = '';   // o JSON leva o midiaEm novo na próxima gravação
    const rec = recentesLocais(E.professor).find(x => x.id === E.projeto.id); if (rec) anotarRecente({ ...rec, midiaEm: E.projeto.midiaEm });
  } catch (e) { console.warn('mídia do projeto', e); }
}
// O KV lista com atraso (consistência eventual: até ~1 min): o que ESTE navegador salvou fica
// anotado aqui e entra na lista na hora, até o servidor passar a devolver.
function recentesLocais(professor) { try { return JSON.parse(localStorage.getItem(`bancada.recentes.${professor}`) || '[]'); } catch { return []; } }
function anotarRecente(meta) {
  try {
    const lista = recentesLocais(E.professor).filter(x => x.id !== meta.id);
    lista.unshift(meta);
    localStorage.setItem(`bancada.recentes.${E.professor}`, JSON.stringify(lista.slice(0, 12)));
  } catch {}
}
// apagados: o KV ainda devolve o projeto por até ~1 min depois do DELETE; a lista esconde o que
// este navegador apagou nos últimos 10 min
function apagadosLocais() { try { const a = JSON.parse(localStorage.getItem('bancada.apagados') || '{}'); for (const k in a) if (Date.now() - a[k] > 10 * 60e3) delete a[k]; return a; } catch { return {}; } }
function anotarApagado(id) { try { const a = apagadosLocais(); a[id] = Date.now(); localStorage.setItem('bancada.apagados', JSON.stringify(a)); } catch {} }
function esquecerRecente(professor, id) { try { localStorage.setItem(`bancada.recentes.${professor}`, JSON.stringify(recentesLocais(professor).filter(x => x.id !== id))); } catch {} }
// lista na tela inicial
async function desenharProjetos() {
  const sec = $('#projetos'), grade = $('#projetosGrade');
  if (E.fase !== 'vazio') return;
  let servidor = null;
  try { servidor = await listar(E.professor); } catch (e) { console.warn('projetos', e); }
  if (E.fase !== 'vazio') return;
  const doServidor = new Set((servidor || []).map(x => x.id));
  const locais = recentesLocais(E.professor).filter(x => !doServidor.has(x.id) && Date.now() - x.editadoEm < 3 * 86400e3);
  if (servidor === null && !locais.length) { sec.hidden = true; return; }   // sem servidor e sem nada local: nada a mostrar
  const apagados = apagadosLocais();
  const lista = [...locais, ...(servidor || [])].filter(x => !apagados[x.id]).sort((a, b) => (b.editadoEm || 0) - (a.editadoEm || 0));
  sec.hidden = false;
  $('#projetosTitulo').textContent = `Projetos do ${E.preset.nome}`;
  grade.innerHTML = '';
  if (!lista.length) { grade.append(el('p', 'apoio projetos-vazio', 'Nenhum projeto salvo ainda. Solte os brutos: a mesa salva sozinha enquanto você edita.')); return; }
  for (const pr of lista) {
    const art = el('article', 'projeto'); art.dataset.id = pr.id; art.tabIndex = 0; art.setAttribute('role', 'button');
    const midia = el('div', 'projeto-midia');
    const img = el('img'); img.alt = ''; img.loading = 'lazy';
    img.addEventListener('error', () => { img.hidden = true; midia.classList.add('sem-capa'); });
    if (pr.midiaEm) img.src = urlMidia(pr.id, 'capa', pr.midiaEm); else { img.hidden = true; midia.classList.add('sem-capa'); }   // sem mídia ainda (fechou a aba cedo): não pede
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none';
    midia.append(img, v, el('span', 'projeto-dur tnum', fmt(pr.duracao || 0).replace('.', ',')));
    art.addEventListener('mouseenter', () => { if (!pr.midiaEm) return; if (!v.src) v.src = urlMidia(pr.id, 'preview', pr.midiaEm); v.play().catch(() => {}); midia.classList.add('tocando'); });
    art.addEventListener('mouseleave', () => { v.pause(); midia.classList.remove('tocando'); });
    const info = el('div', 'projeto-info');
    info.append(el('strong', 'projeto-titulo', pr.nome || 'Sem nome'), el('span', 'apoio', `${haQuanto(pr.editadoEm || 0)}${pr.editadoPor ? ` · ${pr.editadoPor}` : ''} · ${pr.brutos} ${pr.brutos === 1 ? 'bruto' : 'brutos'}`));
    if (pr.fluxo) { const ch = el('span'); if (pr.fluxo.erro) { ch.textContent = 'o robô falhou'; ch.className = 'etapa-chip mini red'; ch.title = pr.fluxo.erro; } else pintarEtapa(ch, pr.fluxo); ch.classList.add('mini'); info.append(ch); }
    const x = el('button', 'projeto-apagar', '×'); x.type = 'button'; x.title = 'Apagar projeto';
    x.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirm(`Apagar «${pr.nome}»? Os brutos continuam onde estão; só a mesa some.`)) return;
      art.remove(); anotarApagado(pr.id); esquecerRecente(E.professor, pr.id);   // some na hora; o servidor confirma por trás
      if (!grade.querySelector('.projeto')) grade.append(el('p', 'apoio projetos-vazio', 'Nenhum projeto salvo.'));
      try { await apagar(E.professor, pr.id); } catch (e) { console.warn(e); mostrarErro('Não deu para apagar no servidor. Tente de novo.'); }
    });
    art.append(midia, info, x);
    const abrir = () => (pr.fluxo?.erro ? mostrarErro(`O robô não conseguiu editar «${pr.nome}»: ${pr.fluxo.erro}. Apague o cartão para ele tentar de novo.`) : pr.fluxo?.saida ? abrirRevisao(pr.id) : abrirProjeto(pr.id));   // do robô: primeiro o vídeo pronto; a mesa é um passo depois
    art.addEventListener('click', abrir);
    art.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); } });
    grade.append(art);
  }
}
async function abrirProjeto(id) {
  if (E.fase !== 'vazio') return;
  let proj;
  try { proj = await carregar(E.professor, id); } catch (e) { return mostrarErro('O servidor ainda não devolveu este projeto (acabou de ser salvo? espere um minuto e tente de novo).'); }
  E.pedido = { proj, tem: [] };
  $('#soltaTexto').hidden = true; $('#projetos').hidden = true;
  $('#pedido').hidden = false; $('#pedidoNome').textContent = proj.nome;
  $('#btPedidoDrive').hidden = !proj.fluxo?.bruto?.driveId;
  desenharPedido();
}
// o bruto que o robô puxou do Drive volta pelo servidor (streaming) e entra na mesa como se tivesse sido solto
async function baixarBrutoDoDrive() {
  const b = E.pedido?.proj?.fluxo?.bruto; if (!b?.driveId) return;
  const bt = $('#btPedidoDrive'), pg = $('#pedidoProgresso'); bt.disabled = true; pg.hidden = false; $('#pedidoAviso').textContent = '';
  try {
    const r = await fetch(`/api/drive/arquivo/${b.driveId}`); if (!r.ok) throw new Error(`servidor ${r.status}`);
    const total = +r.headers.get('Content-Length') || b.tamanho || 0, partes = []; let lidos = 0;
    const leitor = r.body.getReader();
    for (;;) {
      const { done, value } = await leitor.read(); if (done) break;
      partes.push(value); lidos += value.length;
      if (total) { $('#pedidoBarra').style.transform = `scaleX(${(lidos / total).toFixed(3)})`; $('#pedidoProgressoTexto').textContent = `${Math.round(100 * lidos / total)}% · ${(lidos / 1e6).toFixed(0)} de ${(total / 1e6).toFixed(0)} MB`; }
    }
    if (!E.pedido) return;
    receberParaProjeto([new File(partes, b.nome, { type: 'video/mp4' })]);
  } catch (e) { $('#pedidoAviso').textContent = `Não deu para baixar do Drive: ${e.message}`; }
  finally { bt.disabled = false; pg.hidden = true; }
}
function desenharPedido() {
  const { proj, tem } = E.pedido, ul = $('#pedidoLista'); ul.innerHTML = '';
  const linha = (b, opcional) => {
    const ok = tem.some(f => mesmoArquivo(b, f));
    const li = el('li', ok ? 'ok' : opcional ? 'opcional' : 'falta');
    li.append(el('span', 'nome', b.nome), el('span', 'apoio tnum', `${(b.tamanho / 1e6).toFixed(1)} MB`), el('span', 'estado', ok ? 'ok' : opcional ? 'transição · opcional' : 'falta'));
    ul.append(li);
  };
  proj.brutos.forEach(b => linha(b, false));
  (proj.transicoes || []).forEach(t => linha(t, true));
}
function receberParaProjeto(files) {
  const { proj, tem } = E.pedido;
  const quer = [...proj.brutos, ...(proj.transicoes || [])];
  let estranhos = 0;
  for (const f of files) {
    if (tem.some(x => x.name === f.name && x.size === f.size)) continue;
    if (quer.some(b => mesmoArquivo(b, f))) tem.push(f); else estranhos++;
  }
  desenharPedido();
  $('#pedidoAviso').textContent = estranhos ? `${estranhos} ${estranhos === 1 ? 'arquivo não é deste projeto' : 'arquivos não são deste projeto'} (nome ou tamanho diferente).` : '';
  if (proj.brutos.every(b => tem.some(f => mesmoArquivo(b, f)))) { const pedido = E.pedido; E.pedido = null; $('#pedido').hidden = true; restaurarProjeto(pedido.proj, pedido.tem); }
}
function cancelarPedido() { E.pedido = null; $('#pedido').hidden = true; $('#pedidoProgresso').hidden = true; $('#pedidoAviso').textContent = ''; $('#soltaTexto').hidden = false; desenharProjetos(); }

// ---------- revisão (o que a Giovana pediu): o robô edita → o editor revisa → revisão final → Drive
const ETAPAS = { editor: ['Revisão do editor', 'amber'], final: ['Revisão final', 'brand'], entregue: ['No Drive', 'green'] };
const resumoFluxo = f => f ? { etapa: f.etapa, pedirRender: !!f.pedirRender, brutoId: f.bruto?.driveId || '', saida: !!f.saida?.driveId, link: f.link || '' } : null;
const renderAtual = (f = E.fluxo) => !!f?.saida?.assinatura && f.saida.assinatura === assinaturaPlano();
function pintarEtapa(elm, f) {
  const [rot, cor] = ETAPAS[f?.etapa] || ETAPAS.editor, rend = f?.pedirRender && f.etapa !== 'entregue';
  elm.textContent = rend ? `${rot} · renderizando` : rot;
  elm.className = `etapa-chip ${cor}${rend ? ' pulsa' : ''}`;
}
// quem marcou «revisado» é o editor: a revisão final é de OUTRA pessoa, então para ele não aparece o aprovar
const souOEditor = f => !!E.quem && f.revisadoPor === E.quem;
function textoFluxo(f) {
  if (f.etapa === 'entregue') return `Aprovado por ${f.aprovadoPor || '—'} e entregue na pasta do Drive.`;
  if (f.etapa === 'final') return souOEditor(f)
    ? 'Você marcou como revisado. Agora falta a revisão final, feita por outra pessoa: ela aprova e o vídeo vai para a pasta de entrega do Drive.'
    : `Revisado por ${f.revisadoPor || '—'}. Falta a revisão final: quem aprovar manda o vídeo para a pasta de entrega do Drive.`;
  return 'Editado pelo robô. O editor confere cortes e legendas e marca como revisado.';
}
function nomeQuem() {
  if (E.quem) return E.quem;
  const n = prompt('Seu nome (fica registrado na revisão):', ''); if (n == null) return null;
  E.quem = n.trim(); try { localStorage.setItem('bancada.quem', E.quem); } catch {}
  $('#chipQuem').innerHTML = `<i class="ponto"></i>${escapa(E.quem || 'quem edita?')}`; $('#chipQuem').classList.toggle('ok', !!E.quem);
  return E.quem || null;
}
const anotarHistorico = (f, o, quem) => { f.historico = [...(f.historico || []), { quando: Date.now(), quem, o }]; };
const botao = (texto, fn, cls = '', desligado = false) => { const b = el('button', `bt ${cls}`.trim(), texto); b.type = 'button'; b.disabled = desligado; b.addEventListener('click', fn); return b; };
const linkDrive = href => { const a = el('a', 'bt', 'Abrir no Drive'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
// link para mandar a quem revisa: abre o visualizador deste projeto direto (sem os brutos)
const linkRevisao = id => `${location.origin}${location.pathname}?professor=${E.professor}&revisar=${id}`;
function botaoLink(id) {
  const b = botao('Copiar link para a revisão', async () => {
    try { await navigator.clipboard.writeText(linkRevisao(id)); b.textContent = 'Link copiado'; }
    catch { prompt('Copie o link:', linkRevisao(id)); }
    setTimeout(() => { b.textContent = 'Copiar link para a revisão'; }, 1800);
  });
  b.title = linkRevisao(id);
  return b;
}
async function postarEntrega(id, quem) {
  const r = await (await fetch('/api/drive/entregar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ professor: E.professor, id, quem }) })).json();
  if (r.erro) throw new Error(r.erro);
  return r.link;
}
// na mesa
function desenharFluxo() {
  const sec = $('#fluxo'), f = E.fluxo;
  if (!f) { sec.hidden = true; return; }
  sec.hidden = false; pintarEtapa($('#fluxoEtapa'), f);
  const atual = renderAtual(f);
  $('#fluxoTexto').textContent = textoFluxo(f) + (f.etapa !== 'entregue' && f.saida ? (atual ? ' O vídeo em revisão é exatamente esta mesa.' : ' A mesa mudou depois do render: o robô renderiza de novo sozinho quando você parar de mexer.') : '');
  const ac = $('#fluxoAcoes'); ac.innerHTML = '';
  if (f.etapa === 'editor') ac.append(botao('Marcar como revisado', () => mudarEtapa('final', 'revisado pelo editor'), 'bt-primario'));
  if (f.etapa === 'final' && souOEditor(f)) ac.append(botaoLink(E.projeto.id), botao('Voltar atrás', () => mudarEtapa('editor', 'voltou atrás'), 'bt-fantasma'));
  else if (f.etapa === 'final') ac.append(botao(atual ? 'Aprovar e enviar ao Drive' : 'Aprovar (espera o render)', entregarDaMesa, 'bt-primario', !atual), botao('Devolver ao editor', () => mudarEtapa('editor', 'devolvido ao editor')), botaoLink(E.projeto.id));
  else if (f.etapa === 'entregue') { if (f.link) ac.append(linkDrive(f.link)); }
  else ac.append(botaoLink(E.projeto.id));
  if (f.etapa === 'final' && souOEditor(f)) $('#fluxoTexto').textContent += ' Mande o link para ela.';
}
function mudarEtapa(etapa, o) {
  const quem = nomeQuem(); if (quem == null) return;
  const f = E.fluxo; f.etapa = etapa;
  if (etapa === 'final') { f.revisadoPor = quem; f.revisadoEm = Date.now(); }
  anotarHistorico(f, o, quem);
  salvoAss = ''; tentarSalvar(true); desenharFluxo();
}
async function entregarDaMesa() {
  const quem = nomeQuem(); if (quem == null) return;
  if (!confirm('Enviar o vídeo aprovado para a pasta de entrega do Drive?')) return;
  await tentarSalvar(true);
  try {
    const link = await postarEntrega(E.projeto.id, quem);
    Object.assign(E.fluxo, { etapa: 'entregue', aprovadoPor: quem, aprovadoEm: Date.now(), link }); anotarHistorico(E.fluxo, 'aprovado e enviado ao Drive', quem);
    salvoAss = ''; tentarSalvar(true); desenharFluxo();
  } catch (e) { alert(`Não deu para enviar ao Drive: ${e.message}`); }
}
// na tela inicial: o vídeo editado, sem precisar dos brutos
async function abrirRevisao(id) {
  if (E.fase !== 'vazio') return;
  let proj;
  try { proj = await carregar(E.professor, id); } catch { return mostrarErro('O servidor ainda não devolveu este projeto (acabou de ser salvo? espere um minuto e tente de novo).'); }
  if (!proj.fluxo?.saida?.driveId) return abrirProjeto(id);
  E.revisando = proj;
  $('#soltaTexto').hidden = true; $('#projetos').hidden = true; $('#revisao').hidden = false;
  desenharRevisao();
}
function desenharRevisao() {
  const proj = E.revisando, f = proj.fluxo;
  $('#revisaoNome').textContent = proj.nome;
  $('#revisaoSub').textContent = `${proj.brutos.map(b => b.nome).join(', ')} · ${fmt(proj.duracao).replace('.', ',')} · editado pelo robô ${haQuanto(f.saida.geradoEm || proj.editadoEm)}`;
  pintarEtapa($('#revisaoEtapa'), f);
  const v = $('#revisaoVideo'), src = `/api/drive/arquivo/${f.saida.driveId}?v=${f.saida.geradoEm || 0}`;
  if (v.dataset.src !== src) { v.src = src; v.dataset.src = src; }
  $('#revisaoTexto').textContent = textoFluxo(f) + (f.pedirRender && f.etapa !== 'entregue' ? ' O robô está renderizando as últimas mudanças da mesa; este vídeo ainda é o anterior.' : '');
  const h = $('#revisaoHistorico'); h.innerHTML = '';
  for (const x of f.historico || []) h.append(el('li', null, `${new Date(x.quando).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${x.quem || '—'} · ${x.o}`));
  const ac = $('#revisaoAcoes'); ac.innerHTML = '';
  if (f.etapa === 'editor') ac.append(botao('Marcar como revisado', () => mudarEtapaRevisao('final', 'revisado pelo editor'), 'bt-primario'));
  if (f.etapa === 'final' && souOEditor(f)) { ac.append(botaoLink(proj.id), botao('Voltar atrás', () => mudarEtapaRevisao('editor', 'voltou atrás'), 'bt-fantasma')); $('#revisaoTexto').textContent += ' Mande o link para ela.'; }
  else if (f.etapa === 'final') ac.append(botao(f.pedirRender ? 'Aprovar (espera o render)' : 'Aprovar e enviar ao Drive', entregarDaRevisao, 'bt-primario', !!f.pedirRender), botao('Devolver ao editor', () => mudarEtapaRevisao('editor', 'devolvido ao editor')), botaoLink(proj.id));
  else if (f.etapa === 'entregue') { if (f.link) ac.append(linkDrive(f.link)); }
  else ac.append(botaoLink(proj.id));
  ac.append(botao('Reportar erro', reportarNoVisualizador), botao('Abrir a mesa para ajustar', () => { fecharRevisao(false); abrirProjeto(proj.id); }), botao('Fechar', () => fecharRevisao(true), 'bt-fantasma'));
  listaReportes($('#revisaoReportes'), proj.reportes || [], r => { const v = $('#revisaoVideo'); v.currentTime = r.tSaida; v.pause(); });
  $('#revisaoAviso').textContent = f.etapa !== 'entregue' && f.pedirRender ? 'A aprovação libera quando o render novo terminar.' : '';
}
function fecharRevisao(voltar) {
  const v = $('#revisaoVideo'); v.pause(); v.removeAttribute('src'); delete v.dataset.src; v.load();
  E.revisando = null; $('#revisao').hidden = true; $('#reporteRev').hidden = true;
  if (voltar) { $('#soltaTexto').hidden = false; desenharProjetos(); }
}
function anotarRevisando(quem) { const p = E.revisando; anotarRecente({ id: p.id, nome: p.nome, editadoEm: p.editadoEm || Date.now(), editadoPor: quem, duracao: p.duracao, brutos: p.brutos.length, midiaEm: p.midiaEm || 0, fluxo: resumoFluxo(p.fluxo), feedback: (p.feedback || []).length }); }
async function mudarEtapaRevisao(etapa, o) {
  const quem = nomeQuem(); if (quem == null) return;
  const proj = E.revisando, f = proj.fluxo; f.etapa = etapa;
  if (etapa === 'final') { f.revisadoPor = quem; f.revisadoEm = Date.now(); }
  anotarHistorico(f, o, quem);
  try { proj.editadoPor = quem; const r = await gravar(proj); proj.editadoEm = r.editadoEm; anotarRevisando(quem); }
  catch (e) { mostrarErro(`Não salvou: ${e.message}`); }
  desenharRevisao();
}
async function entregarDaRevisao() {
  const quem = nomeQuem(); if (quem == null) return;
  if (!confirm('Enviar o vídeo aprovado para a pasta de entrega do Drive?')) return;
  const proj = E.revisando;
  try {
    const link = await postarEntrega(proj.id, quem);
    Object.assign(proj.fluxo, { etapa: 'entregue', aprovadoPor: quem, aprovadoEm: Date.now(), link }); anotarHistorico(proj.fluxo, 'aprovado e enviado ao Drive', quem);
    proj.editadoEm = Date.now(); anotarRevisando(quem);
  } catch (e) { mostrarErro(`Não deu para enviar ao Drive: ${e.message}`); }
  desenharRevisao();
}
// ---------- reportar erro num ponto do vídeo (visualizador e mesa): vai para o projeto, para o diário e para a revisão por IA
const TIPOS_REPORTE = ['cortou fala boa', 'deixou erro passar', 'legenda errada', 'legenda fora de tempo', 'outro'];
const fmtV = t => fmt(t).replace('.', ',');
function tempoClipeDe(segmentos, tSaida) {
  const s = segmentos.find(s => tSaida >= s.saidaDe && tSaida <= s.saidaAte) || segmentos[segmentos.length - 1];
  return s ? { clipe: s.clipe, tClipe: s.de + Math.min(Math.max(0, tSaida - s.saidaDe), s.dur) } : { clipe: 0, tClipe: tSaida };
}
function tempoSaidaDe(segmentos, clipe, tClipe) {
  const s = segmentos.find(s => s.clipe === clipe && tClipe >= s.de && tClipe <= s.ate);
  if (s) return s.saidaDe + (tClipe - s.de);
  const depois = segmentos.find(s => s.clipe === clipe && s.de >= tClipe);   // o ponto foi cortado: vai para o que ficou logo depois
  return depois ? depois.saidaDe : 0;
}
const trechoDe = (palavras, t, raio = 4) => (palavras || []).filter(w => w.ate >= t - raio && w.de <= t + raio).map(w => w.texto).join(' ').slice(0, 240);
function formReporte(alvo, tSaida, aoEnviar) {
  alvo.innerHTML = ''; alvo.hidden = false;
  let tipo = '';
  const cab = el('div', 'reporte-cab'); cab.append(el('strong', null, 'Reportar erro'), el('span', 'apoio tnum', `no ponto ${fmtV(tSaida)}`));
  const chips = el('div', 'reporte-chips');
  for (const t of TIPOS_REPORTE) { const b = el('button', 'porque-chip', t); b.type = 'button'; b.addEventListener('click', () => { tipo = t; chips.querySelectorAll('.porque-chip').forEach(x => x.classList.toggle('ligado', x === b)); }); chips.append(b); }
  const ta = el('textarea'); ta.rows = 2; ta.maxLength = 500; ta.placeholder = 'O que está errado? Uma linha já ajuda.';
  const acoes = el('div', 'revisao-acoes');
  acoes.append(botao('Enviar reporte', () => { if (!tipo && !ta.value.trim()) { ta.focus(); return; } alvo.hidden = true; aoEnviar({ tipo: tipo || 'outro', texto: ta.value.trim() }); }, 'bt-primario'), botao('Cancelar', () => { alvo.hidden = true; }, 'bt-fantasma'));
  alvo.append(cab, chips, ta, acoes);
  ta.focus();
}
function novoReporte({ tipo, texto }, tSaida, segmentos, brutos, quem) {
  const { clipe, tClipe } = tempoClipeDe(segmentos, tSaida);
  return { quando: Date.now(), quem: quem || '', tipo, texto, tSaida: +tSaida.toFixed(2), clipe, tClipe: +tClipe.toFixed(2), trecho: trechoDe(brutos[clipe]?.palavras, tClipe) };
}
function listaReportes(ul, reportes, aoClicar) {
  ul.innerHTML = ''; ul.hidden = !reportes.length;
  for (const r of [...reportes].reverse()) {
    const li = el('li');
    li.append(el('span', 'tnum', fmtV(r.tSaida)), el('strong', null, r.tipo), el('span', 'reporte-texto', r.texto || ''), el('span', 'apoio', `${r.quem || '—'} · ${haQuanto(r.quando)}`));
    if (aoClicar) { li.tabIndex = 0; li.title = 'Ir para o ponto'; li.addEventListener('click', () => aoClicar(r)); }
    ul.append(li);
  }
}
function reportarNaMesa() {
  if (!previa || E.fase !== 'pronto') return;
  alternarPlay(false);
  const t = previa.tempoAtual();
  formReporte($('#reporteMesa'), t, r => {
    const quem = nomeQuem(); if (quem == null) return;
    E.reportes.push(novoReporte(r, t, E.segmentos, E.clipes, quem)); salvoAss = ''; tentarSalvar(true);
    listaReportes($('#mesaReportes'), E.reportes, x => previa.irPara(tempoSaidaDe(E.segmentos, x.clipe, x.tClipe)));
  });
}
function reportarNoVisualizador() {
  const proj = E.revisando, v = $('#revisaoVideo'); if (!proj) return;
  v.pause();
  const t = v.currentTime || 0;
  formReporte($('#reporteRev'), t, async r => {
    const quem = nomeQuem(); if (quem == null) return;
    const segs = montarSegmentos(proj.brutos, proj.cortes || []);
    proj.reportes = [...(proj.reportes || []), novoReporte(r, t, segs, proj.brutos, quem)];
    try { proj.editadoPor = quem; const g = await gravar(proj); proj.editadoEm = g.editadoEm; anotarRevisando(quem); }
    catch (e) { mostrarErro(`Não salvou o reporte: ${e.message}`); }
    listaReportes($('#revisaoReportes'), proj.reportes, x => { v.currentTime = x.tSaida; v.pause(); });
  });
}
// regras do professor («não faz isso», «faz sempre isso»)
async function carregarRegras() {
  try { const r = await (await fetch(`/api/regras/${E.professor}`, { cache: 'no-store' })).json(); E.regras = r.texto || ''; $('#regrasEstado').textContent = r.editadoEm ? `salvas ${haQuanto(r.editadoEm)}${r.editadoPor ? ` por ${r.editadoPor}` : ''}` : 'nenhuma regra ainda'; }
  catch { E.regras = ''; $('#regrasEstado').textContent = ''; }
  $('#regrasTexto').value = E.regras; $('#regrasTitulo').textContent = `Regras do ${E.preset.nome}`;
  $('#btDiario').href = `diario.html?professor=${E.professor}`;
  try { const d = await (await fetch(`/api/feedback?professor=${E.professor}`, { cache: 'no-store' })).json(); E.exemplos = exemplosDoDiario(d.itens || []); } catch { E.exemplos = []; }
}
// o diário vira exemplos curtos no prompt da revisão por IA: reportes de corte com trecho e cortes desligados com o porquê (12 mais recentes)
function exemplosDoDiario(itens) {
  return itens.filter(i => (i.fonte === 'reporte' && /cortou fala boa|deixou erro passar/.test(i.tipo || '') && i.trecho) || (i.fonte === 'corte' && i.acao === 'manteve' && i.texto))
    .slice(0, 12).map(i => i.fonte === 'reporte' ? `[${i.tipo}] «${i.trecho}»${i.texto ? ` — ${i.texto}` : ''}` : `[não era erro, ${i.porque}] «${i.texto}»`);
}
function ligarRegras() {
  $('#btRegras').addEventListener('click', () => { const r = $('#regras'); r.hidden = !r.hidden; if (!r.hidden) $('#regrasTexto').focus(); });
  $('#btRegrasSalvar').addEventListener('click', async () => {
    const quem = nomeQuem(); if (quem == null) return;
    const texto = $('#regrasTexto').value.trim();
    try { const r = await (await fetch(`/api/regras/${E.professor}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto, quem }) })).json(); E.regras = r.texto || ''; $('#regrasEstado').textContent = `salvas agora por ${quem}`; }
    catch (e) { $('#regrasEstado').textContent = `não salvou: ${e.message}`; }
  });
}
// a mesa volta como estava: só lê os brutos (e as miniaturas); transcrição e energia vêm do projeto
async function restaurarProjeto(proj, arquivos) {
  E.fase = 'lendo';
  E.projeto = { id: proj.id, nome: proj.nome, criadoEm: proj.criadoEm, editadoEm: proj.editadoEm || 0, midiaEm: proj.midiaEm || 0 };
  const T = proj.tempos || {};
  E.tempos = { solto: agora() - (T.dSolto || 0), etapas: T.etapas || {}, pronto: 0, exportar: 0, renderFim: 0, fim: 0 };
  for (const [k, d] of [['pronto', 'dPronto'], ['exportar', 'dExportar'], ['renderFim', 'dRenderFim'], ['fim', 'dFim']]) if (T[d] != null) E.tempos[k] = E.tempos.solto + T[d];
  $('#soltaTexto').hidden = true; $('#solta').classList.add('ocupada');
  $('#solta').removeAttribute('role'); $('#solta').removeAttribute('tabindex');
  $('#erro').hidden = true;
  const ol = $('#brutos'); ol.hidden = false; ol.innerHTML = '';
  for (const [n, r] of [['ler', 'Lendo os brutos'], ['montar', 'Montando a mesa']]) marcarEtapa(n, r, 'pendente');
  const etapasAntes = { ...E.tempos.etapas };
  try {
    await etapa('ler', 'Lendo os brutos', async () => {
      for (const [i, b] of proj.brutos.entries()) {
        const f = arquivos.find(x => mesmoArquivo(b, x));
        const c = await abrirClipe(f);
        if (!c.podeDecodificar) throw new Error(`${f.name}: o navegador não decodifica este vídeo.`);
        E.clipes.push(c);
        slotCheio(i, c, await primeiroQuadro(c));
        const li = el('li');
        li.append(el('span', 'num tnum', String(i + 1).padStart(2, '0')), (() => { const d = el('div'); d.append(el('div', 'nome', c.nome), el('div', 'meta', `${c.largura}×${c.altura} · ${c.fps.toFixed(2)} fps · ${fmt(c.duracao)}`)); return d; })(), el('span', 'apoio tnum', `${(f.size / 1e6).toFixed(1)} MB`));
        ol.append(li);
        c.palavras = b.palavras || []; c.texto = b.texto || ''; c.recuperadas = b.recuperadas || 0; c.semFala = !!b.semFala;
        if (b.energia) { const env = desempacotarEnvelope(b.energia); c.energia = new Energia(env, b.energia.limiar, b.energia.hop); c.silencios = silencios(env, b.energia.limiar); }
        const rotulo = proj.brutos.length > 1 ? `${String(i + 1).padStart(2, '0')} · ` : '';
        c.thumbs = await miniaturas(c, 74, 1, fr => detalheEtapa('ler', `${rotulo}miniaturas ${Math.round(fr * 100)}%`));
      }
      for (const t of proj.transicoes || []) {
        const f = arquivos.find(x => mesmoArquivo(t, x));
        if (!f) continue;
        const tr = await abrirTransicao(f); tr.id = t.id; E.transicoes.push(tr);
      }
      detalheEtapa('ler', '');
    });
    await etapa('montar', 'Montando a mesa', async () => {
      E.cortes = proj.cortes || []; reservarIds(Math.max(0, ...E.cortes.map(k => k.id || 0)));
      E.revisao = proj.revisao || {};
      E.fluxo = proj.fluxo || null; E.feedback = proj.feedback || []; E.reportes = proj.reportes || [];
      E.edicoes = new Map(proj.edicoes || []); E.deslocs = new Map(proj.deslocs || []);
      const temFx = new Set(E.transicoes.map(t => t.id));
      E.emendaFx = new Map((proj.emendaFx || []).filter(([, fx]) => temFx.has(fx.id)));
      E.legendaBloco = proj.legendaBloco || { dx: 0, dy: 0 }; E.modoMover = proj.modoMover || 'todas';
      E.estilo = proj.estilo || {}; salvarEstilo(); aplicarEstilo();
      E.alteracoes = proj.alteracoes || 0;
      E.segmentos = montarSegmentos(E.clipes, E.cortes);
      E.cues = legendar(E.clipes, E.segmentos, E.preset);
      for (const c of E.cues) { const k = chave(c); if (E.edicoes.has(k)) { c.texto = E.edicoes.get(k); c.editada = true; } if (E.deslocs.has(k)) c.desloc = E.deslocs.get(k); }
    });
  } catch (e) {
    console.error(e); mostrarErro(e.message || String(e)); E.fase = 'erro'; return;
  }
  // as etapas de reabrir não entram no tempo de máquina do relatório (o vídeo já tinha sido processado)
  E.tempos.etapas = etapasAntes;
  E.fase = 'pronto';
  if (!E.tempos.pronto) E.tempos.pronto = agora();
  abrirMesa();
  iniciarAutosave();
  if (E.irPara) { previa.irPara(tempoSaidaDe(E.segmentos, E.irPara.clipe, E.irPara.tClipe)); E.irPara = null; }
}
function ligarProjetos() {
  $('#btPedidoEscolher').addEventListener('click', ev => { ev.stopPropagation(); $('#arquivos').click(); });
  $('#btPedidoCancelar').addEventListener('click', ev => { ev.stopPropagation(); cancelarPedido(); });
  $('#btPedidoDrive').addEventListener('click', ev => { ev.stopPropagation(); baixarBrutoDoDrive(); });
  $('#btReportar').addEventListener('click', reportarNaMesa);
  $('#projetoNome').addEventListener('change', ev => { if (E.projeto) { E.projeto.nome = ev.target.value.trim() || nomePadraoProjeto(); ev.target.value = E.projeto.nome; } });
  const chipQuem = $('#chipQuem');
  const pintaQuem = () => { chipQuem.innerHTML = `<i class="ponto"></i>${E.quem ? escapa(E.quem) : 'quem edita?'}`; chipQuem.classList.toggle('ok', !!E.quem); };
  chipQuem.addEventListener('click', () => { const n = prompt('Seu nome (aparece nos projetos como "editado por"):', E.quem || ''); if (n == null) return; E.quem = n.trim(); try { localStorage.setItem('bancada.quem', E.quem); } catch {} pintaQuem(); salvoAss = ''; if (E.fluxo) desenharFluxo(); if (E.revisando) desenharRevisao(); });
  pintaQuem();
  window.addEventListener('pagehide', () => { if (!E.robo && E.projeto && assinaturaProjeto() !== salvoAss) { try { fetch(`/api/projetos/${E.projeto.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(montarProjeto()), keepalive: true }); } catch {} } });
}

// ---------- prévia
function aoTempoPrevia(t) {
  const dur = previa.duracao || 1;
  $('#scrub').value = Math.round((t / dur) * 1000);
  $('#tempoPrevia').textContent = `${fmt(t).replace('.', ',')} / ${fmt(dur).replace('.', ',')}`;
  const seg = E.segmentos.find(s => t >= s.saidaDe && t <= s.saidaAte) || E.segmentos[E.segmentos.length - 1];
  const ag = $('#agulha'), fita = $('#fita');
  if (seg && ag) {
    const tr = fita.querySelectorAll('.trilho')[seg.clipe];
    if (tr) {
      const x = tr.offsetLeft + (seg.de + (t - seg.saidaDe)) * PX_POR_S;
      ag.style.transform = `translateX(${x}px)`;
      // a fita acompanha a agulha: quando ela sai da janela, rola para deixá-la a 1/3 da largura
      const vis = fita.clientWidth;
      if (x < fita.scrollLeft + 24 || x > fita.scrollLeft + vis - 24) fita.scrollTo({ left: Math.max(0, x - vis / 3), behavior: previa.tocando ? 'auto' : 'smooth' });
    }
  }
  // destaque da legenda ativa só quando ela MUDA (scrollIntoView a cada quadro forçava layout e travava o Safari)
  const c = E.cues.find(x => t >= x.de && t < x.ate);
  const idAtiva = c ? c.id : 0;
  if (idAtiva !== E.cueAtiva) {
    E.cueAtiva = idAtiva;
    if (E.modoMover === 'uma') atualizarMover();
    document.querySelectorAll('#cues li.ativa').forEach(li => li.classList.remove('ativa'));
    if (c) { const li = document.querySelector(`#cues li[data-id="${c.id}"]`); if (li) { li.classList.add('ativa'); li.scrollIntoView({ block: 'nearest' }); } }
  }
}
function alternarPlay(forcar) {
  const quer = forcar ?? !previa.tocando;
  if (quer) previa.tocar(); else previa.pausar();
  $('#btPlay .ico-play').hidden = quer;
  $('#btPlay .ico-pause').hidden = !quer;
  $('#btPlay').setAttribute('aria-label', quer ? 'Pausar' : 'Tocar');
}

// ---------- exportar
let ultimoMp4 = null;
async function exportar() {
  if (E.fase !== 'pronto') return;
  E.fase = 'exportando';
  E.tempos.exportar = agora();
  alternarPlay(false);
  previa.fecharRender();
  $('#btExportar').disabled = true;
  $('#progresso').hidden = false;
  $('#resultado').hidden = true;
  abortar = new AbortController();
  const fps = E.clipes[0].fps;
  let blob;
  try {
    blob = await etapa('render', 'Renderizando', () => renderizar({
      clipes: E.clipes, segmentos: E.segmentos, cues: E.cues, transicoes: instanciasFx(), preset: presetAtual(), fps, ajusteLegenda: E.legendaBloco, sinal: abortar.signal,
      aoProgredir: (f, t) => { $('#barraFill').style.transform = `scaleX(${f.toFixed(3)})`; $('#progressoTexto').textContent = `${Math.round(f * 100)}% · ${fmt(t)}`; },
    }));
  } catch (e) {
    $('#progresso').hidden = true; $('#btExportar').disabled = false; E.fase = 'pronto';
    if (e.name !== 'AbortError') { console.error(e); alert(`A exportação falhou: ${e.message}`); }
    return;
  }
  E.tempos.renderFim = agora();
  ultimoMp4 = { blob, nome: `${E.preset.id}-${new Date().toISOString().slice(0, 10)}.mp4` };
  $('#progresso').hidden = true;
  $('#resultadoTexto').textContent = `MP4 pronto · ${(blob.size / 1e6).toFixed(1)} MB · ${fmt(previa.duracao)}`;
  $('#resultado').hidden = false;
  $('#btExportar').disabled = false; $('#btExportar').textContent = 'Exportar de novo';
  E.fase = 'pronto';
  if (new URLSearchParams(location.search).has('teste')) { await salvar(blob, ultimoMp4.nome); E.tempos.fim = agora(); clearInterval(relogioId); atualizarTempos(true); }
  else atualizarTempos();
}
// o salvamento é um CLIQUE do editor: sem gesto do usuário o Safari ignora download disparado por script
async function salvarResultado() {
  if (!ultimoMp4) return;
  await salvar(ultimoMp4.blob, ultimoMp4.nome);
  if (!E.tempos.fim) { E.tempos.fim = agora(); clearInterval(relogioId); }
  $('#btSalvar').textContent = 'Salvo · salvar de novo';
  atualizarTempos(true);
}
function verResultado() {
  if (!ultimoMp4) return;
  previa.mostrarRender(ultimoMp4.blob, 'MP4 exportado · como saiu');
}
async function salvar(blob, nome) {
  if (new URLSearchParams(location.search).has('teste')) {
    const r = await fetch('/api/salvar-teste', { method: 'POST', body: blob });
    console.log('salvo no servidor de teste', await r.json());
    return;
  }
  if (window.showSaveFilePicker && !E.robo) {   // sem tela (robô) o seletor de salvar nunca fecha: vai pelo <a download>
    try {
      const h = await showSaveFilePicker({ suggestedName: nome, types: [{ description: 'Vídeo MP4', accept: { 'video/mp4': ['.mp4'] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------- tempos (as três respostas da Giovana, medidas)
function calcularTempos() {
  const T = E.tempos;
  const maquina = Object.values(T.etapas).reduce((s, v) => s + v, 0);
  const pronto = T.pronto || agora();
  const ajuste = (T.exportar || agora()) - pronto;
  const fim = T.fim || (T.renderFim ? agora() : null);
  const operacao = fim && T.renderFim ? fim - T.renderFim : 0;
  const total = (T.fim || agora()) - T.solto;
  return { maquina, ajuste, operacao, total, fechado: !!T.fim };
}
// o bloco «Tempos» e o relógio saíram da tela a pedido dele (17/09/2026); a medição continua indo para o projeto salvo
function atualizarTempos(fechou) {
  if (!$('#temposLista')) return;
  const t = calcularTempos();
  const dl = $('#temposLista'); dl.innerHTML = '';
  const linha = (k, v, cls) => { dl.append(el('dt', null, k)); const dd = el('dd', 'tnum' + (cls ? ' ' + cls : ''), v); dl.append(dd); };
  linha('Máquina (ler, ouvir, transcrever, cortar, legendar, renderizar)', fmtRel(t.maquina));
  linha(`Ajuste do editor (${E.alteracoes} ${E.alteracoes === 1 ? 'alteração' : 'alterações'})`, fmtRel(t.ajuste));
  linha('Operação (soltar, exportar, salvar)', fmtRel(t.operacao));
  dl.append(el('div', 'sep'));
  linha('Total, do bruto ao MP4', fmtRel(t.total), 'total');
  $('#temposEstado').textContent = t.fechado ? 'fechado' : 'medindo';
  $('#btRelatorio').hidden = !t.fechado;
  if (!t.fechado && E.fase === 'pronto') setTimeout(() => atualizarTempos(), 1000);
}
function relatorio() {
  const t = calcularTempos();
  const et = E.tempos.etapas;
  const bruto = E.clipes.reduce((s, c) => s + c.duracao, 0);
  const linhas = [
    `Bancada — ${E.preset.nome} — ${new Date().toLocaleString('pt-BR')}`,
    `Brutos: ${E.clipes.map(c => c.nome).join(', ')} (${fmt(bruto)} → ${fmt(previa.duracao)} no ar)`,
    `Cortes: ${E.cortes.filter(k => k.ligado).length} aplicados de ${E.cortes.length} propostos · Legendas: ${E.cues.length} (${E.cues.filter(c => c.editada).length} editadas) · Transições: ${instanciasFx().length}`,
    '',
    `Máquina: ${fmtRel(t.maquina)}  (ler ${(et.ler || 0).toFixed(0)}s · áudio ${(et.audio || 0).toFixed(0)}s · transcrever ${(et.transcrever || 0).toFixed(0)}s · cortar+legendar ${((et.cortar || 0) + (et.legendar || 0)).toFixed(1)}s · renderizar ${(et.render || 0).toFixed(0)}s)`,
    `Ajuste do editor: ${fmtRel(t.ajuste)} (${E.alteracoes} alterações)`,
    `Operação humana: ${fmtRel(t.operacao)}`,
    `Total do bruto ao MP4: ${fmtRel(t.total)}`,
  ];
  return linhas.join('\n');
}

// ---------- ligações
async function iniciar() {
  const Q = new URLSearchParams(location.search);
  if (PROFESSORES.includes(Q.get('professor'))) E.professor = Q.get('professor');
  await carregarPresets();
  try { const r = await (await fetch('/api/estado')).json(); $('#chipGroq').classList.add(r.groq ? 'ok' : 'falta'); if (!r.groq) $('#chipGroq').title = 'Falta a chave da Groq no servidor'; } catch { $('#chipGroq').classList.add('falta'); }
  // o navegador precisa codificar H.264 e AAC (Chrome 94+, Safari 26+, Firefox 130+); avisa na hora, não na exportação
  try {
    const c = await verificarCodecs();
    const chip = $('#chipCodec');
    if (!c.video) { chip.classList.add('falta'); chip.title = 'Este navegador não codifica H.264 — a exportação não vai funcionar'; chip.lastChild.textContent = 'sem H.264'; }
    else if (!c.audio) { chip.classList.add('falta'); chip.title = 'Este navegador não codifica áudio — a exportação sai muda'; chip.lastChild.textContent = 'sem áudio'; }
    else { chip.classList.add('ok'); chip.title = `Exporta H.264 + ${c.audio.toUpperCase()} neste navegador`; chip.lastChild.textContent = `H.264 + ${c.audio.toUpperCase()}`; }
  } catch (e) { const chip = $('#chipCodec'); chip.classList.add('falta'); chip.title = 'Sem WebCodecs neste navegador'; chip.lastChild.textContent = 'sem WebCodecs'; }
  const solta = $('#solta'), inp = $('#arquivos');
  slotsVazios();
  $('#btEscolher').addEventListener('click', ev => { ev.stopPropagation(); inp.click(); });
  // o painel de abrir projeto mora dentro da área de soltar: clique nele (Cancelar, lista) não abre o seletor
  // o painel de abrir projeto e o visualizador de revisão moram dentro da área de soltar: clique neles não abre o seletor
  solta.addEventListener('click', ev => { if (E.fase === 'vazio' && !E.revisando && !ev.target.closest('.pedido, .revisao')) inp.click(); });
  solta.addEventListener('keydown', ev => { if (E.fase === 'vazio' && !E.pedido && !E.revisando && (ev.key === 'Enter' || ev.key === ' ') && !ev.target.closest('.pedido, .revisao')) { ev.preventDefault(); inp.click(); } });
  $('#btRecomecar').addEventListener('click', () => location.reload());
  // «Bancada» no cabeçalho volta para a tela inicial (mantém o professor; o projeto aberto já está salvo sozinho)
  $('#marca').addEventListener('click', ev => {
    ev.preventDefault();
    if (E.fase === 'exportando' && !confirm('A exportação ainda está rodando. Sair mesmo assim?')) return;
    if (E.fase === 'lendo' && !confirm('A mesa ainda está sendo montada. Sair mesmo assim?')) return;
    location.href = `./?professor=${E.professor}`;
  });
  $('#btFx').addEventListener('click', () => $('#arquivosFx').click());
  $('#arquivosFx').addEventListener('change', ev => { receberFx(ev.target.files); ev.target.value = ''; });
  $('#btFxTodas').addEventListener('click', fxEmTodasEmendas);
  $('#btSalvar').addEventListener('click', salvarResultado);
  $('#btVerResultado').addEventListener('click', verResultado);
  inp.addEventListener('change', () => entrar(inp.files));
  for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, e => { e.preventDefault(); solta.classList.add('sobre'); });
  for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); solta.classList.remove('sobre'); });
  document.addEventListener('drop', e => { if (E.fase === 'vazio' && e.dataTransfer?.files?.length) entrar(e.dataTransfer.files); });
  ligarArrastoNaFita();
  window.__bancada = { soltarFxNaEmenda, emendasNaFita, verEmenda };
  $('#btPlay').addEventListener('click', () => alternarPlay());
  $('#scrub').addEventListener('input', ev => previa.irPara((ev.target.value / 1000) * previa.duracao));
  $('#btExportar').addEventListener('click', exportar);
  $('#btCancelar').addEventListener('click', () => abortar?.abort());
  $('#btRelatorio')?.addEventListener('click', async () => { await navigator.clipboard.writeText(relatorio()); $('#btRelatorio').textContent = 'Copiado'; setTimeout(() => $('#btRelatorio').textContent = 'Copiar relatório', 1500); });
  document.addEventListener('keydown', ev => {
    if (ev.target.matches('input, textarea')) return;
    if (ev.key === ' ' && E.fase === 'pronto') { ev.preventDefault(); alternarPlay(); }
  });
  ligarPainelEstilo();
  desenharPainelEstilo();
  ligarProjetos();
  ligarRegras();
  carregarRegras();
  desenharProjetos();
  // chegou pelo link de revisão (?revisar=<id>): abre o visualizador direto e limpa o parâmetro da barra
  if (Q.get('revisar')) { const id = Q.get('revisar'); history.replaceState(null, '', `${location.pathname}?professor=${E.professor}`); abrirRevisao(id); }
  // veio do diário: abre o projeto (pede os brutos ou o Drive) e, na mesa, vai para o ponto reportado
  if (Q.get('abrir')) { const id = Q.get('abrir'); E.irPara = { clipe: +(Q.get('clipe') || 0), tClipe: +(Q.get('t') || 0) }; history.replaceState(null, '', `${location.pathname}?professor=${E.professor}`); abrirProjeto(id); }
  window.__E = E;
  // o robô (robo/robo.mjs) dirige a página por aqui: abre projeto, define o fluxo, salva antes de fechar
  window.__bancada.abrirProjeto = abrirProjeto;
  window.__bancada.entrar = entrar;
  window.__bancada.assinaturaPlano = assinaturaPlano;
  window.__bancada.definirFluxo = f => { E.fluxo = { ...(E.fluxo || {}), ...f }; salvoAss = ''; desenharFluxo(); };
  window.__bancada.definirNome = n => { if (E.projeto) { E.projeto.nome = n; $('#projetoNome').value = n; salvoAss = ''; } };
  window.__bancada.salvarAgora = async () => { salvoAss = ''; await tentarSalvar(true); return E.projeto?.editadoEm; };
  Object.defineProperty(window, '__previa', { get: () => previa });
  // modo de teste: ?teste carrega os brutos servidos em /teste/ sem precisar arrastar
  if (new URLSearchParams(location.search).has('teste')) {
    const lista = await (await fetch('/teste/lista.json')).json();
    const files = [];
    for (const n of lista) { const b = await (await fetch(`/teste/${encodeURIComponent(n)}`)).blob(); files.push(new File([b], n, { type: 'video/mp4' })); }
    await entrar(files);
    try {
      const fx = await (await fetch('/teste/fx/lista.json')).json();
      const fxFiles = [];
      for (const n of fx) { const b = await (await fetch(`/teste/fx/${encodeURIComponent(n)}`)).blob(); fxFiles.push(new File([b], n, { type: 'video/mp4' })); }
      if (fxFiles.length) await receberFx(fxFiles);
    } catch (e) { console.warn('sem transições de teste', e); }
  }
}
iniciar();
