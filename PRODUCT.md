# Bancada

Plataforma web da ALASCA para editar os vídeos simples dos professores (Jaylton, Pablo, André)
sem Premiere: o editor solta os brutos numerados, escolhe o professor, revisa o que a máquina
propôs (cortes e legendas) e exporta o MP4 — tudo no Chrome, sem servidor e sem custo.

## Quem usa
Editores da equipe de audiovisual (Gustavo, Wendy, Katsu, Maycon). Cenário: mesa de edição,
Chrome aberto ao lado do ClickUp, tarefa "Vídeo tiktok — escritório — Jaylton" com 3 brutos.

## O trabalho
1. Juntar os brutos na ordem da numeração.
2. Corte seco: tirar respiro, pausa morta e cabeça/rabo de cada clipe.
3. Legenda simples no estilo do professor (Jaylton: Inter Bold branca, centrada, 78% da altura,
   uma linha de até ~29 caracteres, frases curtas).
4. Sem música (Jaylton, conteúdo). Música entra por padrão de professor quando existir.
5. Exportar 1080x1920 MP4 e mandar para aprovação (Thayná).

## O que a plataforma precisa provar (pedido da Giovana, 14/09/2026)
- Um vídeo desses sai 100% pela máquina.
- Quanto tempo a máquina levou, quanto tempo a pessoa gastou operando, quanto o editor gastou
  ajustando — medido automaticamente, toda vez.
- O "padrão do professor" existe como arquivo editável, não como conhecimento na cabeça de alguém.

## Restrições
- Só Chrome/Edge (WebCodecs + File System Access). Nada instalado.
- LLM e transcrição: só Groq (gratuito). Chave guardada fora do código.
- Sem LUT/cor automática. Sem animação/lettering nesta fase.
- Arquivos nunca saem da máquina do editor, exceto o áudio comprimido que vai à Groq.

## Suposições (não confirmadas com o time)
- Saída em 1080x1920 na taxa de quadros do bruto.
- Pausa ≥ 1,0 s dentro da fala vira corte por padrão; o editor liga/desliga cada um.
