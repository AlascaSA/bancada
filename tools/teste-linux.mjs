// Roda de dentro de robo/ (onde o playwright está instalado): edita teste/01.mp4 na Bancada publicada usando
// o Google Chrome da máquina, exporta, baixa e confere o MP4 com o ffprobe. É o que o GitHub Actions faz.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
const SITE = (process.env.BANCADA_SITE || 'https://bancada-6x9.pages.dev').replace(/\/$/, '');
const CLIPE = new URL('../teste/01.mp4', import.meta.url).pathname;
const DESTINO = process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP + '/teste-linux.mp4' : '/tmp/teste-linux.mp4';
const browser = await chromium.launch({ channel: process.env.BANCADA_NAVEGADOR === 'chromium' ? undefined : 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
await page.addInitScript(() => { const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return p.call(this); }; });
const erros = [];
page.on('pageerror', e => erros.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') erros.push('CONSOLE ' + m.text().slice(0, 160)); });
await page.goto(`${SITE}/?professor=jaylton`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__E, null, { timeout: 60000 });
console.log('codecs do navegador:', await page.evaluate(() => document.querySelector('#chipCodec')?.title));
const t0 = Date.now();
await page.setInputFiles('#arquivos', [CLIPE]);
await page.waitForFunction(() => window.__E.fase === 'pronto' || window.__E.fase === 'erro', null, { timeout: 600000, polling: 1000 });
if (await page.evaluate(() => window.__E.fase) !== 'pronto') { console.log('mesa falhou:', await page.evaluate(() => document.querySelector('#erroTexto')?.textContent), erros); process.exit(1); }
const info = await page.evaluate(() => ({ cortes: window.__E.cortes.length, cues: window.__E.cues.length, etapas: Object.fromEntries(Object.entries(window.__E.tempos.etapas).map(([k, v]) => [k, +v.toFixed(1)])) }));
console.log(`mesa pronta em ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(info));
const id = await page.evaluate(() => window.__E.projeto?.id);
await page.click('#btExportar');
await page.waitForFunction(() => !document.querySelector('#resultado').hidden || window.__E.fase === 'erro', null, { timeout: 900000, polling: 1000 });
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btSalvar')]);
await dl.saveAs(DESTINO);
console.log(`export em ${((Date.now() - t0) / 1000).toFixed(1)} s · ${(statSync(DESTINO).size / 1e6).toFixed(1)} MB`);
console.log('ffprobe:', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,profile', '-of', 'csv=p=0', DESTINO], { encoding: 'utf8' }).trim().replace(/\n/g, ' | '));
if (id) { await page.goto(`${SITE}/`); await page.evaluate(id => fetch(`/api/projetos/${id}?professor=jaylton`, { method: 'DELETE' }), id); }
console.log('erros:', erros.length ? erros.join(' || ') : 'nenhum');
await browser.close();
