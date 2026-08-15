#!/usr/bin/env bash

# This is an executable operator facade, not a shell library. A top-level
# `return` succeeds only while the file is being sourced, so this guard cannot
# be bypassed by spoofing argv[0]. Refuse before changing the caller's shell
# options or defining any legacy function.
if (return 0 2>/dev/null); then
  printf '%s\n' "BLOCKED: nexusgram-ctl cannot be sourced." >&2
  return 2
fi

set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# Nexusgram Control — Multi-Bot Management
# ═══════════════════════════════════════════════════════════════
#
# Usage:
#   nexusgram-ctl.sh create-bot --name "Mom Assistant" --id mom --token "BOT_TOKEN" \
#     --lang de --lang2 fa --project mom --tools "Read,Write,Glob,Grep"
#   nexusgram-ctl.sh list
#   nexusgram-ctl.sh status <bot-id>
#   nexusgram-ctl.sh restart <bot-id>
#   nexusgram-ctl.sh stop <bot-id>
#   nexusgram-ctl.sh logs <bot-id>
#   nexusgram-ctl.sh rebuild          — npm run build + restart all bots
#
# R53 safety note (2026-08-15): PM2 was retired as a Nexusgram supervisor.
# The public dispatch at the end of this file is now deliberately read-only.
# Historical creation/PM2 functions remain in-place for forensic recovery, but
# no public action can reach them. Lifecycle changes use the reviewed Dirigent
# deployment path and always require a separate operator Go.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEXUSGRAM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPACES_DIR="/Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/spaces"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.nexusgram/logs"
NODE_PATH="/opt/homebrew/opt/node@22/bin/node"
TMPDIR_VAL="/var/folders/8s/r60bqt214jx623141p9dvnb80000gn/T/"

# Master bot .env (for API key extraction)
MASTER_ENV="$NEXUSGRAM_DIR/.env"

ACTION="${1:-help}"
shift 2>/dev/null || true

# ─── Helpers ──────────────────────────────────────────────────

red()   { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
yellow(){ echo -e "\033[33m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }

get_env_val() {
  local file="$1" key="$2"
  grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-
}

# ─── create-bot ───────────────────────────────────────────────

create_bot() {
  local name="" id="" token="" lang="de" lang2="" project="" tools="Read,Write,Glob,Grep"
  local user_ids="7067348774" soul_text="" welcome_extra=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)    name="$2"; shift 2 ;;
      --id)      id="$2"; shift 2 ;;
      --token)   token="$2"; shift 2 ;;
      --lang)    lang="$2"; shift 2 ;;
      --lang2)   lang2="$2"; shift 2 ;;
      --project) project="$2"; shift 2 ;;
      --tools)   tools="$2"; shift 2 ;;
      --users)   user_ids="$2"; shift 2 ;;
      *) red "Unknown option: $1"; exit 1 ;;
    esac
  done

  # Validate required params
  [[ -z "$name" ]]    && { red "Missing --name"; exit 1; }
  [[ -z "$id" ]]      && { red "Missing --id (short identifier, e.g. 'mom', 'family')"; exit 1; }
  [[ -z "$token" ]]   && { red "Missing --token (Telegram Bot Token from BotFather)"; exit 1; }
  [[ -z "$project" ]] && project="$id"

  # Check for duplicate token
  local existing_envs
  existing_envs=$(find "$NEXUSGRAM_DIR" -name ".env.*" -not -name ".env.example" 2>/dev/null)
  for envfile in $existing_envs; do
    local existing_token
    existing_token=$(get_env_val "$envfile" "TELEGRAM_BOT_TOKEN")
    if [[ "$existing_token" == "$token" ]]; then
      red "ERROR: Token already used in $(basename "$envfile")!"
      red "Duplicate tokens cause silent 50% message loss."
      exit 1
    fi
  done

  local workspace="$SPACES_DIR/$id"
  local botdata="$workspace/.botdata"
  local env_file="$NEXUSGRAM_DIR/.env.$id"
  local plist_file="$LAUNCH_AGENTS_DIR/com.nexus.nexusgram-${id}.plist"
  local push_script="$botdata/push.sh"

  # Check if bot already exists
  if [[ -f "$env_file" ]]; then
    red "Bot '$id' already exists ($env_file)"
    exit 1
  fi

  bold "Creating Space Bot: $name ($id)"
  echo ""

  # 1. Create workspace
  echo "📁 Creating workspace..."
  mkdir -p "$workspace"/{inbox,docs,.botdata/logs}

  # 2. Extract API keys from master
  local openai_key groq_key
  openai_key=$(get_env_val "$MASTER_ENV" "OPENAI_API_KEY")
  groq_key=$(get_env_val "$MASTER_ENV" "GROQ_API_KEY")

  # 3. Generate language config for soul file
  local lang_name lang2_name lang_instruction
  case "$lang" in
    de) lang_name="Deutsch" ;;
    en) lang_name="English" ;;
    *) lang_name="$lang" ;;
  esac

  if [[ -n "$lang2" ]]; then
    case "$lang2" in
      fa) lang2_name="Farsi/Persisch" ;;
      ru) lang2_name="Russisch" ;;
      en) lang2_name="Englisch" ;;
      *) lang2_name="$lang2" ;;
    esac
    lang_instruction="- Standard: Antworte auf ${lang_name}
