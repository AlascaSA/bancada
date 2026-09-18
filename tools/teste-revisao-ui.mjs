// Fluxo de revisão na tela (o que a Giovana pediu), contra um servidor local ou o publicado. Mudo.
//   node teste-revisao-ui.mjs [url]   — precisa de um projeto do robô (fluxo.saida) na lista do Jaylton
import { webkit } from 'playwright';
const URL = (process.argv[2] || 'http://127.0.0.1:8796').replace(/\/$/, '');
const FOTOS = new globalThis.URL('./.tmp/', import.meta.url).pathname;
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => { const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return p.call(this); }; try { if (!localStorage.getItem('bancada.quem')) localStorage.setItem('bancada.quem', 'Teste'); } catch {} });
const erros = [];
page.on('pageerror', e => erros.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') erros.push('CONSOLE ' + m.text().slice(0, 140)); });
page.on('dialog', d => d.accept('Teste'));
const falhas = [];
const ok = (cond, msg) => { console.log((cond ? 'OK  ' : 'ERRO') + ' ' + msg); if (!cond) falhas.push(msg); };

await page.goto(`${URL}/?professor=jaylton`);
await page.waitForFunction(() => !!window.__E && !!window.__bancada?.salvarAgora, null, { timeout: 60000 });
await page.waitForSelector('#projetos:not([hidden]) .projeto', { timeout: 30000 });
const cartoes = await page.evaluate(() => [...document.querySelectorAll('.projeto')].map(a => ({ id: a.dataset.id, nome: a.querySelector('.projeto-titulo').textContent, etapa: a.querySelector('.etapa-chip')?.textContent || '' })));
const robo = cartoes.find(c => c.etapa);
ok(!!robo, `cartão do robô na lista: ${JSON.stringify(robo)}`);
if (!robo) { console.log('erros:', erros.join(' | ') || 'nenhum'); await browser.close(); process.exit(1); }
// volta o projeto ao estado em que o robô o deixou (etapa do editor, todos os cortes, sem feedback) — o teste pode rodar de novo
await page.evaluate(async id => {
  const p = await (await fetch(`/api/projetos/${id}?professor=jaylton`, { cache: 'no-store' })).json();
  p.cortes = p.cortes.filter(k => k.tipo !== 'manual'); p.cortes.forEach(k => { k.ligado = true; });
  p.feedback = []; p.reportes = []; p.fluxo = { ...p.fluxo, etapa: 'editor', pedirRender: false, historico: (p.fluxo.historico || []).slice(0, 1) }; delete p.fluxo.revisadoPor;
  await fetch(`/api/projetos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
}, robo.id);
await page.reload(); await page.waitForFunction(() => !!window.__E && !!window.__bancada?.salvarAgora, null, { timeout: 60000 });
await page.waitForSelector(`#projetos:not([hidden]) .projeto[data-id="${robo.id}"]`, { timeout: 30000 });

// 1) visualizador: vídeo do Drive + etapa + botões
await page.click(`.projeto[data-id="${robo.id}"]`);
await page.waitForSelector('#revisao:not([hidden])');
await page.waitForFunction(() => { const v = document.querySelector('#revisaoVideo'); return v.readyState >= 1 && v.duration > 0; }, null, { timeout: 60000 });
const vis = await page.evaluate(() => ({ nome: document.querySelector('#revisaoNome').textContent, etapa: document.querySelector('#revisaoEtapa').textContent, dur: document.querySelector('#revisaoVideo').duration, botoes: [...document.querySelectorAll('#revisaoAcoes .bt')].map(b => b.textContent) }));
ok(vis.dur > 1, `visualizador toca o MP4 do Drive: «${vis.nome}» ${vis.dur.toFixed(1)} s · ${vis.etapa} · ${vis.botoes.join(' / ')}`);
await page.screenshot({ path: FOTOS + 'revisao-1-visualizador.png' });

// 2) editor marca como revisado → revisão final
await page.click('#revisaoAcoes .bt-primario');
await page.waitForFunction(() => document.querySelector('#revisaoEtapa').textContent.includes('final'));
ok(true, 'marcado como revisado → etapa «' + await page.textContent('#revisaoEtapa') + '»');
const salvo = await page.evaluate(async id => (await (await fetch(`/api/projetos/${id}?professor=jaylton`, { cache: 'no-store' })).json()).fluxo, robo.id);
ok(salvo.etapa === 'final' && salvo.revisadoPor === 'Teste', `servidor: etapa ${salvo.etapa}, revisado por ${salvo.revisadoPor}`);
// quem marcou não aprova: vê só «Voltar atrás»; outra pessoa vê aprovar/devolver
const bEditor = await page.$$eval('#revisaoAcoes .bt', b => b.map(x => x.textContent));
ok(bEditor.includes('Voltar atrás') && bEditor[0].startsWith('Copiar link') && !bEditor.some(t => t.startsWith('Aprovar')), `para quem marcou: ${bEditor.join(' / ')}`);
await page.evaluate(() => { window.__E.quem = 'Andressa'; localStorage.setItem('bancada.quem', 'Andressa'); });
await page.click('#revisaoAcoes .bt:nth-last-child(1)'); await page.click(`.projeto[data-id="${robo.id}"]`); await page.waitForSelector('#revisao:not([hidden])');
const bFinal = await page.$$eval('#revisaoAcoes .bt', b => b.map(x => x.textContent));
ok(bFinal[0] === 'Aprovar e enviar ao Drive' && bFinal[1] === 'Devolver ao editor', `para a revisão final (Andressa): ${bFinal.join(' / ')}`);
// link para a outra pessoa: copia e, aberto, cai direto no visualizador deste projeto
await page.evaluate(() => { window.__copiado = ''; navigator.clipboard.writeText = async t => { window.__copiado = t; }; });
await page.click('#revisaoAcoes .bt:nth-child(3)');
const link = await page.evaluate(() => window.__copiado);
ok(link.includes(`revisar=${robo.id}`) && link.includes('professor=jaylton'), `link copiado: ${link}`);
await page.goto(link);
await page.waitForSelector('#revisao:not([hidden])', { timeout: 60000 });
const barra = await page.evaluate(() => location.search);
ok((await page.textContent('#revisaoNome')) === robo.nome && !barra.includes('revisar='), `link abre o visualizador de «${await page.textContent('#revisaoNome')}» (barra: ${barra})`);

// 3) abrir a mesa: bruto vem do Drive pelo servidor
await page.click('#revisaoAcoes .bt:nth-last-child(2)');
await page.waitForSelector('#pedido:not([hidden])');
ok(!(await page.isHidden('#btPedidoDrive')), 'pedido oferece «Baixar o bruto do Drive»');
await page.click('#btPedidoDrive');
await page.waitForFunction(() => window.__E.fase === 'pronto' || window.__E.fase === 'erro', null, { timeout: 180000 });
ok(await page.evaluate(() => window.__E.fase) === 'pronto', 'mesa reaberta com o bruto do Drive');
const mesa = await page.evaluate(() => ({ etapa: document.querySelector('#fluxoEtapa').textContent, texto: document.querySelector('#fluxoTexto').textContent, botoes: [...document.querySelectorAll('#fluxoAcoes .bt')].map(b => b.textContent + (b.disabled ? ' (desligado)' : '')) }));
ok(mesa.etapa === 'Revisão final' && mesa.botoes[0] === 'Aprovar e enviar ao Drive', `mesa: ${mesa.etapa} · ${mesa.botoes.join(' / ')}`);
ok(mesa.texto.includes('exatamente esta mesa'), 'render corresponde à mesa: ' + mesa.texto);
await page.screenshot({ path: FOTOS + 'revisao-2-mesa.png' });
// 3b) reportar erro na mesa, no ponto em que a prévia está
await page.evaluate(() => window.__previa.irPara(3));
await page.click('#btReportar');
await page.waitForSelector('#reporteMesa:not([hidden])');
await page.click('#reporteMesa .porque-chip:has-text("cortou fala boa")');
await page.fill('#reporteMesa textarea', 'ele explica isso e a IA tirou');
await page.click('#reporteMesa .bt-primario');
await page.waitForFunction(() => window.__E.reportes.length === 1 && document.querySelector('#chipSalvo').textContent === 'salvo', null, { timeout: 20000 });
const rep1 = await page.evaluate(() => window.__E.reportes[0]);
ok(rep1.tipo === 'cortou fala boa' && Math.abs(rep1.tSaida - 3) < 0.3 && rep1.trecho.length > 0 && !(await page.isHidden('#mesaReportes')), `reporte na mesa salvo: ${rep1.tipo} · ${rep1.tSaida} s → clipe ${rep1.clipe} ${rep1.tClipe} s · «${rep1.trecho.slice(0, 40)}»`);
ok((await page.$$eval('#fita .reporte-marca', m => m.length)) === 1, 'marca do reporte na fita');
await page.screenshot({ path: FOTOS + 'revisao-3b-reporte-fita.png' });

// 4) desligar um corte da IA → «Por quê?» → chip → feedback; a mesa passa a pedir render
const n = await page.evaluate(() => window.__E.cortes.filter(k => k.ligado && k.tipo !== 'manual').length);
ok(n > 0, `${n} cortes ligados para testar`);
await page.click('#cortes .corte-linha:not(.desligado) .sw');
await page.waitForSelector('#cortes .porque');
ok(true, 'linha «Por quê?» apareceu: ' + (await page.$$eval('#cortes .porque .porque-chip', b => b.map(x => x.textContent).join(' | '))));
await page.screenshot({ path: FOTOS + 'revisao-3-porque.png' });
await page.click('#cortes .porque .porque-chip');
await page.waitForFunction(() => window.__E.feedback.length === 1);
const fb = await page.evaluate(() => window.__E.feedback[0]);
ok(fb.acao === 'manteve' && fb.porque === 'era ênfase, não erro' && typeof fb.texto === 'string', `feedback: ${fb.acao} · ${fb.porque} · «${fb.texto.slice(0, 40)}» · ${fb.tipo}`);
await page.waitForFunction(() => document.querySelector('#chipSalvo').textContent === 'salvo' && window.__E.fluxo.pedirRender === true, null, { timeout: 20000 });
const m2 = await page.evaluate(() => ({ etapa: document.querySelector('#fluxoEtapa').textContent, bt: document.querySelector('#fluxoAcoes .bt-primario').textContent, des: document.querySelector('#fluxoAcoes .bt-primario').disabled }));
ok(m2.etapa.includes('renderizando') && m2.des, `mesa mudou → «${m2.etapa}», aprovar ${m2.des ? 'travado' : 'LIVRE'} (${m2.bt})`);
// o diário lê o metadata da lista do KV, que demora até ~1 min para refletir a gravação: espera
let diario = [];
for (let t = 0; t < 12 && !diario.some(i => i.projeto === robo.id); t++) {
  if (t) await page.waitForTimeout(8000);
  diario = await page.evaluate(async () => (await (await fetch('/api/feedback?professor=jaylton', { cache: 'no-store' })).json()).itens);
}
ok(diario.some(i => i.projeto === robo.id && i.porque === 'era ênfase, não erro'), `diário do professor tem a correção (${diario.length} itens)`);

// 5) religar o corte → volta ao render atual, feedback some, aprovar libera
await page.click('#cortes .corte-linha.desligado .sw');
await page.waitForFunction(() => window.__E.feedback.length === 0 && document.querySelector('#chipSalvo').textContent === 'salvo' && window.__E.fluxo.pedirRender === false, null, { timeout: 20000 });
ok(!(await page.evaluate(() => document.querySelector('#fluxoAcoes .bt-primario').disabled)), 'religou o corte → aprovar liberado de novo');

// 6) regras do professor: salva, recarrega, entra no E.regras
await page.goto(`${URL}/?professor=jaylton`);
await page.waitForFunction(() => !!window.__E && !!window.__bancada?.salvarAgora, null, { timeout: 60000 });
await page.click('#btRegras');
await page.fill('#regrasTexto', 'Quando repete a frase de propósito para dar ênfase, não é erro: não cortar.');
await page.click('#btRegrasSalvar');
await page.waitForFunction(() => document.querySelector('#regrasEstado').textContent.startsWith('salvas agora'));
await page.reload(); await page.waitForFunction(() => !!window.__E && window.__E.regras.length > 0, null, { timeout: 60000 });
ok((await page.evaluate(() => window.__E.regras)).includes('ênfase'), 'regras voltam do servidor e entram na revisão por IA');
await page.evaluate(() => fetch('/api/regras/jaylton', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: '', quem: 'Teste' }) }));
await page.screenshot({ path: FOTOS + 'revisao-4-regras.png' });
// 7) diário: lista os reportes e o «Abrir na mesa» cai no ponto
await page.goto(`${URL}/diario.html?professor=jaylton`);
let nDiario = 0;
for (let t = 0; t < 12; t++) { if (t) await page.waitForTimeout(8000); nDiario = await page.$$eval('.diario-lista li .tipo', l => l.filter(x => x.textContent.includes('cortou fala boa')).length); if (nDiario) break; else await page.reload(); }
ok(nDiario >= 1, `diário lista o reporte (${nDiario})`);
await page.screenshot({ path: FOTOS + 'revisao-5-diario.png' });
await page.click('.diario-lista li:has(.tipo:has-text("cortou fala boa")) a.bt');
await page.waitForSelector('#pedido:not([hidden])', { timeout: 30000 });
await page.click('#btPedidoDrive');
await page.waitForFunction(() => window.__E.fase === 'pronto', null, { timeout: 180000 });
await page.waitForTimeout(600);
const tAgora = await page.evaluate(() => window.__previa.tempoAtual());
ok(Math.abs(tAgora - rep1.tSaida) < 0.6, `«Abrir na mesa» do diário caiu em ${tAgora.toFixed(2)} s (reporte em ${rep1.tSaida} s)`);

console.log('erros de página:', erros.join(' | ') || 'nenhum');
await browser.close();
if (falhas.length) { console.log(`\n${falhas.length} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
