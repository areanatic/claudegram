#!/usr/bin/env bash
# Read-only release evidence.  It never builds, swaps symlinks, or talks to launchd.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLIST_DIR="${WELLE0_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"

printf 'NexusGram Welle-0 build manifest\n'
printf 'generated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'commit_sha=%s\n\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"

printf '[dist symlinks]\n'
found=0
for link in "$REPO_ROOT"/dist-* "$REPO_ROOT"/dist.*; do
  [ -L "$link" ] || continue
  found=1
  printf '%s -> %s\n' "$(basename "$link")" "$(readlink "$link")"
done
[ "$found" -eq 1 ] || printf '(none)\n'

printf '\n[LaunchAgents consuming dist.bots]\n'
count=0
for plist in "$PLIST_DIR"/com.nexus.nexusgram*.plist; do
  [ -f "$plist" ] || continue
  program_args="$(plutil -extract ProgramArguments xml1 -o - "$plist" 2>/dev/null || true)"
  case "$program_args" in
    *dist.bots*)
      label="$(plutil -extract Label raw -o - "$plist" 2>/dev/null || basename "$plist" .plist)"
      printf '%s\t%s\n' "$label" "$(basename "$plist")"
      count=$((count + 1))
      ;;
  esac
done
printf 'dist.bots_consumers=%d\n' "$count"
