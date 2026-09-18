// Diário do professor: reportes (erro num ponto do vídeo) + cortes desligados com o porquê, do mais novo para o
// mais velho, com link que abre a mesa do projeto naquele ponto (?abrir=<id>&clipe=&t=).
const PROFESSORES = ['jaylton', 'pablo', 'andre'];
const $ = s => document.querySelector(s);
const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`.replace('.', ','); };
const quando = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const Q = new URLSearchParams(location.search);
let professor = PROFESSORES.includes(Q.get('professor')) ? Q.get('professor') : 'jaylton';
let itens = [];

async function montarCabecalho() {
  const grupo = $('#professores');
  for (const p of PROFESSORES) {
    const pr = await (await fetch(`presets/${p}.json`)).json();
    const b = el('button', null); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.professor = p; b.setAttribute('aria-checked', String(p === professor));
    if (pr.foto) { const f = el('img', 'prof-foto'); f.src = pr.foto; f.alt = ''; f.width = 22; f.height = 22; b.append(f); }
    b.append(el('span', null, pr.nome));
    b.addEventListener('click', () => { professor = p; history.replaceState(null, '', `?professor=${p}`); grupo.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.professor === p))); $('#titulo').textContent = `Diário do ${pr.nome}`; carregar(); });
    grupo.append(b);
    if (p === professor) $('#titulo').textContent = `Diário do ${pr.nome}`;
  }
}
const linha = i => i.fonte === 'reporte'
  ? `${quando(i.quando)} · ${i.nome} · ${fmt(i.tSaida)} · ${i.tipo}${i.texto ? ` · ${i.texto}` : ''}${i.trecho ? ` · «${i.trecho}»` : ''} · ${i.quem || '—'}`
  : `${quando(i.quando)} · ${i.nome} · ${fmt(i.de)}–${fmt(i.ate)} · corte ${i.tipo}${i.motivo ? ` (${i.motivo})` : ''} · ${i.acao}${i.porque ? `: ${i.porque}` : ''}${i.texto ? ` · «${i.texto}»` : ''} · ${i.quem || '—'}`;

async function carregar() {
  const ul = $('#lista'); ul.innerHTML = '';
  try { itens = (await (await fetch(`/api/feedback?professor=${professor}`, { cache: 'no-store' })).json()).itens || []; }
  catch (e) { ul.append(el('li', 'diario-vazio', `Não deu para ler o diário: ${e.message}`)); return; }
  if (!itens.length) { ul.append(el('li', 'diario-vazio', 'Nenhum reporte nem correção ainda. Na mesa ou no visualizador, «Reportar erro» no ponto do vídeo; ao desligar um corte da IA, o «Por quê?».')); return; }
  for (const i of itens) {
    const li = el('li');
    const esq = el('div');
    esq.append(el('div', 'quando', `${quando(i.quando)} · ${i.quem || '—'} · ${i.nome}${i.bruto ? ` · ${i.bruto}` : ''}`));
    if (i.fonte === 'reporte') {
      esq.append(el('div', 'tipo', `${fmt(i.tSaida)} · ${i.tipo}`));
      if (i.texto) esq.append(el('div', 'texto', i.texto));
      if (i.trecho) esq.append(el('div', 'trecho', `«${i.trecho}»`));
    } else {
      esq.append(el('div', 'tipo corte', `${fmt(i.de)}–${fmt(i.ate)} · corte ${i.tipo}${i.motivo ? ` · ${i.motivo}` : ''}`));
      esq.append(el('div', 'texto', i.acao === 'manteve' ? `manteve: ${i.porque || 'sem motivo'}` : `${i.acao}: ${i.porque || ''}`));
      if (i.texto) esq.append(el('div', 'trecho', `«${i.texto}»`));
    }
    const a = el('a', 'bt bt-mini', 'Abrir na mesa'); a.href = `./?professor=${professor}&abrir=${i.projeto}&clipe=${i.clipe || 0}&t=${i.fonte === 'reporte' ? i.tClipe : i.de}`;
    li.append(esq, a);
    ul.append(li);
  }
}
$('#btCopiar').addEventListener('click', async () => {
  const texto = `Diário do ${professor} · ${new Date().toLocaleDateString('pt-BR')}\n` + itens.map(linha).join('\n');
  try { await navigator.clipboard.writeText(texto); $('#btCopiar').textContent = 'Copiado'; } catch { prompt('Copie:', texto); }
  setTimeout(() => { $('#btCopiar').textContent = 'Copiar em texto'; }, 1500);
});
await montarCabecalho();
await carregar();
