// Revisão por IA com a Groq de mentira (resposta em grupos): cascata do AD119 simplificada.
import { revisarTentativas, montarPergunta } from '../src/revisao.js';
import { planejarCortes, frases, cadeiasDeTentativas } from '../src/cuts.js';
import { Energia, encostarPalavras } from '../src/energy.js';
const preset = { corte: { pausaMinima: 1.0, respiroSaida: 0.2, respiroEntrada: 0.12, cabecaRabo: true, soDepoisDeFrase: true } };
function fala(t, texto) { return texto.split(' ').map((p, i) => ({ texto: p, de: t + i * 0.3, ate: t + i * 0.3 + 0.25 })); }
const p = [
  ...fala(1, 'descobriu uma nova possibilidade para sua advocacia.'),
  ...fala(4, 'Eu vou te ensinar...'), ...fala(6, 'Para sua advocacia.'), ...fala(8, 'Para sua advocacia.'), ...fala(10, 'Para sua advocacia.'),
  ...fala(12, 'Eu trilhei um longo caminho, acertei, errei.'), ...fala(15.5, 'De lá até aqui eu trilhei um longo caminho de acertos e erros.'),
  ...fala(20.5, 'Eu vou te mostrar os acertos e vou te ensinar como não cair nos erros e ter'),
  ...fala(26, 'durante todo esse caminho'), ...fala(28, 'durante todo esse caminho'), ...fala(30, 'Durante todo esse caminho, eu passei por...'),
  ...fala(33, 'Na sua advocacia.'), ...fala(35, 'Na sua advocacia.'), ...fala(37, 'Para você garantir a sua vaga nessas três aulas.'),
];
const dur = 46, env = new Float32Array(Math.round(dur / 0.01)).fill(0.01);
p.forEach(w => { for (let i = Math.floor(w.de / 0.01); i < Math.ceil(w.ate / 0.01); i++) env[i] = 1; });
const clipe = { duracao: dur, palavras: p, energia: new Energia(env, 0.3), silencios: [] };
const cortes = planejarCortes([clipe], preset);
console.log('regras →', cortes.filter(k => k.tipo === 'refeitura').map(k => `${k.de.toFixed(1)}-${k.ate.toFixed(1)} ${k.motivo}`).join(' | '));
const cadeias = cadeiasDeTentativas(cortes, 0);
let vista = null;
const perguntar = async pergunta => {
  vista = pergunta;
  const id = re => pergunta.linhas.find(l => re.test(l.texto))?.id;
  // a "IA" agrupa por ideia: "para sua advocacia" (final = a última), "trilhei/caminho" (abandonada), "mostrar acertos" (abandonada), "na sua advocacia" (final = a última)
  return { grupos: [
    { ideia: 'possibilidade', frases: [id(/^descobriu/)], final: id(/^descobriu/) },
    { ideia: 'para sua advocacia', frases: pergunta.linhas.filter(l => /^(Eu vou te ensinar|Para sua advocacia)/.test(l.texto)).map(l => l.id), final: pergunta.linhas.filter(l => /^Para sua advocacia/.test(l.texto)).map(l => l.id).pop() },
    { ideia: 'caminho', frases: pergunta.linhas.filter(l => /trilhei|todo esse caminho/i.test(l.texto)).map(l => l.id), final: null },
    { ideia: 'mostrar acertos', frases: [id(/^Eu vou te mostrar/)], final: null },
    { ideia: 'na sua advocacia / vaga', frases: pergunta.linhas.filter(l => /^(Na sua advocacia|Para você garantir)/.test(l.texto)).map(l => l.id), final: id(/^Para você garantir/) },
  ] };
};
const extras = await revisarTentativas([clipe], cortes, { perguntar });
const depois = planejarCortes([clipe], preset, extras);
console.log('pergunta:\n  ' + vista.usuario.split('\n').join('\n  '));
console.log('IA →', (extras[0] || []).map(x => x.motivo).join(' | '));
const fr = frases(encostarPalavras(p, clipe.energia));
const ref = depois.filter(k => k.tipo === 'refeitura' && k.ligado);
const vivas = fr.filter(f => !ref.some(k => k.de <= f.de + 0.15 && k.ate >= f.ate - 0.15)).map(f => p.slice(f.ini, f.fim + 1).map(w => w.texto).join(' '));
console.log('vivas →', vivas.join(' | '));
const ok = cadeias.some(c => c.length >= 3) && vivas.length === 3 && /^descobriu/.test(vivas[0]) && vivas[1] === 'para sua advocacia.' && /^Para você garantir/.test(vivas[2])
  && (extras[0] || []).some(x => /De lá até aqui/.test(x.motivo)) && (extras[0] || []).some(x => /Eu vou te mostrar/.test(x.motivo));
