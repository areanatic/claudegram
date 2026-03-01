#!/bin/bash
# Start Claudegram Dev Bot (@AstronDevBot)
# Lock file prevents multiple instances; restart loop recovers from crashes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/Cellar/node@22/22.22.0_1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/ashtron"
export CLAUDEGRAM_ENV_PATH="$SCRIPT_DIR/.env.dev"

# Unset CLAUDECODE to allow Claude Code subprocesses from the bot
unset CLAUDECODE

LOCK_FILE="/tmp/claudegram-dev.lock"

# Exit immediately if another instance is already running
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  echo "⚠️  Dev bot already running (PID $(cat "$LOCK_FILE")) — exiting"
  exit 0
fi

echo "🧪 Starting Claudegram DEV Bot (@AstronDevBot)..."
echo "📋 Config: $CLAUDEGRAM_ENV_PATH"

cleanup() { rm -f "$LOCK_FILE"; }
trap cleanup EXIT

# Write lock file BEFORE the loop — prevents race condition where a second
# script passes the "already running" check during the 30s restart sleep.
echo $$ > "$LOCK_FILE"

while true; do
    node "$SCRIPT_DIR/dist/index.js"
    EXIT_CODE=$?
    echo "⚠️  Dev Bot exited with code $EXIT_CODE — restarting in 30s..."
    sleep 30
    echo "🔄 Restarting Dev Bot..."
done
