#!/usr/bin/env node
// Robô da Bancada — o «funcionário» que a Giovana pediu. Roda na nuvem (GitHub Actions, disparado pelo
// vigia/ quando cai bruto novo) ou em qualquer máquina com Node + Playwright:
//   1. vigia a pasta de brutos de cada professor no Drive (a que a equipe já usa);
//   2. baixa cada bruto novo e edita na própria Bancada publicada (navegador sem tela, mudo);
//   3. sobe o MP4 em «Em revisão» (subpasta da pasta de brutos) e deixa o projeto na etapa «revisão do editor»;
//   4. quando a equipe muda a mesa depois do render, renderiza de novo e substitui o MP4 (mesmo link);
//   5. a entrega na pasta de prontos é o botão «Aprovar» da Bancada (Pages Function), não o robô.
// Config (pastas por professor): robo/pastas.json  {site, profs:{<id>:{nome, brutos:<pasta no Drive>, prontos:<pasta de entrega>}}}
//   — BANCADA_CONFIG (JSON) ou ~/Library/Application Support/Bancada/robo.json, se existirem, mandam.
// Credenciais do Drive: GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN, ou os arquivos de ~/.claude/.google (ver drive.mjs).
// Navegador: BANCADA_NAVEGADOR = webkit (padrão no Mac) | chrome (Linux: Google Chrome, codecs por software) | chromium.
// Pasta de trabalho: BANCADA_DIR (padrão ~/Library/Application Support/Bancada).
// Uso: node robo.mjs --uma-vez            (uma volta e sai — é assim que a nuvem roda)
//      node robo.mjs                      (fica rodando, uma volta a cada 2 min)
//      node robo.mjs --subir <arquivo> <professor>  (sobe um bruto para a pasta do professor)
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium } from 'playwright';
import * as drive from './drive.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BANCADA_DIR || join(homedir(), 'Library', 'Application Support', 'Bancada');
function lerConfig() {
  if (process.env.BANCADA_CONFIG) return JSON.parse(process.env.BANCADA_CONFIG);
  const local = join(homedir(), 'Library', 'Application Support', 'Bancada', 'robo.json');
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  return JSON.parse(readFileSync(join(AQUI, 'pastas.json'), 'utf8'));
}
const CFG = lerConfig();
const SITE = (process.env.BANCADA_SITE || CFG.site).replace(/\/$/, '');
const NAV = process.env.BANCADA_NAVEGADOR || 'webkit';
const ESTADO_ARQ = join(BASE, 'robo-estado.json');
const BRUTOS = join(BASE, 'brutos'), SAIDAS = join(BASE, 'saidas');
for (const d of [BRUTOS, SAIDAS]) mkdirSync(d, { recursive: true });
const UMA_VEZ = process.argv.includes('--uma-vez');
const INTERVALO = +(process.env.BANCADA_INTERVALO || 120) * 1000;
const MAX_FALHAS = 3, ESPERA_FALHA = 15 * 60e3, QUIETO = +(process.env.BANCADA_QUIETO ?? 90) * 1000;   // rerender só com a mesa parada há 90 s

const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { hour12: false, timeZone: 'America/Sao_Paulo' }), ...a);
const lerEstado = () => { try { return JSON.parse(readFileSync(ESTADO_ARQ, 'utf8')); } catch { return { feitos: {}, falhas: {} }; } };
const gravarEstado = e => writeFileSync(ESTADO_ARQ, JSON.stringify(e, null, 1));
const estado = lerEstado();
const semExt = n => n.replace(/\.[^.]+$/, '');
const nomeEditado = n => semExt(n).replace(/^BR\s*-\s*/i, '').trim() + '.mp4';   // cadeia do Playbook: bruto BR-x → editado x

async function api(caminho, init) {
  const r = await fetch(`${SITE}${caminho}`, init);
  if (!r.ok) throw new Error(`Bancada ${r.status} ${caminho}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const listarTodos = () => api('/api/projetos?professor=todos').then(d => d.projetos);   // 1 list no KV para os 3 professores (1.000/dia grátis)
// lê o projeto inteiro (a lista só traz o resumo), aplica `mudar(fluxo)` e grava
const mudarFluxo = async (prof, id, mudar) => { const p = await api(`/api/projetos/${id}?professor=${prof}`); p.fluxo = { ...(p.fluxo || {}), ...mudar(p.fluxo || {}) }; await api(`/api/projetos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); };

