# Bancada

Edita os vídeos simples dos professores no Chrome, sem Premiere: junta os brutos na ordem da
numeração, faz o corte seco (cabeça, rabo e pausas), legenda no estilo do professor e exporta o
MP4 1080x1920. Nada sai da máquina do editor além do áudio mono 16 kHz que vai para a Groq.

## No ar

**https://bancada-6x9.pages.dev** — Cloudflare Pages (conta gu.costa.mendes, projeto `bancada`),
grátis. A chave da Groq é o segredo `GROQ_KEY` do projeto; `functions/api/groq/[[path]].js` faz o
mesmo papel do `serve.py`. Publicar de novo: `./deploy.sh` (monta `dist/` e sobe). Trocar a
chave: `npx wrangler pages secret put GROQ_KEY --project-name bancada`.

## Rodar local

```bash
python3 ~/Documents/claude/bancada/serve.py
```

Abre `http://localhost:8799`. A chave da Groq fica em
`~/Library/Application Support/Bancada/config.json` (`{"groqKey": "..."}`) — o navegador nunca vê
a chave; o `serve.py` repassa em `/api/groq/*`. No ar, um Worker do Cloudflare faz o mesmo papel.

Modo de teste: `http://localhost:8799/?teste=1` carrega os brutos de `teste/` sozinho e, ao
exportar, grava `teste/saida.mp4` em vez de abrir o diálogo de salvar.

## O que acontece

| Etapa | Onde | Como |
|---|---|---|
| Ler brutos | navegador | Mediabunny (WebCodecs): metadados, miniaturas 1/s, áudio mono 16 kHz |
| Ouvir | navegador | envelope RMS 10 ms, limiar Otsu no log, corridas de silêncio |
| Transcrever | Groq | `whisper-large-v3-turbo`, tempo por palavra (`src/transcribe.js`) |
| Cortar | navegador | cabeça/rabo + pausa ≥ `pausaMinima` só depois de frase fechada; respiro 0,20 s na saída, 0,12 s na entrada (`src/cuts.js`) |
| Legendar | navegador | palavras → cues por programação dinâmica, custo portado do `legenda-nativa/remontar.py` (`src/captions.js`) |
| Revisar | navegador | fita com miniaturas que acompanha a agulha (clique vai ao ponto, arrastar marca corte), lista de cortes liga/desliga, transição por emenda, legendas editáveis, prévia sem render |
| Exportar | navegador | canvas 1080x1920 + legenda desenhada, H.264 + AAC via WebCodecs (`src/render.js`) |

Antes de cortar e legendar, `encostarPalavras` (energy.js) encosta cada palavra do whisper no som:
o whisper cola o silêncio na palavra vizinha ("ensina, [respiro] que" vira um `que` de 0,8 s), e
uma palavra não pode começar nem terminar em silêncio. Sem isso a legenda entra durante o respiro e
pausas de 1 s somem dentro da palavra.

