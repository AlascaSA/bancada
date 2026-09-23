// Mede o alinhamento de cortes e legendas em projetos salvos (JSON de /api/projetos), usando a energia do áudio
// que o projeto guarda. Sem navegador, sem Groq.   node tools/alinhamento.mjs <pasta-ou-arquivos.json…>
//   corte que morde: o corte ligado começa com voz ainda soando (come o fim da palavra) ou acaba com voz já
//     soando (come o começo da seguinte) — mede quantos ms de voz ficaram dentro do corte na borda;
//   legenda adiantada/atrasada: início da legenda × primeira subida de voz da primeira palavra (no bruto);
//   legenda que some cedo / fica depois: fim da legenda × última voz da última palavra;
//   palavra em silêncio: depois de encostar, palavra cujo começo não tem voz nos 60 ms seguintes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Energia, encostarPalavras } from '../src/energy.js';
import { montarSegmentos } from '../src/cuts.js';
import { legendar } from '../src/captions.js';

const arquivos = process.argv.slice(2).flatMap(a => statSync(a).isDirectory() ? readdirSync(a).filter(f => f.endsWith('.json')).map(f => join(a, f)) : [a]);
const desemp = p => { const s = Buffer.from(p.b64, 'base64'), env = new Float32Array(p.n); for (let i = 0; i < p.n; i++) { const q = s[i] / 255; env[i] = q <= 0 ? 0 : p.max * Math.pow(10, (q - 1) * 80 / 20); } return env; };
const preset = { legenda: { larguraEm: 14 } };
const P = a => [...a].sort((x, y) => x - y), q = (a, f) => a.length ? P(a)[Math.min(a.length - 1, Math.floor(f * a.length))] : NaN;
const ms = x => Number.isNaN(x) ? '—' : `${Math.round(x * 1000)}`;
const tot = { cortes: 0, mordeFim: [], mordeIni: [], cues: 0, adiant: [], atras: [], fimCedo: [], fimTarde: [], palavras: 0, silencio: 0, curtas: 0, leads: [], sobras: [] };

