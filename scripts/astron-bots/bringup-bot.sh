#!/usr/bin/env bash
# Stable, reproducible bring-up of ONE Astron context-bot (Hybrid-Architektur 2026-06-04).
#
#   Dry-run (default, shows what it WOULD do):
#     ./bringup-bot.sh <slug> "<BOT_NAME>" <model> <project> <workspace_subdir> <token>
#   Apply for real:
#     GO=1 ./bringup-bot.sh <slug> "<BOT_NAME>" <model> <project> <workspace_subdir> <token>
#
# Example:
#   GO=1 ./bringup-bot.sh memo "Astron Memo" haiku memo memo 123456:ABC...
#
# Each bot = full @AstronOne code, own .env (inherits shared API-keys + features from the
# master .env, then per-bot overrides), own DATA_DIR (= own history), own KeepAlive plist,
# but ALL run from ONE shared dist (dist.bots) so a single rebuild updates them together.
# Shared brain: same memory.db + bot-column (separate histories, cross-bot recall).
set -euo pipefail

NG="/Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram"
LA="/Users/ashtron/Library/LaunchAgents"
HOME_DIR="/Users/ashtron"
NODE="/opt/homebrew/opt/node@22/bin/node"
SHARED_DIST="$NG/dist.bots"            # 5 bots share this; update once for all
SRC_DIST="$NG/dist.master-v2.2"        # current good build to seed dist.bots from
GO="${GO:-0}"

slug="${1:?slug fehlt}"; name="${2:?BOT_NAME fehlt}"; model="${3:?model fehlt}"
project="${4:?project fehlt}"; wsub="${5:?workspace_subdir fehlt}"; token="${6:?token fehlt}"

envfile="$NG/.env.$slug"
plist="$LA/com.nexus.nexusgram-$slug.plist"
datadir="$HOME_DIR/.nexusgram-$slug"
workspace="$HOME_DIR/AstronWork/$wsub"
label="com.nexus.nexusgram-$slug"

say(){ echo "  $*"; }
run(){ if [ "$GO" = "1" ]; then eval "$@"; else say "[dry] $*"; fi; }

echo "=== Bringup: $name (slug=$slug, model=$model, project=$project) — GO=$GO ==="

# 1) Shared dist (seed once from the current good master build)
if [ ! -d "$SHARED_DIST" ]; then
  say "shared dist fehlt → seed aus $SRC_DIST"
  run "cp -R '$SRC_DIST' '$SHARED_DIST'"
else say "shared dist vorhanden: $SHARED_DIST"; fi

# 2) .env.<slug> — vom master .env erben, dann per-bot Overrides
set_key(){ # set_key FILE KEY VALUE  (replace-or-append; | delimiter, safe for bot tokens)
  local f="$1" k="$2" v="$3"
  if [ "$GO" = "1" ]; then
    if grep -qE "^$k=" "$f"; then sed -i '' "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
  else say "[dry] set $k in $(basename "$f")"; fi
}
if [ "$GO" = "1" ]; then cp "$NG/.env" "$envfile"; else say "[dry] cp .env -> .env.$slug (erbt API-Keys+Features)"; fi
set_key "$envfile" TELEGRAM_BOT_TOKEN   "$token"
set_key "$envfile" BOT_NAME             "$name"
set_key "$envfile" DATA_DIR             "$datadir"
set_key "$envfile" CLAUDE_DEFAULT_MODEL "$model"
set_key "$envfile" BOT_MEMORY_PROJECT   "$project"
set_key "$envfile" WORKSPACE_DIR        "$workspace"
set_key "$envfile" NEXUS_MEMORY_SCOPE   "self_private"   # Arashs eigener Bot → volle Memory-Sicht
run "mkdir -p '$datadir' '$workspace'"
run "chmod 600 '$envfile'"

# 3) KeepAlive launchd plist (eigenes .env + eigene Logs, gemeinsames dist.bots)
write_plist(){
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>Comment</key><string>Astron context-bot: $name</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$SHARED_DIST/index.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>WorkingDirectory</key><string>$NG</string>
  <key>StandardOutPath</key><string>$HOME_DIR/.nexusgram/logs/$slug.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/.nexusgram/logs/$slug.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>NEXUSGRAM_ENV_PATH</key><string>$envfile</string>
    <key>PATH</key><string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict></plist>
PLIST
}
if [ "$GO" = "1" ]; then write_plist; say "plist geschrieben: $plist"; else say "[dry] plist schreiben: $plist"; fi

# 4) Laden + starten (KeepAlive → übersteht Reboot = stabile Leitung)
run "launchctl bootstrap gui/501 '$plist' 2>/dev/null || launchctl kickstart -k gui/501/$label"
echo "=== fertig ($name). Verify: tail -5 ~/.nexusgram/logs/$slug.log + im Bot /start ==="