Refeitura começa na saída da última palavra boa (o ar morto antes da tentativa errada vai junto).
Recomeço sem ponto no meio ("O iniciante acredita que precisa ganhar | O iniciante acredita que
precisa ganhar todas.") é pego por `repeticoesInternas` (bloco ≥ 5 palavras repetido em seguida);
com ponto entre as duas é paralelismo e fica.

Onde ele "caçou" a frase (cadeia de 3+ refeituras), a etapa **Revisando** manda o trecho para o
gpt-oss-120b da Groq com a regra do editor (cada ideia entra uma vez, na última tomada) e transforma
a resposta em cortes "IA: tentativa abandonada", revisáveis. A estrutura manda: a última tomada do
grupo é a final, tomada eleita pelas regras é intocável, pickup fica. O que sobrar curto vira corte
desligado "sobrou entre tentativas". Sem cadeia de refeituras, a IA não é chamada.

## Padrão por professor

`presets/<professor>.json`: saída, regras de corte, estilo de legenda (fonte, tamanho como fração
da largura, cor, altura, espaçamento, sombra, largura máxima em `em`), música. Só o Jaylton está
medido (frame real de `Honorarios.mp4`: Inter Bold ~49 px em 1080, centro a 78% da altura, branca,
sombra suave, ~29 caracteres por linha). **Pablo** é um padrão de teste (etiqueta "teste" no topo:
Inter Bold 52 px a 80%, mesmas regras de corte). **André** usa **Helvetica Bold** (fonte do sistema;
`fonteReserva` cai em Arial onde não houver Helvetica) a 78%, tamanho provisório. Cada preset traz
`tema` (a cor do time na Central de Gravação: azul, roxo, verde — a interface inteira muda com o
professor) e `foto` (o mesmo recorte 1024x1024 da Central, em `presets/<p>-foto.jpg`). O cartão de
padrão mostra a foto e um espécime da legenda na fonte real. A prévia lê o estilo do preset por
variáveis CSS (`--leg-*`), então prévia e export mostram a mesma fonte.

## Projetos salvos

A mesa salva sozinha (`/api/projetos`, KV `PROJETOS` na Cloudflare; em desenvolvimento o `serve.py`
grava em `~/Library/Application Support/Bancada/projetos/`). O projeto leva o que a mesa decidiu
(cortes com liga/desliga, legendas editadas, transições e tempos, posição, estilo), a transcrição e o
envelope de energia (1 byte por 10 ms, em dB) — nunca o vídeo. Uns 30 KB por vídeo de 2 min. Mais a
capa (1º quadro, JPEG) e um loop de 4 s do começo editado, com legendas, renderizado em 270x480 pelo
mesmo caminho do export (~200 KB), que toca quando o mouse passa pelo card.

Reabrir: clicar no card, soltar os mesmos brutos (conferidos por nome e tamanho; transições são
opcionais). A mesa volta em segundos, sem Groq. Economia de escrita (KV grátis = 1.000 escritas/dia
na conta): grava só quando a mesa ficou 3 s parada; capa e loop só quando o começo mudou e no máximo
a cada minuto. "Quem edita?" no topo guarda o nome no navegador para o "editado por".

## Estilo da legenda (painel na mesa)

Fonte (Inter, Montserrat, Poppins, Roboto empacotadas em `fonts/`, licença OFL; Helvetica do sistema
com reserva Arial), peso, tamanho (fração da largura, mostrado em px a 1080), espaçamento entre
letras, e o **destaque**: última palavra em negrito na linha de baixo (template "Million" do app
Captions, padrão do Pablo), com peso e entrelinha próprios. Tudo vale na prévia, no espécime do cartão
e no export (`desenharLegenda` desenha as duas linhas). Os ajustes ficam guardados por professor no
navegador (`localStorage`, chave `bancada.estilo.<id>`); "Voltar ao padrão" apaga. A palavra
destacada é a última da cue (`separarDestaque`); se ela é fraca ("de", "que"), a anterior desce junto.

## Legenda movível

Na prévia a legenda se arrasta. **Todas juntas** move o bloco (deslocamento único, `E.legendaBloco`,
em frações da saída); **Só esta** dá à legenda atual um deslocamento próprio em relação ao bloco
(`cue.desloc`, guardado por chave no bruto — sobrevive a ligar/desligar cortes). Ímãs no centro
horizontal e na altura de referência; guia com a porcentagem durante o arrasto; "Voltar ao padrão"
zera o que estiver no modo ativo; na lista, a legenda com posição própria ganha um pino que a
devolve ao bloco. Export e "Ver como fica" usam a mesma posição (`posicaoLegenda` em captions.js).

## Tempos (as três respostas da Giovana)

A medição continua (fica em `tempos` no projeto salvo e no relatório interno), mas o bloco «Tempos» e o relógio
do cabeçalho saíram da tela a pedido dele em 17/09/2026.

## Robô e revisão (o «funcionário» que a Giovana pediu, 17/09/2026)

A equipe só sobe o bruto na pasta do Drive que já usa; o resto anda sozinho até a revisão humana:

1. **Pasta de brutos do professor** (Shared Drive Lançamentos, dentro da raiz de cada um:
   `08. Vídeos brutos > Bancada`). Quem grava solta o bruto ali. Jaylton `1vew1VlJ1ExEd9Te0lnvSIoWzWfO4UPQ1`,
   Pablo `1s7q4fue8F8vy9ZFErlEkM1s_JJN4jovg`, André `1FP6IX_vziCr4aQOWr5yZwmW8L3Gi3SZR`. Cada pasta é da aba
   do professor correspondente na Bancada (o robô edita com o padrão dele).
2. **Robô na nuvem, sem depender de Mac nenhum.** Dois pedaços: o **vigia** (`vigia/`, Cloudflare Worker com
   cron a cada 5 min, grátis) olha a pasta de brutos e a lista de projetos; se há bruto sem projeto ou mesa
   pedindo render novo, dispara o **robô** no GitHub Actions (`.github/workflows/robo.yml`, repo privado
   `AlascaSA/bancada`, minutos grátis como a Central usa). O robô (`robo/robo.mjs`) baixa o bruto, abre a
   Bancada publicada no Google Chrome do runner (sem tela, mudo, nome «Robô», codecs por software), espera a
   mesa, exporta, converte o áudio para AAC com o ffmpeg (o Chrome no Linux só codifica Opus) e sobe o MP4 na
   subpasta **`Em revisão`** da própria pasta de brutos. Nome do editado pela cadeia do Playbook: **o do bruto
   sem o `BR-`** (`BR-inventários rentáveis.MOV` → `inventários rentáveis.mp4`). Projeto salvo com `fluxo` na
   etapa **Revisão do editor**; se o render falhar, o cartão mostra «o robô falhou» com o motivo, e apagar o
   cartão faz ele tentar de novo. Uma volta por vez (`concurrency: robo`). O mesmo robô roda em qualquer máquina
   (`node robo/robo.mjs --uma-vez`, WebKit no Mac); `robo/instalar.sh` continua existindo para quem quiser um
   Mac sempre ligado, mas não é o caminho principal. Subir um bruto sem abrir o Drive:
   `node robo/robo.mjs --subir <arquivo> <professor>`.
3. **Revisão do editor** — o cartão mostra a etapa; clicar abre o **visualizador** (o MP4 vem do Drive pelo
   servidor, sem precisar dos brutos) com «Marcar como revisado», «Copiar link para a revisão» e «Abrir a mesa
   para ajustar» (o bruto também vem do Drive, pelo botão «Baixar o bruto do Drive»). Mudou a mesa depois do
   render? O projeto pede render novo e o robô substitui o MP4 no mesmo link quando a mesa fica 90 s parada;
   enquanto isso a aprovação fica travada.
4. **Revisão final** — é de OUTRA pessoa: quem marcou «revisado» vê só o link (`?professor=<p>&revisar=<id>`
   abre o visualizador direto) e «Voltar atrás». Quem aprova clica «Aprovar e enviar ao Drive»: a função
   `/api/drive/entregar` **move** o arquivo de `Em revisão` para a **pasta de entrega do professor**
   (`04. Conteúdo > Redes sociais > Bancada` de cada um: Jaylton `1oSEMar9FdA9U9ElLjE1FDsDQNSTGQryg`, Pablo
   `1vqgG8tueTgRae_-SHsEqafPxbOZcVNHD`, André `1JdNkgFjIWwzj9dqsUB4t5ZYuCqXND9w0`), sem reenviar; arquivo de mesmo
   nome que já estivesse lá vai para a lixeira (como o Renomeador faz ao substituir). Nada chega na entrega sem
   passar pelas duas revisões. «Devolver ao editor» volta uma etapa.
5. **«Não faz isso / faz sempre isso»** — três canais. (0) **Reportar erro** num ponto do vídeo, no visualizador
   ou na mesa: pega o tempo em que o vídeo está, pede o tipo (cortou fala boa, deixou erro passar, legenda errada,
   legenda fora de tempo, outro) e uma linha de texto; guarda no projeto com o tempo no bruto e o trecho transcrito
   em volta (`reportes`). A lista de reportes fica no visualizador e na mesa (clique = vai para o ponto). O
   **Diário** (`diario.html?professor=<p>`, botão na lista de projetos) junta reportes e correções de corte por
   professor, com «Abrir na mesa» que cai no ponto (`?abrir=<id>&clipe=&t=`) e «Copiar em texto» para mandar a quem
   programa as regras. Os reportes de corte com trecho e os cortes desligados com o porquê viram **exemplos no
   prompt da revisão por IA** do professor (12 mais recentes), sem ninguém programar. (a) Ao desligar um corte da IA a mesa pergunta
   «Por quê?» (era ênfase, era pausa boa, cortou cedo, cortou tarde, outro); corte feito à mão vira «a IA não
   viu». Tudo fica no projeto e sai junto em `/api/feedback?professor=<p>` — o diário de onde a equipe técnica
   tira as regras novas do planejador (regra de corte é código: cada correção recorrente vira regra e teste,
   como as 21 de `tools/teste-cortes.mjs`). (b) **Regras do professor** (botão na lista de projetos): texto
   livre da equipe, guardado no servidor, que entra no prompt da revisão por IA de cada vídeo daquele professor.

O que o robô NÃO faz: número de AD, campanha, leva e linha na planilha continuam sendo do Renomeador, porque
são escolhas da pessoa (o app não adivinha).

Servidor: `functions/_drive.js` + `functions/api/drive/[[path]].js` (stream com Range, meta, entregar),
`functions/api/regras/[[path]].js`, `functions/api/feedback.js`; segredos do Pages `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` (mesmo app OAuth da Dublagem, conta gu.costa.mendes,
que é membro do Shared Drive; `sh robo/segredos.sh` grava os três). A pasta de entrega vai dentro do projeto
(`fluxo.entrega.pastaId`, escrita pelo robô a partir do `robo.json`). O `serve.py` emula tudo com os tokens de
`~/.claude/.google`. Pastas por professor: `robo/pastas.json` (commitado; `~/Library/Application Support/Bancada/robo.json`
manda se existir) e a var `PROFS` do `vigia/wrangler.toml` — os dois precisam bater. Segredos: no GitHub
(`sh robo/segredos-github.sh`: os três do Drive) e no Worker (`sh vigia/segredos.sh`: os três + `GH_TOKEN`, o do
`gh` da conta AlascaSA, que dispara o workflow); depois `cd vigia && npx wrangler deploy`. Testes:
`tools/teste-revisao-ui.mjs` (visualizador, etapas, link, mesa do Drive, «por quê», regras), `tools/teste-robo.mjs`
(rerender, entrega, limpeza) e o workflow `teste-linux.yml` (prova o Chrome do runner editando e exportando).

## Limites desta versão

- Só Chrome/Edge (WebCodecs, File System Access).
- Áudio vai em WAV para a Groq: clipe único acima de ~12 min estoura o limite de 25 MB do plano
  gratuito (precisa fatiar ou codificar em Opus).
- Sem música, sem lettering, sem cor. Sem correção de texto por IA (só com prova do áudio).
- A ordem dos brutos vem do primeiro número no nome do arquivo.

## Prévia (como a emenda fica fluida)

Duas lentes `<video>` sobre os brutos originais. A lente que vai entrar **parte muda 0,3 s antes
da emenda** (o decodificador acorda frio e segura o primeiro quadro); na emenda a que sai segura o
último quadro até a que entra chegar no ponto, e trocam de opacidade — nunca `display:none`, que
faz o Safari pintar preto. O laço roda em `setInterval` (rAF para em aba escondida e a troca
perderia a emenda). Testado com Playwright/WebKit e no Chromium: nenhuma segurada acima de
100 ms nas emendas; só o primeiro play tem ~0,5 s de aquecimento, atenuado tocando mudo na carga.
Teste: `node tools/teste-emendas.mjs` (precisa de `npm i playwright` + `npx playwright install webkit`; amostra a cada 50 ms e lista as seguradas).

## Transições

Entram como **overlay**, nunca como clipe: film burn, light leak e afins (fundo preto) são
compostos em blend "screen" por cima da emenda, centrados nela (metade antes, metade depois),
em "cover" no quadro 9:16. Se o arquivo tiver som, o som entra misturado (ganho 0,8). Botão
"Transições" carrega os arquivos (a pasta do time: `HD 01/Arquivos de edição/Transições`);
cada pausa cortada e cada emenda entre brutos tem um seletor; "Em todas as emendas" põe a última
transição adicionada em todas as emendas entre brutos. Também dá para **arrastar**: o chip da
biblioteca (ou o arquivo direto do Finder) solto na fita cai na emenda mais perto, e a
transição aparece como uma faixa por cima da fita, do tamanho dela, centrada na emenda. A
escolha fica presa à emenda no BRUTO, então ligar/desligar outros cortes não a perde.

**Camada de transições:** a fita tem uma pista em cima. Cada transição é um bloco do tamanho
dela: arrastar move (o rótulo mostra quanto o centro está antes/depois da emenda, com ímã no
centro), as bordas aparam (esquerda = entra mais tarde no arquivo, direita = termina antes),
clique seleciona, Delete tira, duplo clique mostra como fica.

**Ver como fica:** o botão "Ver" da emenda (ou duplo clique no bloco) renderiza só 1,5 s antes
e 2 s depois da emenda pelo MESMO caminho do export e toca em loop dentro da moldura da prévia —
leva ~1 s e mostra exatamente o que vai sair.

**Exportar → Salvar:** o render termina num painel "MP4 pronto" com **Salvar MP4** (clique do
editor: o Safari ignora download disparado sem gesto do usuário — era por isso que "não salvava
nada") e **Ver como saiu**, que toca o MP4 final na moldura.

Duas armadilhas pagas: `mix-blend-mode` em `<video>` não funciona no Safari (a transição
aparecia opaca, como se fosse um clipe) — a prévia compõe base + overlay num canvas; e no
export, desenhar o `VideoFrame` direto com `globalCompositeOperation: 'screen'` apagava a base
no WebKit — o quadro passa por um canvas intermediário.