for (const arq of arquivos) {
  let p; try { p = JSON.parse(readFileSync(arq, 'utf8')); } catch { continue; }
  if (!p.brutos?.length || !p.brutos.every(b => b.energia && b.palavras?.length)) continue;
  const clipes = p.brutos.map(b => ({ nome: b.nome, duracao: b.duracao, palavras: b.palavras, energia: new Energia(desemp(b.energia), b.energia.limiar, b.energia.hop || 0.01) }));
  const cortes = (p.cortes || []).filter(k => k.ligado);
  const r = { cortes: 0, mordeFim: [], mordeIni: [], adiant: [], atras: [], fimCedo: [], fimTarde: [], palavras: 0, silencio: 0, curtas: 0, cues: 0, piores: [], leads: [], sobras: [] };
  // 1) cortes: voz dentro do corte colada nas bordas
  for (const k of cortes) {
    if (k.tipo === 'manual') continue;
    const E = clipes[k.clipe].energia; r.cortes++;
    if (k.tipo !== 'cabeca') { const s = E.comecaSilencio(k.de, 1.5); const m = s == null ? 1.5 : s - k.de; if (m > 0.03) { r.mordeFim.push(m); r.piores.push(`corte ${k.tipo} ${k.de.toFixed(2)} começa com ${ms(m)} ms de voz`); } }
    if (k.tipo !== 'rabo') { let i = Math.floor(k.ate / E.hop) - 1, n = 0; while (i >= 0 && E.env[i] >= E.limiar && n < 150) { i--; n++; } const m = n * E.hop; if (m > 0.03) { r.mordeIni.push(m); r.piores.push(`corte ${k.tipo} ${k.ate.toFixed(2)} acaba ${ms(m)} ms dentro da voz`); } }
  }
  // 2) palavras encostadas que começam em silêncio
  for (const c of clipes) for (const w of encostarPalavras(c.palavras, c.energia)) { r.palavras++; if (c.energia.fracaoFala(w.de, w.de + 0.06) === 0) r.silencio++; }
  // 3) legendas × voz, no tempo do bruto
  const segs = montarSegmentos(clipes, cortes);
  const cues = legendar(clipes, segs, preset);
  const enc = clipes.map(c => encostarPalavras(c.palavras, c.energia));
  for (const cue of cues) {
    const s = cue.segmento, E = clipes[s.clipe].energia, de = cue.de - s.saidaDe + s.de, ate = cue.ate - s.saidaDe + s.de;
    const ws = enc[s.clipe].filter(w => (w.de + w.ate) / 2 >= s.de && (w.de + w.ate) / 2 < s.ate && w.ate > de - 0.05 && w.de < ate + 0.05);
    if (!ws.length) continue;
    r.cues++; if (cue.ate - cue.de < 0.7) r.curtas++;
    // só onde há pausa real (≥ 0,2 s sem voz) antes/depois: aí o começo e o fim da voz são inequívocos
    const todas = enc[s.clipe], i0 = todas.indexOf(ws[0]), i1 = todas.indexOf(ws[ws.length - 1]);
    const antes = todas[i0 - 1], depois = todas[i1 + 1];
    const quietoAntes = !antes || E.fracaoFala(antes.ate + 0.02, ws[0].de - 0.02) === 0 && ws[0].de - antes.ate >= 0.2;
    if (quietoAntes) {
      let i = Math.max(0, Math.floor(((antes ? antes.ate : 0) + 0.02) / E.hop)); while (i < E.env.length && E.env[i] < E.limiar) i++;
      const voz = i * E.hop, lead = voz - de;                 // + = legenda aparece antes da voz
      r.leads.push(lead);
      if (lead < -0.05) { r.atras.push(-lead); r.piores.push(`legenda «${cue.texto.slice(0, 30)}» entra ${ms(-lead)} ms DEPOIS da voz (depois de pausa)`); }
      if (lead > 0.35) { r.adiant.push(lead); r.piores.push(`legenda «${cue.texto.slice(0, 30)}» entra ${ms(lead)} ms antes da voz`); }
    }
    const ult = ws[ws.length - 1], quietoDepois = !depois || depois.de - ult.ate >= 0.2;
    if (quietoDepois) {
      const fimVoz = E.comecaSilencio(Math.max(0, ult.ate - 0.1), 2) ?? ult.ate, sobra = ate - fimVoz;
      r.sobras.push(sobra);
      if (sobra < -0.05) { r.fimCedo.push(-sobra); r.piores.push(`legenda «${cue.texto.slice(0, 30)}» some ${ms(-sobra)} ms antes da voz acabar (antes de pausa)`); }
      if (sobra > 0.6) r.fimTarde.push(sobra);
    }
  }
  for (const k of Object.keys(tot)) tot[k] = Array.isArray(tot[k]) ? tot[k].concat(r[k]) : tot[k] + r[k];
  console.log(`\n${p.nome || p.id} (${p.brutos.map(b => b.nome).join(', ')})`);
  console.log(`  cortes ${r.cortes}: começa na voz ${r.mordeFim.length} · acaba na voz ${r.mordeIni.length}   legendas ${r.cues} (${r.leads.length} depois de pausa, ${r.sobras.length} antes de pausa): atrasadas ${r.atras.length} · adiantadas >350ms ${r.adiant.length} · somem cedo ${r.fimCedo.length} · <0,7 s ${r.curtas}   palavras em silêncio ${r.silencio}/${r.palavras}`);
  for (const x of r.piores.slice(0, 6)) console.log('   · ' + x);
}
console.log(`\nTOTAL · cortes ${tot.cortes}: mordem o fim da palavra ${tot.mordeFim.length} (mediana ${ms(q(tot.mordeFim, .5))} ms, pior ${ms(q(tot.mordeFim, .99))}) · mordem o começo ${tot.mordeIni.length} (mediana ${ms(q(tot.mordeIni, .5))} ms)`);
console.log(`        legendas ${tot.cues}: atrasadas ${tot.atras.length} (mediana ${ms(q(tot.atras, .5))} ms, pior ${ms(q(tot.atras, .99))}) · adiantadas >350 ms ${tot.adiant.length} · somem antes da voz ${tot.fimCedo.length} (mediana ${ms(q(tot.fimCedo, .5))} ms) · ficam >600 ms depois ${tot.fimTarde.length} · curtas <0,7 s ${tot.curtas}`);
console.log(`        entrada depois de pausa (voz − legenda): mediana ${ms(q(tot.leads, .5))} ms, 10% ${ms(q(tot.leads, .1))}, 90% ${ms(q(tot.leads, .9))} · saída antes de pausa (legenda − fim da voz): mediana ${ms(q(tot.sobras, .5))} ms, 10% ${ms(q(tot.sobras, .1))}`);
console.log(`        palavras que começam em silêncio depois de encostar: ${tot.silencio}/${tot.palavras} (${(100 * tot.silencio / Math.max(1, tot.palavras)).toFixed(1)}%)`);