// ---- navegador: uma página da Bancada publicada, muda, com nome «Robô»
async function abrirNavegador() {
  if (NAV === 'chrome') return chromium.launch({ channel: 'chrome' });
  if (NAV === 'chromium') return chromium.launch();
  return webkit.launch();
}
async function abrirPagina(browser, prof) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return p.call(this); };
    try { localStorage.setItem('bancada.quem', 'Robô'); } catch {}
    try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}   // Chrome: sem tela o seletor de salvar nunca fecha
  });
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push(m.text().slice(0, 160)); });
  await page.goto(`${SITE}/?robo&professor=${prof}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__E && !!window.__bancada?.salvarAgora, null, { timeout: 60000 });
  return { page, ctx, erros };
}
async function esperarPronto(page, minutos) {
  // também sai na hora se o painel «Abrir projeto» recusou o arquivo (senão eram 20 min de espera por nada)
  await page.waitForFunction(() => window.__E.fase === 'pronto' || window.__E.fase === 'erro' || (window.__E.pedido && document.querySelector('#pedidoAviso')?.textContent), null, { timeout: minutos * 60e3, polling: 1000 });
  const fase = await page.evaluate(() => window.__E.fase);
  if (fase === 'erro') throw new Error('a mesa falhou: ' + await page.evaluate(() => document.querySelector('#erroTexto')?.textContent));
  if (fase !== 'pronto') throw new Error('o projeto recusou o arquivo: ' + await page.evaluate(() => document.querySelector('#pedidoAviso')?.textContent));
}
async function exportar(page, destino, minutos) {
  await page.click('#btExportar');
  await page.waitForFunction(() => !document.querySelector('#resultado').hidden || window.__E.fase === 'erro', null, { timeout: minutos * 60e3, polling: 1000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btSalvar')]);
  await dl.saveAs(destino);
  garantirAac(destino);
  return page.evaluate(() => window.__bancada.assinaturaPlano());
}
// no Linux o Chrome não codifica AAC (sai Opus dentro do MP4): reencoda só o áudio com o ffmpeg, vídeo intacto
function garantirAac(arquivo) {
  let codec = '';
  try { codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', arquivo], { encoding: 'utf8' }).trim(); } catch { return; }
  if (!codec || codec === 'aac') return;
  const tmp = arquivo + '.aac.mp4';
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', arquivo, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
  renameSync(tmp, arquivo);
  log(`   áudio ${codec} → aac`);
}

// O Chrome do runner não decodifica HEVC (iPhone), ProRes, 10 bits… : o que não for H.264 8 bits vira um proxy
// H.264 (lado menor ≤ 1080) ao lado do original, e é o proxy que entra na mesa. Tempos não mudam.
function prepararBruto(original, proxy) {
  if (existsSync(proxy)) return proxy;
  let streams;
  try { streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', original], { encoding: 'utf8' })).streams || []; } catch { return original; }
  const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio');
  const videoOk = v && v.codec_name === 'h264' && (!v.pix_fmt || /^yuvj?420p$/.test(v.pix_fmt));
  const audioOk = !a || ['aac', 'mp3', 'opus'].includes(a.codec_name);
  if (videoOk && audioOk) return original;
  log(`   ${v?.codec_name || '?'}${v?.pix_fmt ? '/' + v.pix_fmt : ''}${a ? ' + ' + a.codec_name : ''} → proxy h264/aac`);
  mkdirSync(dirname(proxy), { recursive: true });
  const tmp = proxy + '.tmp' + extname(proxy);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', original, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gte(iw,ih),-2,min(iw,1080))':'if(gte(iw,ih),min(ih,1080),-2)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
  renameSync(tmp, proxy);
  return proxy;
}
// A mesa nem chegou a existir (vídeo que não abre, sem áudio…): grava um projeto-marcador com o erro, para o cartão
// mostrar «o robô falhou» e o vigia não acordar o robô de novo a cada 5 min. Apagar o cartão = tentar de novo.
async function marcarFalha(prof, arq, msg) {
  const P = CFG.profs[prof], id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, agora = Date.now(), tamanho = +arq.size || 0;
  await api(`/api/projetos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    id, professor: prof, nome: semExt(arq.name), criadoEm: agora, editadoPor: 'Robô', versao: 1, duracao: 0,
    brutos: [{ nome: arq.name, tamanho, palavras: [] }], transicoes: [], cortes: [], edicoes: [], deslocs: [], emendaFx: [], estilo: {}, revisao: {}, feedback: [], reportes: [],
    fluxo: { etapa: 'editor', erro: String(msg).slice(0, 300), bruto: { driveId: arq.id, nome: arq.name, tamanho, pastaId: P.brutos }, entrega: { pastaId: P.prontos }, historico: [{ quando: agora, quem: 'Robô', o: `falhou: ${String(msg).slice(0, 120)}` }] },
  }) });
  return id;
}

