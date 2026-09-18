// Fluxo local com um professor escolhido: plano, troca de preset, export, e um quadro com legenda em PNG.
//   node tools/teste-preset.mjs andre      (servidor local em 8799 com ?teste=1; mudo)
import { webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
const prof = process.argv[2] || 'andre';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return p.call(this); }; });
const erros = [];
page.on('pageerror', e => erros.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') erros.push('CONSOLE ' + m.text().slice(0, 160)); });
await page.goto('http://localhost:8799/?teste=1');
await page.waitForFunction(() => window.__E && (window.__E.fase === 'pronto' || window.__E.fase === 'erro'), null, { timeout: 180000 });
await page.click(`#professores button[data-professor="${prof}"]`);
await page.waitForTimeout(800);
const estado = await page.evaluate(() => ({
  professor: window.__E.professor, preset: window.__E.preset.nome, fonte: window.__E.preset.legenda.fonte,
  marcado: document.querySelector('#professores button[aria-checked="true"]').dataset.professor,
  etiqueta: document.querySelector('#professores button[aria-checked="true"] .tag-teste')?.textContent || null,
  cortes: window.__E.cortes.length, cues: window.__E.cues.length,
  previa: (() => { const l = document.querySelector('.previa-legenda'); const cs = getComputedStyle(l); return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, top: cs.top, letterSpacing: cs.letterSpacing }; })(),
  foto: document.querySelector('#padraoFoto').getAttribute('src'), brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
  fonteOk: document.fonts.check(`${window.__E.preset.legenda.peso} 40px "${window.__E.preset.legenda.fonte}"`),
}));
console.log('estado:', JSON.stringify(estado));
await page.click('#btExportar');
await page.waitForFunction(() => !document.querySelector('#resultado').hidden, null, { timeout: 240000 });
console.log('export:', await page.evaluate(() => document.querySelector('#resultadoTexto').textContent));
console.log('erros:', erros.length ? erros.join(' || ') : 'nenhum');
await browser.close();
// quadro no meio de uma legenda para conferir a fonte de verdade
const cue = await (async () => { const { readFileSync } = await import('node:fs'); return null; })();
const saida = new URL('../teste/saida.mp4', import.meta.url).pathname;
const png = `/private/tmp/claude-501/-Users-gcosta-Documents-claude/4c5c5245-4b57-4ecb-b763-98ba047b07a1/scratchpad/quadro-${prof}.png`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '4.0', '-i', saida, '-frames:v', '1', '-vf', 'crop=1080:420:0:1300', png]);
console.log('quadro:', png);
