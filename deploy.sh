#!/bin/sh
# Monta dist/ só com o que a página precisa e publica no Cloudflare Pages (projeto "bancada").
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp index.html dist/ && cp -R src presets fonts functions dist/
printf '/*\n  Cache-Control: no-store\n' > dist/_headers
npx --yes wrangler pages deploy dist --project-name bancada --commit-dirty=true "$@"
