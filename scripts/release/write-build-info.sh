#!/usr/bin/env bash
# Release hook: record the exact source identity after a release directory exists.
# This deliberately delegates to the canonical Welle-0 manifest script so rollout
# evidence and BUILD_INFO.json have one implementation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$REPO_ROOT/scripts/test/nexusgram-welle0/build-manifest.sh" --write-release "$@"
