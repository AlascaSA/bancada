// recuperarEngolidas com uma Groq de mentira: a palavra esticada "todas." (175,40-178,30) esconde a
// tentativa abortada "O iniciante acredita que precisa ganhar" que veio ANTES do "todas." de verdade.
import { recuperarEngolidas } from '../src/transcribe.js';
import { planejarCortes } from '../src/cuts.js';
import { Energia } from '../src/energy.js';
const w = (texto, de, ate) => ({ texto, de, ate });
const palavras = [
  w('entra.', 170.46, 170.80),
  w('O', 173.28, 173.30), w('iniciante', 173.30, 173.74), w('acredita', 173.74, 174.14), w('que', 174.14, 174.28), w('precisa', 174.28, 174.92), w('ganhar', 174.92, 175.40), w('todas.', 175.40, 178.30),
  w('Já', 178.56, 178.72), w('o', 178.72, 178.84), w('advogado', 178.84, 179.12), w('maduro', 179.12, 179.40), w('sabe', 179.80, 180.12),
];
// o que a janela curta devolve (medido de verdade na Groq, janela 172 s + 12 s), em tempo relativo ao começo da janela
const janela = [['o', 173.24, 173.28], ['iniciante', 173.28, 173.68], ['acredita', 173.68, 174.10], ['que', 173.62, 174.24], ['precisa', 174.24, 174.86], ['ganhar', 174.86, 175.34],
  ['o', 175.86, 175.98], ['iniciante', 175.98, 176.36], ['acredita', 176.36, 176.76], ['que', 176.76, 176.88], ['precisa', 176.88, 177.18], ['ganhar', 177.18, 177.42], ['todas', 177.42, 177.96],
  ['já', 178.56, 178.70], ['o', 178.70, 178.82], ['advogado', 178.82, 179.12], ['Maduro', 179.12, 179.40], ['sabe', 179.82, 180.12]];
let pedidos = [];
const ouvir = async blob => { pedidos.push(blob.size); const de = 175.40 - 0 - 2.0 /* trecho começa em ganhar.ate=175.40, MARGEM 2 */; return { palavras: janela.filter(([, a]) => a >= de - 0.01 && a <= 180.5).map(([t, a, b]) => ({ texto: t, de: a - de, ate: b - de })) }; };
const taxa = 16000, dados = new Float32Array(Math.round(185 * taxa));
const n = await recuperarEngolidas(dados, taxa, palavras, { ouvir, energia: { fracaoFala: () => 0 } });   // a pausa de 2,5 s antes é silêncio: não se reouve
const texto = palavras.map(p => `${p.texto}@${p.de.toFixed(2)}`).join(' ');
const segunda = palavras.findIndex((p, i) => i > 1 && p.texto.toLowerCase() === 'o' && p.de > 175.5);
const todas = palavras.find(p => p.texto.toLowerCase().startsWith('todas'));
const ok1 = n === 6 && segunda > 0 && Math.abs(palavras[segunda].de - 175.86) < 0.05 && todas && Math.abs(todas.de - 177.42) < 0.05 && pedidos.length === 1;
console.log((ok1 ? 'OK  ' : 'FALHOU ') + 'reouvir troca a esticada pelas duas tentativas', '→', n, 'palavras a mais |', texto);
// com as palavras recuperadas, o planejador tem que tirar a tentativa abortada (173,16 → 175,74)
const env = new Float32Array(Math.round(185 / 0.01)).fill(0.01);
for (const p of palavras) for (let i = Math.floor(p.de / 0.01); i < Math.ceil(p.ate / 0.01); i++) env[i] = 1;
const cortes = planejarCortes([{ duracao: 185, palavras, energia: new Energia(env, 0.3), silencios: [] }], { corte: { pausaMinima: 1.0, respiroSaida: 0.2, respiroEntrada: 0.12, cabecaRabo: true, soDepoisDeFrase: true } });
const r = cortes.find(k => k.tipo === 'refeitura' && k.ate > 175 && k.ate < 176);
const ok2 = r && Math.abs(r.ate - 175.74) < 0.05 && r.de <= 171.0 + 0.05;
console.log((ok2 ? 'OK  ' : 'FALHOU ') + 'tentativa abortada sai', '→', cortes.map(k => `${k.tipo} ${k.de.toFixed(2)}-${k.ate.toFixed(2)}`).join(' | '));