- Wenn auf ${lang2_name} geschrieben wird: antworte auf ${lang2_name} (Text und Audio)
- Dokumente und Notizen immer auf ${lang_name} ablegen"
  else
    lang_instruction="- Antworte auf ${lang_name}
- Dokumente und Notizen auf ${lang_name} ablegen"
  fi

  # 4. Generate soul file
  echo "🧠 Writing soul file..."
  cat > "$workspace/${id}-soul.md" << SOUL
# ${name} — Nexusgram Space

Du bist ein persönlicher Assistent.

## Sprachen:
${lang_instruction}

## Was du kannst:
- Dokumente empfangen (Fotos, PDFs) — lesen, zusammenfassen, kategorisieren
- Fragen beantworten — zu Dokumenten, Terminen oder allem anderen
- Sparring — Hilfe bei Entscheidungen, Recherche, Ideen
- Medizinische Dokumente zusammenfassen und einordnen
- Termine und Todos verwalten (termine.md, todos.md)
- Fristen aus Dokumenten erkennen

## Was du NICHT tun darfst:
- Keine Code-Ausführung (kein Bash)
- Keine Dateien außerhalb deines Workspace lesen/schreiben
- Keine sensiblen Daten in Telegram-Nachrichten
- Medizinische Dokumente: Zusammenfassen ja, Diagnosen stellen nein

## Dein Workspace:
- inbox/ — Empfangene Dokumente
- docs/ — Sortierte Dokumente
- termine.md — Termine und Fristen
- todos.md — Aktive Aufgaben

## Kommunikationsstil:
- Warmherzig, unterstützend, geduldig
- Sprich die Nutzerin/den Nutzer direkt und persönlich an
- Merke dir Vorlieben zur Ansprache
- Verständlich und klar — vermeide Fachsprache wo möglich

## WICHTIG: Keine technischen Details
- NIEMALS interne Operationen erwähnen (kein "Memory aktualisiert", "Datei geschrieben")
- Kurz bestätigen: "Hab ich mir gemerkt!" oder "Erledigt, ist notiert."
- Bei INHALTLICHEN Fragen ausführlich. Bei System-Aktionen KURZ.
SOUL

  # 5. Generate welcome file
  echo "👋 Writing welcome message..."
  cat > "$workspace/welcome.md" << WELCOME
Hallo! 👋

Ich bin dein persönlicher **${name}**.

**Was ich kann:**

📄 **Dokumente** — Schick mir Dokumente als Foto oder PDF. Ich lese und fasse zusammen.

🔍 **Fragen** — Frag mich was du wissen willst.

💬 **Gespräch** — Ich helfe bei Entscheidungen und Recherche.

🏥 **Gesundheit** — Medizinische Dokumente einordnen und zusammenfassen.

📅 **Termine & Aufgaben** — Ich merke mir Termine und erinnere dich.

🎤 **Sprache** — Sprachnachrichten gehen auch, ich antworte per Audio.

Einfach losschreiben, Foto schicken oder Sprachnachricht senden!
WELCOME

  # 6. Generate termine + todos
  echo "📅 Creating termine & todos..."
  cat > "$workspace/termine.md" << 'TERMINE'
# Termine & Fristen

## Anstehend

_Noch keine Termine._

## Wiederkehrend

_Keine wiederkehrenden Einträge._

## Erledigt

