#!/bin/sh
# Segredos do robô no GitHub (repo AlascaSA/bancada, workflow robo.yml): os três do Drive, lidos de ~/.claude/.google.
# Rodar UMA vez (e de novo se o token do Google for reautorizado).
set -e
G="$HOME/.claude/.google"
R="AlascaSA/bancada"
python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['client_id'])"                   | gh secret set GOOGLE_OAUTH_CLIENT_ID     --repo "$R"
python3 -c "import json;print(json.load(open('$G/client_secret.json'))['installed']['client_secret'])" | gh secret set GOOGLE_OAUTH_CLIENT_SECRET --repo "$R"
python3 -c "import json;print(json.load(open('$G/token_dublagem.json'))['refresh_token'])"              | gh secret set GOOGLE_OAUTH_REFRESH_TOKEN --repo "$R"
echo "segredos do robô gravados em $R"
