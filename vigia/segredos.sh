#!/bin/sh
# Segredos do vigia (Worker bancada-vigia): os três do Drive (mesmo app OAuth da Dublagem, de ~/.claude/.google)
# e o token do GitHub que dispara o workflow (o do `gh`, conta AlascaSA, escopos repo + workflow).
# Rodar UMA vez, depois `npx wrangler deploy` nesta pasta. Repetir se o token do Google for reautorizado.
set -e
cd "$(dirname "$0")"
G="$HOME/.claude/.google"
CID=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['client_id'])")
CSEC=$(python3 -c "import json;print(json.load(open('$G/client_secret.json'))['installed']['client_secret'])")
RTOK=$(python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['refresh_token'])")
GHT=$(gh auth token --user AlascaSA)
printf '%s' "$CID"  | npx --yes wrangler secret put GOOGLE_OAUTH_CLIENT_ID
printf '%s' "$CSEC" | npx --yes wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
printf '%s' "$RTOK" | npx --yes wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
printf '%s' "$GHT"  | npx --yes wrangler secret put GH_TOKEN
echo "segredos do vigia gravados; agora: npx wrangler deploy"