_Erledigte Termine werden hier archiviert._
TERMINE

  cat > "$workspace/todos.md" << 'TODOS'
# Aufgaben

## Offen

_Noch keine Aufgaben._

## Erledigt

_Erledigte Aufgaben werden hier archiviert._
TODOS

  # 7. Generate .env file
  echo "⚙️  Writing .env.$id..."
  cat > "$env_file" << ENV
# ═══════════════════════════════════════════════════════════════
# Nexusgram Space: ${name}
# Created: $(date '+%Y-%m-%d %H:%M')
# ═══════════════════════════════════════════════════════════════

TELEGRAM_BOT_TOKEN=${token}
ALLOWED_USER_IDS=${user_ids}
BOT_NAME=${name}
STREAMING_MODE=streaming

WORKSPACE_DIR=${workspace}
DATA_DIR=${botdata}

BOT_MEMORY_PROJECT=${project}
BOT_SOUL_FILE=${workspace}/${id}-soul.md
BOT_TOOLS=${tools}
BOT_MINIMAL_COMMANDS=true
BOT_WELCOME_FILE=${workspace}/welcome.md

OPENAI_API_KEY=${openai_key}
GROQ_API_KEY=${groq_key}

DOCUMENT_INBOX_ENABLED=true
EXTRACT_ENABLED=false
REDDIT_ENABLED=false
MEDIUM_ENABLED=false
TELEGRAPH_ENABLED=true
TTS_ENABLED=true
TTS_PROVIDER=openai
VOICE_LANGUAGE=${lang}
DANGEROUS_MODE=false

VOICE_FIRST_MODE_ENABLED=true
TRANSCRIBE_ENABLED=true

CLAUDE_SDK_LOG_LEVEL=basic
LOG_AGENT_HOOKS=false
ENV

  chmod 600 "$env_file"

  # 8. Generate launchd plist
  echo "🚀 Creating launchd plist..."
  cat > "$plist_file" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.nexus.nexusgram-${id}</string>
    <key>Comment</key>
    <string>Nexusgram Space: ${name}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${NODE_PATH}</string>
      <string>${NEXUSGRAM_DIR}/dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>WorkingDirectory</key>
    <string>${NEXUSGRAM_DIR}</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/${id}.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/${id}.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/ashtron</string>
      <key>TMPDIR</key>
      <string>${TMPDIR_VAL}</string>
      <key>NEXUSGRAM_ENV_PATH</key>
      <string>${env_file}</string>
      <key>PATH</key>
      <string>/opt/homebrew/opt/node@22/bin:/Users/ashtron/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>NODE_ENV</key>
      <string>production</string>
    </dict>
  </dict>
</plist>
PLIST

  # 9. Generate push script (copy from family template and adapt)
  echo "🔔 Creating push script..."
  cat > "$push_script" << 'PUSHSCRIPT'
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPACE_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$SCRIPT_DIR/logs/push.log"
PUSHSCRIPT

  # Append config (not in heredoc to expand variables)
  cat >> "$push_script" << PUSHCONFIG
BOT_TOKEN="${token}"
CHAT_ID="${user_ids%%,*}"
TERMINE_FILE="\$SPACE_DIR/termine.md"
TODOS_FILE="\$SPACE_DIR/todos.md"
PUSHCONFIG

  cat >> "$push_script" << 'PUSHREST'
ACTION="${1:-daily}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

send_message() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" -d "text=${1}" -d "parse_mode=${2:-Markdown}" > /dev/null 2>&1
  log "Sent: ${1:0:80}..."
}

check_termine() {
  [ -f "$TERMINE_FILE" ] || return
  local today=$(date '+%Y-%m-%d') tomorrow=$(date -v+1d '+%Y-%m-%d') msg=""
  while IFS= read -r line; do
    echo "$line" | grep -q "$today" && msg="${msg}📅 *HEUTE:* ${line#*] }\n"
    echo "$line" | grep -q "$tomorrow" && msg="${msg}📅 *Morgen:* ${line#*] }\n"
  done < "$TERMINE_FILE"
  [ -n "$msg" ] && send_message "🔔 *Termin-Erinnerung*\n\n${msg}"
}