console.log((ok ? 'OK  ' : 'FALHOU ') + 'revisão por IA: última tomada de cada ideia fica, ideia abandonada sai inteira, pickup protegido');
// ---- 4:22 às 20:14: o modelo juntou "O iniciante acredita que precisa ganhar…" (tomada eleita; o corte forte acaba DENTRO
//      da frase, gagueira) com "Já o advogado maduro sabe…" (ideia diferente) e pôs a segunda como final → a primeira NÃO pode sair
{
  const p2 = [...fala(1, 'E talvez uma das maiores diferenças entre o advogado iniciante e o maduro.'),
    ...fala(6, 'O iniciante acredita que precisa ganhar todas.'), ...fala(9, 'O advogado maduro sabe que não controla os resultados.'),
    { texto: 'O', de: 13.0, ate: 13.1 }, { texto: 'iniciante', de: 13.1, ate: 13.5 }, { texto: 'acredita', de: 13.5, ate: 13.9 }, { texto: 'que', de: 13.9, ate: 14.0 }, { texto: 'precisa', de: 14.0, ate: 14.4 }, { texto: 'ganhar', de: 14.4, ate: 14.8 },
    { texto: 'o', de: 15.3, ate: 15.4 }, { texto: 'iniciante', de: 15.4, ate: 15.8 }, { texto: 'acredita', de: 15.8, ate: 16.2 }, { texto: 'que', de: 16.2, ate: 16.3 }, { texto: 'precisa', de: 16.3, ate: 16.7 }, { texto: 'ganhar', de: 16.7, ate: 17.0 }, { texto: 'todas,', de: 17.0, ate: 17.4 },
    ...fala(18.2, 'Já o advogado maduro sabe que não controla os resultados, mas faz questão da excelência.'), ...fala(24, 'Não permita que uma derrota abale você.')];
  const dur2 = 28, env2 = new Float32Array(Math.round(dur2 / 0.01)).fill(0.01);
  p2.forEach(w => { for (let i = Math.floor(w.de / 0.01); i < Math.ceil(w.ate / 0.01); i++) env2[i] = 1; });
  const clipe2 = { duracao: dur2, palavras: p2, energia: new Energia(env2, 0.3), silencios: [] };
  const cortes2 = planejarCortes([clipe2], preset);
  const perguntar2 = async q => { const id = re => q.linhas.find(l => re.test(l.texto))?.id; return { grupos: [
    { ideia: 'iniciante x maduro', frases: [id(/^E talvez/), id(/^O advogado maduro/), id(/^O iniciante acredita que precisa ganhar o/), id(/^Já o advogado/)].filter(Boolean), final: id(/^Já o advogado/) },
    { ideia: 'derrota', frases: [id(/^Não permita/)], final: id(/^Não permita/) } ] }; };
  const extras2 = await revisarTentativas([clipe2], cortes2, { perguntar: perguntar2 });
  const depois2 = planejarCortes([clipe2], preset, extras2);
  const fr2 = frases(encostarPalavras(p2, clipe2.energia));
  const vivas2 = fr2.filter(f => !depois2.some(k => k.ligado && k.de <= f.de + 0.15 && k.ate >= f.ate - 0.15)).map(f => p2.slice(f.ini, f.fim + 1).map(w => w.texto).join(' ').slice(0, 60));
  const ok2 = vivas2.some(v => /^E talvez/.test(v)) && vivas2.some(v => /^O iniciante acredita que precisa ganhar o/.test(v)) && vivas2.some(v => /^Já o advogado/.test(v)) && !(extras2[0] || []).length;
  console.log((ok2 ? 'OK  ' : 'FALHOU ') + 'tomada eleita dentro da frase e frase sem afinidade com o grupo ficam', '→ IA:', JSON.stringify(extras2[0] || []), '| vivas:', vivas2.join(' | '));
  process.exit(ok && ok2 ? 0 : 1);
}
