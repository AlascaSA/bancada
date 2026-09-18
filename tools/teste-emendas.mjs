import { webkit } from 'playwright';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:8799/?teste=1');
await page.waitForFunction(() => window.__E && window.__E.fase === 'pronto', null, { timeout: 60000 });
const segs = await page.evaluate(() => window.__E.segmentos.map(s => +s.saidaDe.toFixed(2)));
console.log('emendas em', segs.slice(1, 8).join(', '));
await page.click('#btPlay');
const am = [];
const t0 = Date.now();
while (Date.now() - t0 < 42000) {
  const a = await page.evaluate(() => { const vs = [...document.querySelectorAll('#previa video')]; return { t: document.querySelector('#tempoPrevia').textContent.split(' / ')[0], v: vs.map(v => [+v.currentTime.toFixed(2), v.paused ? 'p' : 'r', v.muted ? 'm' : 's', getComputedStyle(v).opacity]) }; });
  am.push({ ms: Date.now() - t0, ...a });
  await page.waitForTimeout(50);
}
// segurada = mesma leitura de tempo por >= 3 amostras (150 ms)
let seguradas = []; let run = 1;
for (let k = 1; k < am.length; k++) {
  if (am[k].t === am[k - 1].t) run++; else { if (run >= 3) seguradas.push(`${am[k-1].t} por ${run * 50}ms`); run = 1; }
}
console.log('seguradas >=150ms:', seguradas.join(' | ') || 'nenhuma');
// mostra o entorno de cada emenda
for (const e of segs.slice(1, 7)) {
  const perto = am.filter(a => { const [m, s] = a.t.split(':'); const t = +m * 60 + parseFloat(s.replace(',', '.')); return Math.abs(t - e) < 0.5; });
  console.log('emenda', e, perto.map(a => a.t + ' ' + a.v.map(x => x[0] + x[1] + x[2] + '/' + x[3]).join(' ')).join('  |  '));
}
await browser.close();