check_todos() {
  [ -f "$TODOS_FILE" ] || return
  local today=$(date '+%Y-%m-%d') msg=""
  while IFS= read -r line; do
    if echo "$line" | grep -q "^\- \[ \]" && echo "$line" | grep -q "due:"; then
      local due=$(echo "$line" | grep -oE 'due: [0-9-]+' | cut -d' ' -f2)
      [[ -n "$due" && ("$due" < "$today" || "$due" == "$today") ]] && {
        local task=$(echo "$line" | sed 's/- \[ \] //' | sed 's/ | due:.*//')
        msg="${msg}⚠️ ${task} (${due})\n"
      }
    fi
  done < "$TODOS_FILE"
  [ -n "$msg" ] && send_message "📋 *Aufgaben-Erinnerung*\n\n${msg}"
}

weekly_summary() {
  local today=$(date '+%Y-%m-%d')
  local todos=$(grep -c "^\- \[ \]" "$TODOS_FILE" 2>/dev/null || echo 0)
  local termine=$(grep -c "^\- \[" "$TERMINE_FILE" 2>/dev/null || echo 0)
  send_message "📊 *Wochen-Zusammenfassung* (${today})\n\n📋 Offene Aufgaben: ${todos}\n📅 Termine: ${termine}\n\n_Schöne Woche! 💪_"
}

mkdir -p "$(dirname "$LOG_FILE")"
log "Running: $ACTION"
case "$ACTION" in
  daily)   check_termine; check_todos ;;
  weekly)  weekly_summary ;;
  remind)  [ -n "${2:-}" ] && send_message "🔔 *Erinnerung:* ${2}" || { echo "Usage: $0 remind \"text\""; exit 1; } ;;
  *)       echo "Usage: $0 {daily|weekly|remind \"text\"}"; exit 1 ;;
esac
log "Done: $ACTION"
PUSHREST

  chmod +x "$push_script"

  # 10. Create daily + weekly launchd plists for push
  echo "⏰ Creating reminder schedules..."
  cat > "$LAUNCH_AGENTS_DIR/com.nexus.${id}-daily.plist" << DAILYPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.nexus.${id}-daily</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${push_script}</string>
      <string>daily</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>${LOG_DIR}/${id}-push.log</string>
    <key>StandardErrorPath</key><string>${LOG_DIR}/${id}-push.err.log</string>
  </dict>
</plist>
DAILYPLIST

  cat > "$LAUNCH_AGENTS_DIR/com.nexus.${id}-weekly.plist" << WEEKLYPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.nexus.${id}-weekly</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${push_script}</string>
      <string>weekly</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>${LOG_DIR}/${id}-push.log</string>
    <key>StandardErrorPath</key><string>${LOG_DIR}/${id}-push.err.log</string>
  </dict>
</plist>
WEEKLYPLIST

  # 11. Start the bot
  echo ""
  bold "✅ Bot '$name' ($id) created!"
  echo ""
  echo "  Workspace:  $workspace"
  echo "  Env:        $env_file"
  echo "  Soul:       $workspace/${id}-soul.md"
  echo "  LaunchAgent: $plist_file"
  echo "  Logs:       $LOG_DIR/${id}.log"
  echo ""
  echo "To start:"
  echo "  1. Add bot to ecosystem.config.cjs"
  echo "  2. pm2 start ecosystem.config.cjs --only nexusgram-${id}"
  echo "  3. pm2 save"
  echo "  4. launchctl load $LAUNCH_AGENTS_DIR/com.nexus.${id}-daily.plist"
  echo "  5. launchctl load $LAUNCH_AGENTS_DIR/com.nexus.${id}-weekly.plist"
  echo ""
  echo "To customize: edit $workspace/${id}-soul.md and $workspace/welcome.md"
}

# ─── list ─────────────────────────────────────────────────────

list_bots() {
  bold "Nexusgram Bots:"
  echo ""
  export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
  pm2 jlist 2>/dev/null | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const bots = data.filter(p => p.name.startsWith('nexusgram-'));
    if (!bots.length) { console.log('  No bots found in PM2'); process.exit(0); }
    bots.forEach(b => {
      const id = b.name.replace('nexusgram-','');
      const status = b.pm2_env.status === 'online' ? '\x1b[32mRUNNING\x1b[0m' : '\x1b[31m' + b.pm2_env.status.toUpperCase() + '\x1b[0m';
      const mem = (b.monit.memory / 1024 / 1024).toFixed(0) + 'MB';
      const restarts = b.pm2_env.restart_time;
      console.log('  [' + id.padEnd(10) + '] ' + status + ' (PID ' + b.pid + ', ' + mem + ', ↺' + restarts + ')');
    });
  " 2>/dev/null || {
    # Fallback: simple pm2 status
    pm2 status 2>/dev/null
  }
  echo ""
}

