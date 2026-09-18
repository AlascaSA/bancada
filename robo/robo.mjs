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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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
const listarProjetos = prof => api(`/api/projetos?professor=${prof}`).then(d => d.projetos);

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
  await page.waitForFunction(() => window.__E.fase === 'pronto' || window.__E.fase === 'erro', null, { timeout: minutos * 60e3, polling: 1000 });
  if (await page.evaluate(() => window.__E.fase) === 'erro') throw new Error('a mesa falhou: ' + await page.evaluate(() => document.querySelector('#erroTexto')?.textContent));
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

// ---- 1 bruto novo → mesa → MP4 em «Em revisão» → projeto na etapa do editor
async function editarBruto(browser, prof, arq) {
  const P = CFG.profs[prof];
  const pasta = join(BRUTOS, arq.id); mkdirSync(pasta, { recursive: true });
  const local = join(pasta, arq.name), tamanho = +arq.size || 0;
  log(`[${prof}] ${arq.name}: baixando ${(tamanho / 1e6).toFixed(0)} MB`);
  await drive.baixar(arq.id, local, tamanho);
  const { page, ctx, erros } = await abrirPagina(browser, prof);
  let id = null;
  try {
    log(`[${prof}] ${arq.name}: editando`);
    await page.setInputFiles('#arquivos', [local]);
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
    if (id) {   // a mesa existiu: deixa o erro no cartão em vez de tentar de novo em silêncio
      try { await page.evaluate(m => window.__bancada.definirFluxo({ erro: m }), String(e.message).slice(0, 300)); await page.evaluate(() => window.__bancada.salvarAgora()); await page.waitForTimeout(1200); } catch {}
    }
    throw e;
  } finally { await ctx.close(); }
}

// ---- mesa mudou depois do render → reabre pelo projeto (transcrição já salva) e substitui o MP4
async function rerender(browser, prof, meta) {
  const proj = await api(`/api/projetos/${meta.id}?professor=${prof}`);
  const f = proj.fluxo; if (!f?.bruto?.driveId || !f.saida?.driveId) return;
  const local = join(BRUTOS, f.bruto.driveId, f.bruto.nome);
  if (!existsSync(local)) { mkdirSync(join(BRUTOS, f.bruto.driveId), { recursive: true }); log(`[${prof}] ${proj.nome}: baixando o bruto (${(f.bruto.tamanho / 1e6).toFixed(0)} MB)`); await drive.baixar(f.bruto.driveId, local, f.bruto.tamanho); }
  const { page, ctx } = await abrirPagina(browser, prof);
  try {
    log(`[${prof}] ${proj.nome}: mesa mudou, renderizando de novo`);
    await page.evaluate(id => window.__bancada.abrirProjeto(id), meta.id);
    await page.waitForFunction(() => !!window.__E.pedido, null, { timeout: 30000 });
    await page.setInputFiles('#arquivos', [local]);
    await esperarPronto(page, 20);
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
  for (const prof of Object.keys(CFG.profs)) {
    let projetos;
    try { projetos = await listarProjetos(prof); } catch (e) { log(`[${prof}] lista falhou: ${e.message}`); continue; }
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
    for (const p of projetos.filter(p => p.fluxo?.pedirRender && p.fluxo.etapa !== 'entregue' && !p.fluxo.erro && Date.now() - p.editadoEm > QUIETO)) {
      try { await rerender(browser, prof, p); } catch (e) { log(`[${prof}] ${p.nome}: rerender FALHOU: ${e.message}`); }
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
