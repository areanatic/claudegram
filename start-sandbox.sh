#!/bin/bash
# Start Nexusgram Sandbox Bot (@NexusOneDevBot)
# Lock file prevents multiple instances; restart loop recovers from crashes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/Cellar/node@22/22.22.0_1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/ashtron"

# Unset CLAUDECODE to allow Claude Code subprocesses from the bot
unset CLAUDECODE

# Use sandbox environment
export NODE_ENV=sandbox

LOCK_FILE="/tmp/nexusgram-sandbox.lock"

# Exit immediately if another instance is already running
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  echo "⚠️  Sandbox bot already running (PID $(cat "$LOCK_FILE")) — exiting"
  exit 0
fi

echo "🔬 Starting Nexusgram SANDBOX Bot (@NexusOneDevBot)..."

cleanup() { rm -f "$LOCK_FILE"; }
trap cleanup EXIT

# Write lock file BEFORE the loop — prevents race condition
echo $$ > "$LOCK_FILE"

while true; do
    # Use .env.sandbox config
    node "$SCRIPT_DIR/dist/index.js" --env-file="$SCRIPT_DIR/.env.sandbox"
    EXIT_CODE=$?
    echo "⚠️  Bot exited with code $EXIT_CODE — restarting in 30s..."
    sleep 30
    echo "🔄 Restarting Sandbox Bot..."
done