// ---- 1 bruto novo → mesa → MP4 em «Em revisão» → projeto na etapa do editor
async function editarBruto(browser, prof, arq) {
  const P = CFG.profs[prof];
  const pasta = join(BRUTOS, arq.id); mkdirSync(pasta, { recursive: true });
  const local = join(pasta, arq.name), tamanho = +arq.size || 0;
  log(`[${prof}] ${arq.name}: baixando ${(tamanho / 1e6).toFixed(0)} MB`);
  await drive.baixar(arq.id, local, tamanho);
  const usar = prepararBruto(local, join(pasta, 'proxy', arq.name));
  const { page, ctx, erros } = await abrirPagina(browser, prof);
  let id = null;
  try {
    log(`[${prof}] ${arq.name}: editando`);
    await page.setInputFiles('#arquivos', [usar]);
    await esperarPronto(page, 40);
    id = await page.evaluate(() => window.__E.projeto.id);
    await page.evaluate(n => window.__bancada.definirNome(n), semExt(arq.name));
    // marca o bruto no projeto já aqui: se o render falhar, o cartão mostra o erro e o bruto não é editado duas vezes
    await page.evaluate(f => window.__bancada.definirFluxo(f), { etapa: 'editor', pedirRender: false, bruto: { driveId: arq.id, nome: arq.name, tamanho, pastaId: P.brutos }, entrega: { pastaId: P.prontos } });
    await page.evaluate(() => window.__bancada.salvarAgora());
    const info = await page.evaluate(() => ({ cortes: window.__E.cortes.length, ligados: window.__E.cortes.filter(k => k.ligado).length, cues: window.__E.cues.length, dur: window.__E.clipes[0].duracao }));
    log(`[${prof}] ${arq.name}: mesa pronta (${info.ligados}/${info.cortes} cortes, ${info.cues} legendas, ${info.dur.toFixed(0)} s) · renderizando`);
    const saida = join(SAIDAS, `${id}.mp4`);
    const assinatura = await exportar(page, saida, 60);
    const nomeSaida = nomeEditado(arq.name);
    const pastaRev = await drive.acharOuCriarPasta('Em revisão', P.brutos);
    log(`[${prof}] ${arq.name}: subindo «${nomeSaida}»`);
    for (const velho of await drive.porNome(pastaRev, nomeSaida)) await drive.apagar(velho.id);   // mesmo nome já em revisão (bruto reenviado): o antigo vai à lixeira
    const saidaId = await drive.subir(saida, nomeSaida, pastaRev);
    const agora = Date.now();
    await page.evaluate(f => window.__bancada.definirFluxo(f), {
      saida: { driveId: saidaId, nome: nomeSaida, pastaId: pastaRev, geradoEm: agora, assinatura },
      historico: [{ quando: agora, quem: 'Robô', o: 'editado pela IA' }],
    });
    await page.evaluate(() => window.__bancada.salvarAgora());
    await page.waitForTimeout(1500);
    log(`[${prof}] ${arq.name}: pronto → projeto ${id}${erros.length ? ` (avisos: ${erros.slice(0, 2).join(' | ')})` : ''}`);
    return id;
  } catch (e) {
    // o erro fica num cartão («o robô falhou»), em vez de tentar de novo em silêncio a cada volta
    if (id) { try { await page.evaluate(m => window.__bancada.definirFluxo({ erro: m }), String(e.message).slice(0, 300)); await page.evaluate(() => window.__bancada.salvarAgora()); await page.waitForTimeout(1200); } catch {} }
    else { try { await marcarFalha(prof, arq, e.message); } catch (e2) { log('   não deu para marcar a falha:', e2.message); } }
    throw e;
  } finally { await ctx.close(); }
}

// ---- mesa mudou depois do render → reabre pelo projeto (transcrição já salva) e substitui o MP4
async function rerender(browser, prof, meta) {
  const proj = await api(`/api/projetos/${meta.id}?professor=${prof}`);
  const f = proj.fluxo; if (!f?.bruto?.driveId || !f.saida?.driveId) return;
  const local = join(BRUTOS, f.bruto.driveId, f.bruto.nome);
  if (!existsSync(local)) { mkdirSync(join(BRUTOS, f.bruto.driveId), { recursive: true }); log(`[${prof}] ${proj.nome}: baixando o bruto (${(f.bruto.tamanho / 1e6).toFixed(0)} MB)`); await drive.baixar(f.bruto.driveId, local, f.bruto.tamanho); }
  const usar = prepararBruto(local, join(BRUTOS, f.bruto.driveId, 'proxy', f.bruto.nome));
  const { page, ctx } = await abrirPagina(browser, prof);
  try {
    log(`[${prof}] ${proj.nome}: mesa mudou, renderizando de novo`);
    await page.evaluate(id => window.__bancada.abrirProjeto(id), meta.id);
    await page.waitForFunction(() => !!window.__E.pedido, null, { timeout: 30000 });
    // o projeto casa bruto por nome+tamanho; o proxy refeito pode ter tamanho diferente do que a mesa gravou — aqui o id do Drive é a prova
    await page.evaluate(([nome, tamanho]) => { for (const b of window.__E.pedido.proj.brutos) if (b.nome === nome) b.tamanho = tamanho; }, [f.bruto.nome, statSync(usar).size]);
    await page.setInputFiles('#arquivos', [usar]);
    await esperarPronto(page, 10);
    const saida = join(SAIDAS, `${meta.id}.mp4`);
    const assinatura = await exportar(page, saida, 60);
    await drive.subir(saida, f.saida.nome, f.saida.pastaId, f.saida.driveId);
    await page.evaluate(x => window.__bancada.definirFluxo(x), { pedirRender: false, saida: { ...f.saida, geradoEm: Date.now(), assinatura } });
    await page.evaluate(() => window.__bancada.salvarAgora());
    await page.waitForTimeout(1500);
    log(`[${prof}] ${proj.nome}: MP4 substituído`);
  } finally { await ctx.close(); }
}

