// Robô de ponta a ponta contra um servidor (local ou publicado): rerender quando a mesa mudou,
// entrega em «Prontos» pelo botão Aprovar, e limpeza do que o teste deixou no Drive.
//   node teste-robo.mjs [url] [--limpar]
// Pressupõe um projeto do robô (fluxo.saida) na lista do Jaylton — o robô cria com
//   node ../robo/robo.mjs --subir ../teste/01.mp4 jaylton  +  BANCADA_SITE=<url> node ../robo/robo.mjs --uma-vez
import { execFileSync } from 'node:child_process';
import * as drive from '../robo/drive.mjs';
const URL = (process.argv[2] || 'http://127.0.0.1:8796').replace(/\/$/, '');
const LIMPAR = process.argv.includes('--limpar');
const falhas = [];
const ok = (cond, msg) => { console.log((cond ? 'OK  ' : 'ERRO') + ' ' + msg); if (!cond) falhas.push(msg); };
const api = async (c, init) => { const r = await fetch(`${URL}${c}`, init); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${c}: ${JSON.stringify(j).slice(0, 200)}`); return j; };
const projetoDoRobo = async () => (await api('/api/projetos?professor=jaylton')).projetos.find(p => p.fluxo?.saida && p.fluxo.etapa !== 'entregue');

let meta = await projetoDoRobo();
ok(!!meta, `projeto do robô: ${meta?.id} «${meta?.nome}» etapa ${meta?.fluxo?.etapa}`);
if (!meta) process.exit(1);
let proj = await api(`/api/projetos/${meta.id}?professor=jaylton`);
const saidaAntes = { ...proj.fluxo.saida };

// 1) mesa mudou (um corte desligado) → o robô renderiza de novo e substitui o MP4 no mesmo id
const k = proj.cortes.find(x => x.ligado && x.tipo !== 'cabeca' && x.tipo !== 'rabo') || proj.cortes.find(x => x.ligado);
k.ligado = false; proj.fluxo.pedirRender = true; proj.fluxo.etapa = 'final'; proj.fluxo.revisadoPor = 'Teste';
await api(`/api/projetos/${meta.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proj) });
console.log(`corte ${k.tipo} ${k.de.toFixed(2)}–${k.ate.toFixed(2)} desligado; rodando o robô…`);
const saida = execFileSync('node', [new globalThis.URL('../robo/robo.mjs', import.meta.url).pathname, '--uma-vez'], { env: { ...process.env, BANCADA_SITE: URL, BANCADA_QUIETO: '0' }, encoding: 'utf8' });
console.log(saida.trim().split('\n').map(l => '   ' + l).join('\n'));
proj = await api(`/api/projetos/${meta.id}?professor=jaylton`);
ok(saida.includes('MP4 substituído'), 'robô relatou o MP4 substituído');
ok(proj.fluxo.pedirRender === false && proj.fluxo.saida.driveId === saidaAntes.driveId && proj.fluxo.saida.geradoEm > saidaAntes.geradoEm, `fluxo: pedirRender ${proj.fluxo.pedirRender}, mesmo id ${proj.fluxo.saida.driveId === saidaAntes.driveId}, geradoEm avançou ${proj.fluxo.saida.geradoEm - saidaAntes.geradoEm} ms`);
ok(proj.cortes.find(x => x.id === k.id)?.ligado === false, 'o corte desligado continua desligado depois do rerender');
const m1 = await drive.meta(proj.fluxo.saida.driveId);
ok(m1.parents?.[0] === proj.fluxo.saida.pastaId, `MP4 continua em «Em revisão» (${m1.name}, ${(m1.size / 1e6).toFixed(1)} MB)`);

// 2) aprovar → move para «Prontos» sem reenviar
const ent = await api('/api/drive/entregar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ professor: 'jaylton', id: meta.id, quem: 'Teste' }) });
ok(ent.ok && ent.link, `entregar: ${ent.link}`);
ok(proj.fluxo.saida.nome === proj.fluxo.bruto.nome.replace(/\.[^.]+$/, '').replace(/^BR\s*-\s*/i, '') + '.mp4', `nome do editado segue a cadeia: «${proj.fluxo.saida.nome}» (bruto «${proj.fluxo.bruto.nome}»)`);
proj = await api(`/api/projetos/${meta.id}?professor=jaylton`);
const m2 = await drive.meta(proj.fluxo.saida.driveId);
const cfg = JSON.parse((await import('node:fs')).readFileSync(process.env.HOME + '/Library/Application Support/Bancada/robo.json', 'utf8'));
ok(m2.parents?.[0] === cfg.profs.jaylton.prontos && !m2.parents.includes(proj.fluxo.saida.pastaId), `MP4 agora na pasta de entrega (pais: ${m2.parents.join(',')})`);
ok(proj.fluxo.etapa === 'entregue' && proj.fluxo.aprovadoPor === 'Teste' && proj.fluxo.historico.at(-1).o.startsWith('aprovado'), `projeto: etapa ${proj.fluxo.etapa}, aprovado por ${proj.fluxo.aprovadoPor}`);
const rep = await api('/api/drive/entregar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ professor: 'jaylton', id: meta.id, quem: 'Teste' }) });
ok(rep.repetido === true, 'entregar de novo não move nada (repetido)');

// 3) limpeza: tira do Drive o bruto de teste e o MP4, e apaga o projeto
if (LIMPAR) {
  await drive.apagar(proj.fluxo.bruto.driveId).catch(e => console.log('   bruto já não estava lá:', e.message));
  await drive.apagar(proj.fluxo.saida.driveId).catch(e => console.log('   MP4 já não estava lá:', e.message));
  await fetch(`${URL}/api/projetos/${meta.id}?professor=jaylton`, { method: 'DELETE' });
  console.log('limpo: bruto, MP4 e projeto de teste apagados');
}
if (falhas.length) { console.log(`\n${falhas.length} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