// ---- segunda escuta com início limpo (AD119): "pouco" esticado 11,68-13,88 sobre um som sem palavra (12,49-13,21)
{
  const pal = [w('Eu', 6.0, 6.12), w('ficava', 6.12, 6.32), w('lá', 6.32, 6.54), w('na', 6.54, 6.76), w('última', 6.76, 7.12), w('sala.', 7.12, 7.80), w('E', 11.08, 11.22), w('esse,', 11.22, 11.68), w('pouco', 11.68, 13.88), w('mais', 13.88, 14.12), w('de', 14.12, 14.24), w('dez', 14.24, 14.36), w('anos', 14.36, 14.72), w('após,', 14.72, 15.42)];
  const env2 = new Float32Array(Math.round(20 / 0.01)).fill(0.01);
  const marca = (a, b, n = 1) => { for (let i = Math.floor(a / 0.01); i < Math.ceil(b / 0.01); i++) env2[i] = n; };
  marca(6.0, 7.68); marca(11.12, 11.54); marca(12.49, 13.21); marca(13.80, 15.53);
  const en = new Energia(env2, 0.3);
  const pedidos2 = [];
  const ouvir2 = async blob => {
    pedidos2.push(blob.size);
    const dur = blob.size / 2 / 16000;   // wav16: 2 bytes por amostra (+ cabeçalho, desprezível)
    // 1ª janela (com contexto, começa em 9,68): cola "pouco" por cima do som; 2ª (começa DEPOIS do som, em 13,45): "pouco" continua lá, em 13,70
    if (dur > 5.5) return { palavras: [['e', 11.06], ['esse', 11.14], ['pouco', 12.36], ['mais', 13.82]].map(([t, a]) => ({ texto: t, de: a - 9.68, ate: a - 9.68 + 0.2 })) };
    return { palavras: [['pouco', 13.70], ['mais', 13.82], ['de', 14.08]].map(([t, a]) => ({ texto: t, de: a - 13.45, ate: a - 13.45 + 0.12 })) };
  };
  const n2 = await recuperarEngolidas(new Float32Array(20 * 16000), 16000, pal, { ouvir: ouvir2, energia: en });
  const pouco = pal.find(x => x.texto === 'pouco');
  const ok3 = pedidos2.length === 2 && pouco.de >= 13.65 && pouco.de <= 13.82 && pouco.reancorada === true && n2 === 0;   // a escuta de gagueira pega antes e usa o tempo da janela (13,70)
  console.log((ok3 ? 'OK  ' : 'FALHOU ') + 'segunda escuta reancora a palavra depois do som', '→ pedidos', pedidos2.length, '| pouco', pouco.de.toFixed(2) + '-' + pouco.ate.toFixed(2));
  // ---- gagueira (AD119 aos 0:21): "Mas sá" (bloco A 21,51-21,93) | 0,5 s | "Mas sabe qual foi o maior…" (bloco B 22,43+);
  //      whisper: Mas 21,46-21,60 (em A), sabe 21,60-22,68 (atravessa). Janela em B: "Mas sabe qual foi…" → as duas vão para B.
  const pal4 = [w('em', 18.16, 18.36), w('Brasília.', 18.36, 18.86), w('Mas', 21.46, 21.60), w('sabe', 21.60, 22.68), w('qual', 22.68, 22.82), w('foi', 22.82, 23.02), w('o', 23.02, 23.08), w('maior', 23.08, 23.20), w('investimento', 23.20, 23.78)];
  const env4 = new Float32Array(Math.round(26 / 0.01)).fill(0.01);
  const m4 = (a, b, n = 1) => { for (let i = Math.floor(a / 0.01); i < Math.ceil(b / 0.01); i++) env4[i] = n; };
  m4(17.9, 18.86); m4(21.51, 21.93); m4(22.43, 25.0);
  const pedidos4 = [];
  const ouvir4 = async blob => { pedidos4.push((blob.size - 44) / 2 / 16000); const de = 22.43 - 0.35; return { palavras: [['Mas', 22.45, 22.58], ['sabe', 22.60, 22.86], ['qual', 22.86, 23.0], ['foi', 23.0, 23.2]].map(([t, a, b]) => ({ texto: t, de: a - de, ate: b - de })) }; };
  await recuperarEngolidas(new Float32Array(26 * 16000), 16000, pal4, { ouvir: ouvir4, energia: new Energia(env4, 0.3) });
  const mas = pal4.find(x => x.texto === 'Mas'), sabe = pal4.find(x => x.texto === 'sabe');
  const ok4 = pedidos4.length === 1 && Math.abs(mas.de - 22.45) < 0.03 && Math.abs(sabe.de - 22.60) < 0.03 && mas.reancorada && sabe.reancorada;
  console.log((ok4 ? 'OK  ' : 'FALHOU ') + 'gagueira: "Mas sabe" vai para o bloco B', '→ pedidos', pedidos4.length, '| Mas', mas.de.toFixed(2), 'sabe', sabe.de.toFixed(2) + '-' + sabe.ate.toFixed(2));
  // ---- escuta limpa carregando as palavras anteriores (AD119 1:02): "inventários que é [a esticada 62,89-64,23] minha área";
  //      janela a partir de 63,77 ouve "que é a minha área" → "que" e "é" vão para depois da pausa, "a" reancora
  const pal5 = [w('de', 61.3, 61.65), w('inventários', 61.65, 62.41), w('que', 62.41, 62.73), w('é', 62.73, 62.89), w('a', 62.89, 64.23), w('minha', 64.23, 66.09), w('área', 66.09, 66.41), w('isso', 66.41, 66.89)];
  const env5 = new Float32Array(Math.round(70 / 0.01)).fill(0.01);
  const m5 = (a, b, n = 1) => { for (let i = Math.floor(a / 0.01); i < Math.ceil(b / 0.01); i++) env5[i] = n; };
  m5(60.43, 63.51); m5(64.12, 66.48); m5(66.77, 67.92);
  const ouvir5 = async () => { const de = 64.12 - 0.35; return { palavras: [['que', 64.15, 64.30], ['é', 64.30, 64.42], ['a', 64.42, 64.55], ['minha', 64.55, 65.0], ['área', 65.0, 65.5]].map(([t, a, b]) => ({ texto: t, de: a - de, ate: b - de })) }; };
  await recuperarEngolidas(new Float32Array(70 * 16000), 16000, pal5, { ouvir: ouvir5, energia: new Energia(env5, 0.3) });
  const que = pal5.find(x => x.texto === 'que'), a5 = pal5.find(x => x.texto === 'a');
  const ok5 = Math.abs(que.de - 64.15) < 0.03 && que.reancorada && a5.de >= 64.12 && a5.reancorada && pal5.find(x => x.texto === 'inventários').de === 61.65;
  console.log((ok5 ? 'OK  ' : 'FALHOU ') + 'escuta limpa carrega "que é" para depois da pausa', '→ que', que.de.toFixed(2), 'a', a5.de.toFixed(2));
  process.exit(ok1 && ok2 && ok3 && ok4 && ok5 ? 0 : 1);
}
