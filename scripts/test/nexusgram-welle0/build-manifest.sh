#!/usr/bin/env bash
# Release evidence. It never builds, swaps symlinks, or talks to launchd.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLIST_DIR="${WELLE0_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"

if [ "${1:-}" = "--write-release" ]; then
  release_dir="${2:-}"
  if [ -z "$release_dir" ] || [ "$#" -ne 2 ]; then
    printf 'usage: %s --write-release <existing-release-directory>\n' "$0" >&2
    exit 64
  fi
  if [ ! -d "$release_dir" ]; then
    printf 'release directory does not exist: %s\n' "$release_dir" >&2
    exit 66
  fi
  release_real="$(cd "$release_dir" && pwd -P)"
  repo_real="$(cd "$REPO_ROOT" && pwd -P)"
  case "$release_real" in
    "$repo_real"/releases/*) ;;
    *)
      printf 'release directory must be below %s/releases: %s\n' "$repo_real" "$release_real" >&2
      exit 65
      ;;
  esac
  tmp_file="$release_real/.BUILD_INFO.json.$$"
  umask 077
  printf '{\n  "commit_sha": "%s",\n  "branch": "%s",\n  "built_at": "%s"\n}\n' \
    "$(git -C "$REPO_ROOT" rev-parse HEAD)" \
    "$(git -C "$REPO_ROOT" branch --show-current)" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$tmp_file"
  mv "$tmp_file" "$release_real/BUILD_INFO.json"
  printf 'wrote %s/BUILD_INFO.json\n' "$release_real"
  exit 0
fi

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
