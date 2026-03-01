#!/bin/bash
# Start Claudegram Stable Bot (@AstronOneBot)
# Restart loop: auto-recovers after crashes with 30s cooldown

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/Cellar/node@22/22.22.0_1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/ashtron"

# Unset CLAUDECODE to allow Claude Code subprocesses from the bot
unset CLAUDECODE

echo "🤖 Starting Claudegram STABLE Bot (@AstronOneBot)..."

while true; do
    node "$SCRIPT_DIR/dist/index.js"
    EXIT_CODE=$?
    echo "⚠️  Bot exited with code $EXIT_CODE — restarting in 30s..."
    sleep 30
    echo "🔄 Restarting Stable Bot..."
done
