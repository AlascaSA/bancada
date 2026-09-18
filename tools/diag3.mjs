import { webkit } from 'playwright';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return p.call(this); }; });
const erros = [];
page.on('pageerror', e => erros.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') erros.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto('https://bancada-6x9.pages.dev/');
await page.waitForSelector('#professores button');
await page.waitForTimeout(1500);
const base = new URL('../teste/', import.meta.url).pathname;
const t0 = Date.now();
await page.setInputFiles('#arquivos', ['01.mp4', '02.mp4', '03.mp4'].map(n => base + n));
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => ({ fase: window.__E.fase, files: document.querySelector('#arquivos').files.length, etapas: [...document.querySelectorAll('#etapas li')].map(l => l.className.slice(0, 5) + ':' + l.textContent.slice(0, 26)).join(' | ') }));
  console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(s));
  if (s.fase === 'pronto' || s.fase === 'erro') break;
}
console.log('erros:', erros.length ? erros.join(' || ') : 'nenhum');
await browser.close();
