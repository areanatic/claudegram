#!/bin/bash
# Start Claudegram Stable Bot (@AstronOneBot)
# Lock file prevents multiple instances; restart loop recovers from crashes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/Cellar/node@22/22.22.0_1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/ashtron"

# Unset CLAUDECODE to allow Claude Code subprocesses from the bot
unset CLAUDECODE

LOCK_FILE="/tmp/claudegram-stable.lock"

# Exit immediately if another instance is already running
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  echo "⚠️  Stable bot already running (PID $(cat "$LOCK_FILE")) — exiting"
  exit 0
fi

echo "🤖 Starting Claudegram STABLE Bot (@AstronOneBot)..."

# Persistent log — survives reboots, auto-rotates at 10k lines
LOG_DIR="$HOME/.claudegram/logs"
LOG_FILE="$LOG_DIR/stable.log"
mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 10000 ]; then
  tail -5000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi
exec >> "$LOG_FILE" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') START (PID $$) ==="

cleanup() { rm -f "$LOCK_FILE"; }
trap cleanup EXIT

# Write lock file BEFORE the loop — prevents race condition where a second
# script passes the "already running" check during the 30s restart sleep.
echo $$ > "$LOCK_FILE"

while true; do
    node "$SCRIPT_DIR/dist/index.js"
    EXIT_CODE=$?
    echo "⚠️  Bot exited with code $EXIT_CODE — restarting in 30s..."
    sleep 30
    echo "🔄 Restarting Stable Bot..."
done