# ─── bot-specific commands ────────────────────────────────────

bot_action() {
  local bot_id="$1" action="$2"
  local pm2_name="nexusgram-${bot_id}"
  export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"

  case "$action" in
    start)
      echo "Starting $pm2_name..."
      pm2 start ecosystem.config.cjs --only "$pm2_name" 2>&1
      ;;
    stop)
      echo "Stopping $pm2_name..."
      pm2 stop "$pm2_name" 2>&1
      ;;
    restart)
      echo "Restarting $pm2_name..."
      pm2 restart "$pm2_name" 2>&1
      ;;
    logs)
      pm2 logs "$pm2_name" --lines 30 --nostream 2>&1
      ;;
    status)
      pm2 describe "$pm2_name" 2>/dev/null | head -20 || red "Bot '$bot_id' not found in PM2"
      ;;
  esac
}

# ─── rebuild ──────────────────────────────────────────────────

rebuild() {
  echo "🔨 Building Nexusgram..."
  cd "$NEXUSGRAM_DIR"
  export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
  npm run build 2>&1

  echo ""
  echo "🔄 Restarting all bots via PM2..."
  pm2 restart all 2>&1
  pm2 save 2>&1
  sleep 3
  echo ""
  list_bots
}

# ─── read-only launchd status facade ─────────────────────────

# Status tools are initialized only for the read-only actions. This keeps every
# blocked lifecycle action independent from test/status configuration and makes
# it fail with the promised Exit 2 before any external command can run.
LAUNCHCTL_BIN=""
ID_BIN=""
AWK_BIN=""
GREP_BIN=""

init_status_tools() {
  if [[ "${NEXUSGRAM_CTL_TEST_MODE:-0}" == "1" ]]; then
    [[ -n "${NEXUSGRAM_LAUNCHCTL_BIN:-}" && -n "${NEXUSGRAM_ID_BIN:-}" ]] || {
      yellow "UNKNOWN — test mode requires launchctl and id fixtures"
      return 3
    }
    LAUNCHCTL_BIN="$NEXUSGRAM_LAUNCHCTL_BIN"
    ID_BIN="$NEXUSGRAM_ID_BIN"
    AWK_BIN="${NEXUSGRAM_AWK_BIN:-/usr/bin/awk}"
    GREP_BIN="${NEXUSGRAM_GREP_BIN:-/usr/bin/grep}"
  else
    LAUNCHCTL_BIN="/bin/launchctl"
    ID_BIN="/usr/bin/id"
    AWK_BIN="/usr/bin/awk"
    GREP_BIN="/usr/bin/grep"
  fi
}

resolve_bot_label() {
  local bot_id="$1"
  case "$bot_id" in
    master)       printf '%s\n' 'com.nexus.nexusgram' ;;
    family)       printf '%s\n' 'com.nexus.nexusgram-family' ;;
    mom)          printf '%s\n' 'com.nexus.nexusgram-mom' ;;
    dad)          printf '%s\n' 'com.nexus.nexusgram-dad' ;;
    family-arash) printf '%s\n' 'com.nexus.nexusgram-family-arash' ;;
    family-test)  printf '%s\n' 'com.nexus.nexusgram-family-test' ;;
    test)         printf '%s\n' 'com.nexus.nexusgram-test' ;;
    work)         printf '%s\n' 'com.nexus.nexusgram-work' ;;
    memo)         printf '%s\n' 'com.nexus.nexusgram-memo' ;;
    dev1)         printf '%s\n' 'com.nexus.nexusgram-dev1' ;;
    dev2)         printf '%s\n' 'com.nexus.nexusgram-dev2' ;;
    dev3)         printf '%s\n' 'com.nexus.nexusgram-dev3' ;;
    *) return 64 ;;
  esac
}

launchd_domain() {
  local uid
  uid="$($ID_BIN -u)" || return 3
  [[ "$uid" =~ ^[0-9]+$ ]] || return 3
  printf 'gui/%s\n' "$uid"
}

