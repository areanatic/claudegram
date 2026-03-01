#!/bin/bash
# Start Claudegram Dev Bot (@AstronDevBot)
# Restart loop: auto-recovers after crashes with 30s cooldown

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/Cellar/node@22/22.22.0_1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/ashtron"
export CLAUDEGRAM_ENV_PATH="$SCRIPT_DIR/.env.dev"

# Unset CLAUDECODE to allow Claude Code subprocesses from the bot
unset CLAUDECODE

echo "🧪 Starting Claudegram DEV Bot (@AstronDevBot)..."
echo "📋 Config: $CLAUDEGRAM_ENV_PATH"

while true; do
    node "$SCRIPT_DIR/dist/index.js"
    EXIT_CODE=$?
    echo "⚠️  Dev Bot exited with code $EXIT_CODE — restarting in 30s..."
    sleep 30
    echo "🔄 Restarting Dev Bot..."
done
