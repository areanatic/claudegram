#!/usr/bin/env bash
# Bring up all 5 Astron context-bots, pulling each token from the 1Password vault via op.
# bash 3.2 compatible (macOS default) — no associative arrays. Token values NEVER printed.
set -uo pipefail
cd "$(dirname "$0")"

# 1) op session
if ! op whoami >/dev/null 2>&1; then
  eval "$(op signin --account my.1password.com 2>/dev/null)" 2>/dev/null || true
fi
if ! op whoami >/dev/null 2>&1; then
  echo "ABORT: op nicht angemeldet. Erst 'op signin' in diesem Terminal, dann nochmal."
  exit 3
fi
echo "op: $(op whoami 2>/dev/null | head -1)"

# 2) Vault
VAULT=""
for v in "AI Nexus Bots" "Nexus Bots"; do
  if op vault get "$v" >/dev/null 2>&1; then VAULT="$v"; break; fi
done
[ -z "$VAULT" ] && { echo "ABORT: Tresor nicht gefunden."; op vault list 2>/dev/null; exit 4; }
echo "Vault: $VAULT"
echo "=== Items im Tresor ==="
op item list --vault "$VAULT" --format json 2>/dev/null | \
  python3 -c "import sys,json;[print(' •',i['title']) for i in json.load(sys.stdin)]"

# 3) Bot-Matrix: slug | title-match (regex, case-insensitive) | BOT_NAME | model | project | workspace
BOTS="
memo|memo|Astron Memo|haiku|memo|memo
dev1|dev ?1|Astron Dev1|sonnet|dev-video|video
dev2|dev ?2|Astron Dev2|opus|dev-projects|projects
dev3|dev ?3|Astron Dev3|opus|dexhub|dexhub
family-arash|family|Astron Family|sonnet|family|family
work|work|Astron Work|sonnet|work|work
"

DONE=""
printf '%s\n' "$BOTS" | while IFS='|' read -r slug match name model project wsub; do
  [ -z "${slug:-}" ] && continue
  # idempotent: skip bots that already run (so a re-run only brings up the missing one)
  if launchctl list 2>/dev/null | grep -q "com.nexus.nexusgram-$slug"; then
    echo "  $slug: läuft schon — skip"; continue
  fi
  # find item whose title matches (regex, case-insensitive)
  item=$(op item list --vault "$VAULT" --format json 2>/dev/null | \
    python3 -c "
import sys,json,re
pat=re.compile(r'$match', re.I)
a=[i['title'] for i in json.load(sys.stdin) if pat.search(i['title'])]
print(a[0] if a else '')")
  if [ -z "$item" ]; then echo "  $slug: kein Item ~/$match/ im Tresor — skip"; continue; fi
  # pull token (label token/credential/api/bot, else first concealed field) — NO echo of value
  tok=$(op item get "$item" --vault "$VAULT" --format json 2>/dev/null | \
    python3 -c "
import sys,json
fs=json.load(sys.stdin).get('fields',[])
def pick():
    for f in fs:
        lab=(f.get('label') or '').lower()
        if any(k in lab for k in ('token','credential','bot','api')) and f.get('value'): return f['value']
    for f in fs:
        if f.get('type')=='CONCEALED' and f.get('value'): return f['value']
    return ''
print(pick())")
  if [ -z "$tok" ]; then echo "  $slug: Item '$item' hat kein lesbares Token-Feld — skip"; continue; fi
  echo "  $slug: Item '$item' -> Token (len ${#tok}) -> bringe hoch..."
  GO=1 ./bringup-bot.sh "$slug" "$name" "$model" "$project" "$wsub" "$tok" 2>&1 | sed 's/^/      /'
done
echo "=== Durchlauf fertig. Prüfe oben pro Bot. ==="