async function volta(browser) {
  let todos;
  try { todos = await listarTodos(); } catch (e) { log(`lista falhou: ${e.message}`); return; }
  for (const prof of Object.keys(CFG.profs)) {
    const projetos = todos.filter(p => p.professor === prof);
    const jaFeitos = new Set(projetos.map(p => p.fluxo?.brutoId).filter(Boolean));
    let arquivos;
    try { arquivos = await drive.listarVideos(CFG.profs[prof].brutos); } catch (e) { log(`[${prof}] Drive falhou: ${e.message}`); continue; }
    for (const arq of arquivos) {
      if (estado.feitos[arq.id] || jaFeitos.has(arq.id)) continue;
      const falha = estado.falhas[arq.id];
      if (falha && (falha.n >= MAX_FALHAS || Date.now() - falha.quando < ESPERA_FALHA)) continue;
      try {
        const id = await editarBruto(browser, prof, arq);
        estado.feitos[arq.id] = { projeto: id, quando: Date.now(), nome: arq.name }; delete estado.falhas[arq.id]; gravarEstado(estado);
      } catch (e) {
        estado.falhas[arq.id] = { n: (falha?.n || 0) + 1, quando: Date.now(), erro: String(e.message).slice(0, 300), nome: arq.name }; gravarEstado(estado);
        log(`[${prof}] ${arq.name}: FALHOU (${estado.falhas[arq.id].n}/${MAX_FALHAS}): ${e.message}`);
      }
    }
    // render de novo: só o que a mesa pediu, ficou 90 s parado e ainda não falhou 2 vezes (senão vira laço: cada volta são minutos do GitHub)
    for (const p of projetos.filter(p => p.fluxo?.pedirRender && p.fluxo.etapa !== 'entregue' && !p.fluxo.erro && !(p.fluxo.renderErro >= 2) && Date.now() - p.editadoEm > QUIETO)) {   // na lista, renderErro é o número de falhas
      try { await rerender(browser, prof, p); }
      catch (e) {
        log(`[${prof}] ${p.nome}: rerender FALHOU: ${e.message}`);
        try { await mudarFluxo(prof, p.id, f => { const n = (f.renderErro?.n || 0) + 1; return { renderErro: { n, quando: Date.now(), msg: String(e.message).slice(0, 300) }, ...(n >= 2 ? { pedirRender: false } : {}) }; }); } catch (e2) { log('   não deu para anotar a falha:', e2.message); }
      }
    }
  }
}

// «node robo.mjs --subir <arquivo> <professor>»: sobe um bruto para a pasta do professor sem abrir o Drive (o robô pega na volta seguinte)
if (process.argv[2] === '--subir') {
  const [, , , arquivo, prof] = process.argv;
  if (!arquivo || !CFG.profs[prof]) { console.error(`uso: node robo.mjs --subir <arquivo.mp4> <${Object.keys(CFG.profs).join('|')}>`); process.exit(2); }
  const id = await drive.subir(arquivo, arquivo.split('/').pop(), CFG.profs[prof].brutos, null, (f, t) => process.stdout.write(`\r${Math.round(100 * f / t)}%`));
  console.log(`\nsubiu para a pasta de brutos do ${CFG.profs[prof].nome}: ${id}`);
  process.exit(0);
}
log(`robô da Bancada · ${SITE} · ${NAV} · pastas ${Object.keys(CFG.profs).join(', ')}${UMA_VEZ ? ' · uma volta' : ` · a cada ${INTERVALO / 1000} s`}`);
const browser = await abrirNavegador();
try {
  do {
    try { await volta(browser); } catch (e) { log('volta falhou:', e.message); }
    if (!UMA_VEZ) await new Promise(ok => setTimeout(ok, INTERVALO));
  } while (!UMA_VEZ);
} finally { await browser.close(); }
