#!/bin/sh
# Reautoriza o Drive e espalha o token novo por tudo que usa: Bancada (site), vigia, robô (GitHub) e Dublagem.
# Precisa rodar quando o chip «Drive desconectado» aparece na Bancada: o app OAuth do Google está em «Testing»
# e o refresh token vence a cada 7 dias. (Publicar o app no console do Google acaba com isso.)
# Abre o navegador: entrar com gu.costa.mendes@gmail.com e aceitar.
#   sh ~/Documents/claude/bancada/robo/reautorizar.sh
set -e
BANCADA="$(cd "$(dirname "$0")/.." && pwd)"
DUBLAGEM="$HOME/Documents/claude/dublagem"
G="$HOME/.claude/.google"

echo "1/5 · login no Google (abre o navegador)"
python3 "$DUBLAGEM/scripts/autorizar-drive.py" 10KTxyyI1-2f8plqRTB8pSsqycyCBwa1i

CID=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['client_id'])")
CSEC=$(python3 -c "import json;print(json.load(open('$G/client_secret.json'))['installed']['client_secret'])")
RTOK=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['refresh_token'])")

echo "2/5 · Bancada (site)"
cd "$BANCADA"
for par in "GOOGLE_OAUTH_CLIENT_ID:$CID" "GOOGLE_OAUTH_CLIENT_SECRET:$CSEC" "GOOGLE_OAUTH_REFRESH_TOKEN:$RTOK"; do
  printf '%s' "${par#*:}" | npx --yes wrangler pages secret put "${par%%:*}" --project-name bancada >/dev/null
done
./deploy.sh >/dev/null && echo "   site publicado"

echo "3/5 · vigia"
cd "$BANCADA/vigia"
printf '%s' "$RTOK" | npx --yes wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN >/dev/null && echo "   ok"

echo "4/5 · robô (GitHub)"
printf '%s' "$RTOK" | gh secret set GOOGLE_OAUTH_REFRESH_TOKEN --repo AlascaSA/bancada && echo "   ok"

echo "5/5 · Dublagem"
cd "$DUBLAGEM"
printf '%s' "$RTOK" | npx --yes wrangler pages secret put GOOGLE_OAUTH_REFRESH_TOKEN --project-name=dublagem >/dev/null
npm run deploy >/dev/null 2>&1 && echo "   publicada" || echo "   segredo gravado; o deploy da Dublagem falhou — rode npm run deploy na pasta dela"

sleep 5
echo "conferindo:"; curl -s "https://bancada-6x9.pages.dev/api/estado?cb=$$"; echo
curl -s -X POST https://bancada-vigia.gu-costa-mendes.workers.dev; echo