read_launchd_job() {
  local bot_id="$1" label domain output rc state pid runs last_exit program
  label="$(resolve_bot_label "$bot_id")" || {
    red "Unknown bot id '$bot_id'"
    return 64
  }
  domain="$(launchd_domain)" || {
    yellow "UNKNOWN [$bot_id] — user launchd domain is not readable"
    return 3
  }

  if output="$($LAUNCHCTL_BIN print "$domain/$label" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  if (( rc != 0 )); then
    if "$GREP_BIN" -qiE 'could not find service|service .* not found' <<<"$output"; then
      yellow "NOT_LOADED [$bot_id] $label"
      return 4
    fi
    yellow "UNKNOWN [$bot_id] $label — launchctl query failed (rc=$rc)"
    return 3
  fi

  if ! state="$("$AWK_BIN" '$1 == "state" && $2 == "=" { sub(/^[^=]*=[[:space:]]*/, ""); print; exit }' <<<"$output")" ||
     ! pid="$("$AWK_BIN" '$1 == "pid" && $2 == "=" { print $3; exit }' <<<"$output")" ||
     ! runs="$("$AWK_BIN" '$1 == "runs" && $2 == "=" { print $3; exit }' <<<"$output")" ||
     ! last_exit="$("$AWK_BIN" '$1 == "last" && $2 == "exit" && $3 == "code" && $4 == "=" { print $5; exit }' <<<"$output")" ||
     ! program="$("$AWK_BIN" '$1 == "program" && $2 == "=" { sub(/^[^=]*=[[:space:]]*/, ""); print; exit }' <<<"$output")"; then
    yellow "UNKNOWN [$bot_id] $label — launchctl output parser failed"
    return 3
  fi

  if [[ "$state" == "running" ]]; then
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      green "RUNNING [$bot_id] label=$label pid=$pid runs=${runs:-?} last_exit=${last_exit:-?}"
      [[ -z "$program" ]] || printf '  program=%s\n' "$program"
      return 0
    fi
    yellow "UNKNOWN [$bot_id] $label — state is running without a numeric pid"
    return 3
  fi
  if [[ -n "$state" ]]; then
    yellow "LOADED_NOT_RUNNING [$bot_id] label=$label state=$state runs=${runs:-?} last_exit=${last_exit:-?}"
    [[ -z "$program" ]] || printf '  program=%s\n' "$program"
    return 4
  fi
  yellow "UNKNOWN [$bot_id] $label — launchctl returned no parseable state"
  return 3
}

list_launchd_bots() {
  local bot_id rc unknown=0
  local -a bot_ids=(master family mom dad family-arash family-test test work memo dev1 dev2 dev3)
  bold "Nexusgram Bots — read-only launchd view"
  printf '\n'
  for bot_id in "${bot_ids[@]}"; do
    if read_launchd_job "$bot_id"; then
      rc=0
    else
      rc=$?
    fi
    if (( rc == 3 || rc == 64 )); then
      unknown=1
    fi
  done
  (( unknown == 0 )) || return 3
}

blocked_mutation() {
  red "BLOCKED: nexusgram-ctl is read-only; '$ACTION' cannot manage production bots."
  red "Use the reviewed Dirigent deployment path only after explicit operator Go."
  return 2
}

readonly_usage() {
  bold "Nexusgram Control — read-only launchd status"
  echo ""
  echo "  list                    List the 12 canonical bot LaunchAgents"
  echo "  status [bot-id]         Read one canonical LaunchAgent (default: master)"
  echo "  help                    Show this help"
  echo ""
  echo "Blocked here: create-bot, start, stop, restart, logs, rebuild."
}

# ─── Main ─────────────────────────────────────────────────────

case "$ACTION" in
  list)
    [[ $# -eq 0 ]] || { red "list accepts no arguments"; exit 64; }
    init_status_tools || exit $?
    list_launchd_bots
    ;;
  status)
    [[ $# -le 1 ]] || { red "status accepts at most one bot id"; exit 64; }
    init_status_tools || exit $?
    read_launchd_job "${1:-master}"
    ;;
  create-bot|start|stop|restart|logs|log|rebuild)
    blocked_mutation
    ;;
  help|-h|--help)
    [[ $# -eq 0 ]] || { red "help accepts no arguments"; exit 64; }
    readonly_usage
    ;;
  *)
    red "Unknown action '$ACTION'"
    readonly_usage >&2
    exit 64
    ;;
esac
