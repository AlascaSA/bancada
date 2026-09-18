#!/bin/sh
# Põe no Cloudflare Pages (projeto bancada) os três segredos do Drive que as funções /api/drive usam:
# o mesmo app OAuth e o mesmo refresh token da Dublagem (conta gu.costa.mendes), lidos de ~/.claude/.google.
# Rodar UMA vez (e de novo se o token for reautorizado). Segredo novo só vale depois de um deploy novo (./deploy.sh).
set -e
cd "$(dirname "$0")/.."
G="$HOME/.claude/.google"
CID=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['client_id'])")
CSEC=$(python3 -c "import json;print(json.load(open('$G/client_secret.json'))['installed']['client_secret'])")
RTOK=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['refresh_token'])")
printf '%s' "$CID"  | npx --yes wrangler pages secret put GOOGLE_OAUTH_CLIENT_ID     --project-name bancada
printf '%s' "$CSEC" | npx --yes wrangler pages secret put GOOGLE_OAUTH_CLIENT_SECRET --project-name bancada
printf '%s' "$RTOK" | npx --yes wrangler pages secret put GOOGLE_OAUTH_REFRESH_TOKEN --project-name bancada
echo "segredos gravados; agora ./deploy.sh"
