#!/bin/sh
# Instala o robô como LaunchAgent (roda ao ligar o Mac, reinicia se cair). A cópia executável mora fora de
# ~/Documents porque o launchd não consegue rodar script de lá (TCC nega; o job sai com 126).
# Rodar UMA vez (e de novo sempre que robo/*.mjs mudar):  sh robo/instalar.sh
set -e
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO="$HOME/Library/Application Support/Bancada/robo"
LOGS="$HOME/Library/Logs/Bancada"
PLIST="$HOME/Library/LaunchAgents/com.gcosta.bancada-robo.plist"
mkdir -p "$DESTINO" "$LOGS"
cp "$ORIGEM/robo.mjs" "$ORIGEM/drive.mjs" "$ORIGEM/package.json" "$DESTINO/"
cd "$DESTINO" && npm install --silent --no-audit --no-fund
NODE="$(command -v node)"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gcosta.bancada-robo</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DESTINO/robo.mjs</string></array>
  <key>WorkingDirectory</key><string>$DESTINO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGS/robo.log</string>
  <key>StandardErrorPath</key><string>$LOGS/robo.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.gcosta.bancada-robo" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "robô instalado: log em $LOGS/robo.log"
