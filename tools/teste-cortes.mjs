// Testes do planejador de cortes com palavras sintéticas (sem navegador).
import { planejarCortes, montarSegmentos } from '../src/cuts.js';
import { legendar } from '../src/captions.js';
import { encostarPalavras } from '../src/energy.js';
import { Energia } from '../src/energy.js';
const preset = { corte: { pausaMinima: 1.0, respiroSaida: 0.2, respiroEntrada: 0.12, cabecaRabo: true, soDepoisDeFrase: true } };
// energia sintética: fala (1) onde há palavra, silêncio (0) fora; `extraFala` força fala em intervalos sem palavra
function energia(palavras, dur, extraFala = []) {
  const env = new Float32Array(Math.round(dur / 0.01)).fill(0.01);
  const marca = (a, b, nivel = 1) => { for (let i = Math.floor(a / 0.01); i < Math.min(env.length, Math.ceil(b / 0.01)); i++) env[i] = nivel; };
  palavras.forEach(w => marca(w.de, w.ate));
  extraFala.forEach(([a, b, nivel]) => marca(a, b, nivel));
  return new Energia(env, 0.3);
}
// frase → palavras com 0,3 s cada, começando em t
function fala(t, texto) { return texto.split(' ').map((p, i) => ({ texto: p, de: t + i * 0.3, ate: t + i * 0.3 + 0.25 })); }
const casos = [];
// 1) refeitura truncada e curta (print 3): tentativa "Mas se você estudou, se preparou, ... é..." e recomeço
{
  const p = [...fala(1, 'Mas se você estudou, se preparou, construiu a melhor estratégia possível, algo que ninguém conseguiu é...'), ...fala(8.5, 'Mas se você estudou, se preparou, construiu a melhor estratégia possível.')];
  casos.push(['refeitura truncada', p, 14, [], c => c.some(k => k.tipo === 'refeitura' && k.de < 1 && Math.abs(k.ate - (8.5 - 0.12)) < 0.05)]);
}
// 2) refeitura de parágrafo: 7 palavras iguais 15 s depois (print 6)
{
  const p = [...fala(1, 'O iniciante acredita que precisa ganhar todas. O advogado maduro sabe que não controla todos os resultados.'), ...fala(16, 'O iniciante acredita que precisa ganhar todas. O advogado maduro sabe.')];
  casos.push(['refeitura 15 s depois', p, 24, [], c => c.some(k => k.tipo === 'refeitura' && k.de < 1 && Math.abs(k.ate - (16 - 0.12)) < 0.05)]);
}
// 3) bordão repetido NÃO é refeitura: "Vamos trabalhar." e 16 s depois "Vamos trabalhar, meu povo,"
{
  const p = [...fala(1, 'Vamos trabalhar. Deixa eu ver se tem alguém aqui.'), ...fala(17, 'Vamos trabalhar, meu povo, porque hoje tem coisa.')];
  casos.push(['bordão não é refeitura', p, 22, [], c => !c.some(k => k.tipo === 'refeitura')]);
}
// 4) fala sem texto: 1,8 s de voz entre duas palavras (whisper engoliu)
{
  const p = [...fala(1, 'E talvez uma das maiores diferenças'), ...fala(5.0, 'entre o advogado iniciante e o maduro.')];
  casos.push(['fala fora da transcrição', p, 9, [[3.3, 4.4]], c => c.some(k => k.tipo === 'fala-nao-transcrita' && k.de > 2.9 && k.ate < 5.0)]);
}
// 5) pausa depois de frase fechada e pausa no meio da frase
{
  const p = [...fala(1, 'Terminou o processo.'), ...fala(4.5, 'Analisa com sinceridade'), ...fala(7.4, 'o que aconteceu.')];
  casos.push(['pausa e pausa-frase', p, 10, [], c => c.some(k => k.tipo === 'pausa' && k.de > 1.6 && k.ate < 4.5) && c.some(k => k.tipo === 'pausa-frase' && k.ate < 7.4)]);
}
// 6) entrada no onset da palavra: respiro (energia FRACA, 0,4 do nível da voz) 0,4 s antes da palavra com um vão de 60 ms
{
  const p = [...fala(1, 'Primeira frase aqui.'), ...fala(5, 'Segunda frase.')];
  casos.push(['entrada depois do respiro', p, 8, [[4.45, 4.9, 0.4]], c => { const k = c.find(x => x.tipo === 'pausa'); return k && k.ate > 4.86 && k.ate <= 4.9; }]);
}
// 7) relógio atrasado: a palavra seguinte começa 0,9 s antes do que o whisper marcou (caso "Cristiano") — não é ilha, a entrada recua
{
  const p = [...fala(1, 'que é o nosso coordenador.'), { texto: 'Cristiano,', de: 5.2, ate: 5.6 }, ...fala(5.8, 'aqui do Núcleo Empresarial.')];
  casos.push(['relógio atrasado não vira ilha', p, 9, [[4.3, 5.0]], c => !c.some(k => k.tipo === 'fala-nao-transcrita') && c.some(k => k.tipo === 'pausa' && k.ate <= 4.2 && k.ate > 4.1)]);
}
// 8) pausa de 4 s ANTES de uma refeitura: sai junto (era o silêncio que sobrava no vídeo de 4:22)
{
  const p = [...fala(1, 'que aprender com isso.'), ...fala(7, 'Mas se você estudou, se preparou, algo que ninguém conseguiu é...'), ...fala(14, 'Mas se você estudou, se preparou, construiu a estratégia.')];
  casos.push(['pausa antes da refeitura', p, 20, [], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && r.de < 2.4 && Math.abs(r.ate - 13.88) < 0.05; }]);
}
// 9) respiro colado na palavra seguinte (caso "ensina, [respiro] que é aprender" do vídeo de 4:22): o whisper
//    marca `que` começando no fim de "ensina," e durando 1,5 s; o som só volta em 3,95. A pausa tem que sair.
{
  const antes = fala(1, 'que a faculdade não ensina,');                         // acaba em 2,45
  const reais = [...antes, { texto: 'que', de: 3.95, ate: 4.2 }, { texto: 'é', de: 4.2, ate: 4.25 }, ...fala(4.3, 'aprender a perder processo.')];
  const p = [...antes, { texto: 'que', de: 2.45, ate: 4.2 }, { texto: 'é', de: 4.2, ate: 4.25 }, ...fala(4.3, 'aprender a perder processo.')];
  casos.push(['respiro colado na palavra seguinte', p, 8, [], c => c.some(k => k.tipo === 'pausa-frase' && Math.abs(k.de - 2.65) < 0.05 && Math.abs(k.ate - 3.83) < 0.05) && !c.some(k => k.tipo === 'fala-nao-transcrita'), reais]);
}
// 10) respiro colado no FIM da palavra anterior: `ensina,` dura até 3.9 no whisper, mas o som acaba em 2,45
{
  const antes = fala(1, 'que a faculdade não ensina,');
  const reais = [...antes, ...fala(3.95, 'que é aprender a perder processo.')];
  const p = [...antes.slice(0, 4), { ...antes[4], ate: 3.9 }, ...fala(3.95, 'que é aprender a perder processo.')];
  casos.push(['respiro colado no fim da anterior', p, 8, [], c => c.some(k => k.tipo === 'pausa-frase' && Math.abs(k.de - 2.65) < 0.05 && Math.abs(k.ate - 3.83) < 0.05), reais]);
}
// 11) ar morto curto (0,9 s < pausa mínima) ANTES da refeitura sai junto com ela (vídeo de 4:22 aos 2:24)
{
  const p = [...fala(1, 'e ainda assim vai perder.'), ...fala(3.35, 'E talvez uma das maiores diferenças entre o advogado e aquele...'), ...fala(9, 'E talvez uma das maiores diferenças entre o advogado iniciante.')];
  casos.push(['ar morto antes da refeitura', p, 14, [], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && Math.abs(r.de - 2.65) < 0.05 && Math.abs(r.ate - 8.88) < 0.05; }]);
}
// 12) recomeço dentro da frase, sem ponto nem pausa longa entre as tentativas (vídeo de 4:22 aos 2:53)
{
  const p = [...fala(1, 'Ele entra.'), ...fala(3, 'O iniciante acredita que precisa ganhar'), ...fala(5.3, 'O iniciante acredita que precisa ganhar todas.')];
  casos.push(['recomeço dentro da frase', p, 9, [], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && Math.abs(r.de - 1.75) < 0.05 && Math.abs(r.ate - 5.18) < 0.05; }]);   // 1,55 (fim de "entra.") + 0,20 de respiro
}
// 13) começo falso (AD119 aos 0:11): "sala." | pausa | "E esse," | som sem palavra 0,7 s | pausa | "pouco mais de dez anos após,"
//     → sai desde a saída de "sala." até a entrada de "pouco" (fragmento + som), como refeitura
{
  const p = [...fala(6.0, 'Eu ficava lá na última sala.'), { texto: 'E', de: 11.08, ate: 11.22 }, { texto: 'esse,', de: 11.22, ate: 11.68 }, { texto: 'pouco', de: 13.70, ate: 13.82, reancorada: true }, ...fala(13.85, 'mais de dez anos após,')];
  casos.push(['começo falso sai inteiro', p, 17, [[12.49, 13.21]], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && Math.abs(r.de - 7.95) < 0.05 && Math.abs(r.ate - 13.58) < 0.05 && !c.some(k => k.tipo === 'pausa' && k.de > 7 && k.de < 12); }]);
}
// 14) NÃO é começo falso: fragmento longo (5 palavras) seguido de som sem palavra — fica como pausa normal
{
  const p = [...fala(6.0, 'Eu ficava lá na última sala.'), ...fala(11.0, 'E esse escritório aqui foi'), { texto: 'pouco', de: 15.70, ate: 15.82 }, ...fala(15.85, 'mais de dez anos após,')];
  casos.push(['fragmento longo não é começo falso', p, 19, [[14.2, 14.9]], c => !c.some(k => k.tipo === 'refeitura')]);
}
// 15) frase truncada curta é abandonada: "Eu vou te ensinar..." sai até a frase seguinte
{
  const p = [...fala(1, 'uma nova possibilidade para sua advocacia.'), ...fala(4, 'Eu vou te ensinar...'), ...fala(6.5, 'Para você garantir a sua vaga.')];
  casos.push(['frase truncada abandonada', p, 10, [], c => { const r = c.find(k => k.tipo === 'refeitura' && /abandonou/.test(k.motivo)); return r && Math.abs(r.de - 2.95) < 0.05 && Math.abs(r.ate - 6.38) < 0.05; }]);
}
// 16) a mesma frase curta inteira três vezes seguidas: só a última fica; e "Você vai perder processo. Você vai perder processo se…" (retórica, B mais longa) fica
{
  const p = [...fala(1, 'Para sua advocacia.'), ...fala(3, 'Para sua advocacia.'), ...fala(5, 'Para sua advocacia.'), ...fala(7, 'Você vai perder processo.'), ...fala(9, 'Você vai perder processo se tinha certeza.')];
  casos.push(['frase curta repetida igual', p, 13, [], c => { const r = c.filter(k => k.tipo === 'refeitura'); return r.length === 1 && r[0].de <= 0.88 && Math.abs(r[0].ate - 4.88) < 0.05; }]);   // o começo funde com a cabeça
}
// 17) abertura de A reaparece dentro de B: "Eu trilhei um longo caminho, acertei." → "De lá até aqui eu trilhei um longo caminho de acertos."
{
  const p = [...fala(1, 'Eu trilhei um longo caminho, acertei, errei.'), ...fala(5, 'De lá até aqui eu trilhei um longo caminho de acertos e erros.')];
  casos.push(['abertura dentro da seguinte', p, 11, [], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && r.de < 1 && Math.abs(r.ate - 4.88) < 0.05; }]);
}
// 18) cadeia de tentativas (3+ refeituras): fragmento ("de lá") e frase sem ponto entre elas saem; o pickup
//     ("Para sua advocacia." = fim da frase anterior) fica; a frase longa cujo começo é repetido depois ("de lá") sai
{
  const p = [...fala(0.5, 'descobriu uma nova possibilidade para sua advocacia.'), ...fala(3.5, 'Para sua advocacia.'), ...fala(5.5, 'Para sua advocacia.'),
    ...fala(7.5, 'De lá até aqui eu trilhei um longo caminho de acertos e erros.'), ...fala(12, 'de lá'),
    ...fala(14, 'durante todo esse caminho'), ...fala(16, 'durante todo esse caminho'), ...fala(18, 'Na sua advocacia.'), ...fala(20, 'Na sua advocacia.'), ...fala(22, 'Para você garantir a sua vaga.')];
  const coberto = (c, de, ate) => c.some(k => k.ligado && k.de <= de + 0.15 && k.ate >= ate - 0.15);
  casos.push(['cadeia: fragmento sai, pickup e frase longa ficam', p, 26, [], c =>
    coberto(c, 12, 12.55) && !coberto(c, 5.5, 6.35) && coberto(c, 7.5, 11.05) && coberto(c, 3.5, 4.35) && coberto(c, 20, 20.85) && !coberto(c, 22, 23.75)]);   // "de lá" depois repete o começo: a longa sai; o último "Na sua advocacia." (fragmento pós-cadeia) sai; o CTA fica
}
// 19) começo falso GRUDADO: "…de inventários" + 1,1 s de voz sem texto colada + pausa + "que" reancorada → sai da fronteira de "inventários" até "que"
{
  const p = [...fala(1, 'e na advocacia de inventários'), { texto: 'que', de: 4.6, ate: 4.75, reancorada: true, movida: true }, { texto: 'é', de: 4.75, ate: 4.85, reancorada: true, movida: true }, ...fala(4.9, 'a minha área')];
  //   "inventários" 2.2-2.45; voz até 3.55 (sem palavras); silêncio 3.55-4.6
  casos.push(['começo falso grudado na frase', p, 8, [[2.45, 3.55]], c => { const r = c.find(k => k.tipo === 'refeitura'); return r && Math.abs(r.de - 2.49) < 0.05 && Math.abs(r.ate - 4.48) < 0.05; }]);
}
// 20) pickup: "…uma nova possibilidade para sua advocacia." + "Para sua advocacia." ×3 → o último pickup entra NO LUGAR do fim original
{
  const p = [...fala(1, 'descobriu uma nova possibilidade para sua advocacia.'), ...fala(4, 'Para sua advocacia.'), ...fala(6, 'Para sua advocacia.'), ...fala(8, 'Para sua advocacia.'), ...fala(10, 'Para você garantir a sua vaga.')];
  //   "possibilidade" 1.9-2.15 → corte de 2.19 até a entrada do último "Para" (8 − 0.12 = 7.88)
  const coberto = (c, de, ate) => c.some(k => k.ligado && k.de <= de + 0.15 && k.ate >= ate - 0.15);
  casos.push(['pickup no lugar do fim da frase', p, 13, [], c => coberto(c, 2.2, 7.85) && !coberto(c, 1.9, 2.15) && !coberto(c, 8, 8.85) && p.find(w => w.de === 8).texto === 'para']);   // o motivo se perde na fusão; o último pickup herda a caixa da cauda original
}
let falhas = 0;
for (const [nome, p, dur, extra, ok, reais] of casos) {
  const clipe = { duracao: dur, palavras: p, energia: energia(reais || p, dur, extra), silencios: [] };
  const c = planejarCortes([clipe], preset);
  const passou = ok(c);
  if (!passou) falhas++;
  console.log((passou ? 'OK  ' : 'FALHOU ') + nome, '→', c.map(k => `${k.tipo} ${k.de.toFixed(2)}-${k.ate.toFixed(2)}`).join(' | '));
}
// legenda: no caso 9, a cue que começa em "que é" só pode aparecer quando ele fala (≥ 3,9), mesmo sem corte nenhum
{
  const [nome, p, dur, , , reais] = casos[8];
  const clipe = { duracao: dur, palavras: p, energia: energia(reais, dur), silencios: [] };
  const segs = montarSegmentos([clipe], []);
  const cues = legendar([clipe], segs, { legenda: { larguraEm: 14 } });
  const q = cues.find(c => c.texto.startsWith('que é'));
  const enc = encostarPalavras(p, clipe.energia);
  const passou = q && q.de >= 3.85 && q.de <= 4.0;
  if (!passou) falhas++;
  console.log((passou ? 'OK  ' : 'FALHOU ') + 'legenda espera o respiro', '→', cues.map(c => `${c.de.toFixed(2)}-${c.ate.toFixed(2)} «${c.texto}»`).join(' | '), '| que:', enc.find(w => w.texto === 'que' && w.de > 2).de.toFixed(2));
}
process.exit(falhas ? 1 : 0);
