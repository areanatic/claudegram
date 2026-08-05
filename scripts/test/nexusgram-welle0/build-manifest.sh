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
  # Generated dist/release outputs are allowed; every source/config/test path
  # must still match HEAD. This catches tracked edits and untracked source files.
  dirty_source="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- . \
    ':(exclude)dist/**' ':(exclude)releases/**' ':(exclude)node_modules/**')"
  if [ -n "$dirty_source" ]; then
    printf 'refusing provenance for dirty source tree\n%s\n' "$dirty_source" >&2
    exit 65
  fi
  commit_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  source_tree_hash="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')"
  artifact_manifest_sha256="$(
    cd "$release_real"
    find . -type f ! -name 'BUILD_INFO.json' ! -name '.BUILD_INFO.json.*' -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256 \
      | awk '{print $1}'
  )"
  role_profile_sha256="$(
    {
      git -C "$REPO_ROOT" show HEAD:src/config.ts
      git -C "$REPO_ROOT" show HEAD:src/bot/bot.ts
      git -C "$REPO_ROOT" show HEAD:src/bot/person-policy.ts
    } | shasum -a 256 | awk '{print $1}'
  )"
  tmp_file="$release_real/.BUILD_INFO.json.$$"
  umask 077
  printf '{\n  "commit_sha": "%s",\n  "source_tree_hash": "%s",\n  "artifact_manifest_sha256": "%s",\n  "role_profile_sha256": "%s",\n  "dirty": false,\n  "branch": "%s",\n  "built_at": "%s"\n}\n' \
    "$commit_sha" \
    "$source_tree_hash" \
    "$artifact_manifest_sha256" \
    "$role_profile_sha256" \
    "$(git -C "$REPO_ROOT" branch --show-current)" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$tmp_file"
  mv "$tmp_file" "$release_real/BUILD_INFO.json"
  printf 'wrote %s/BUILD_INFO.json\n' "$release_real"
  exit 0
fi

printf 'NexusGram Welle-0 build manifest\n'
printf 'generated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'commit_sha=%s\n\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
printf 'source_tree_hash=%s\n\n' "$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')"

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
