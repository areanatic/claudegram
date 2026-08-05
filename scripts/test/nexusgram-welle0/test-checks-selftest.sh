#!/usr/bin/env bash
# Fixture-only regression tests for Welle-0's own parsers and contract checks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${WELLE0_PYTHON:-python3}"
export WELLE0_PYTHON="$PYTHON_BIN"
# shellcheck source=welle0-lib.sh
source "$SCRIPT_DIR/welle0-lib.sh"

tmp_dir="$(mktemp -d "${TMPDIR:-/private/tmp}/welle0-selftest.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
contract="$tmp_dir/expected.json"

"$PYTHON_BIN" - "$contract" "$SCRIPT_DIR/welle0-contract.py" <<'PY'
import importlib.util
import json
import pathlib
import sys

contract_path = pathlib.Path(sys.argv[1])
module_path = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("welle0_contract", module_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
tools = [
    "mcp__alpha__first",
    "mcp__alpha__second",
]
contract_path.write_text(json.dumps({
    "servers": ["alpha"],
    "tools": tools,
    "tools_sha256": module.tools_sha256(tools),
}), encoding="utf-8")
PY

pass=0
check_pass() {
  local name="$1"
  shift
  if "$@"; then
    printf 'PASS %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n' "$name" >&2
    exit 1
  fi
}

check_fail() {
  local name="$1"
  shift
  if "$@" 2>/dev/null; then
    printf 'FAIL %s (unexpected success)\n' "$name" >&2
    exit 1
  else
    printf 'PASS %s\n' "$name"
    pass=$((pass + 1))
  fi
}

inventory_fixture_fails() {
  printf '%s\n' "$1" | welle0_check_mcp_inventory "$contract"
}

inventory_fixture_passes() {
  printf '%s\n' "$1" | welle0_check_mcp_inventory "$contract"
}

check_pass "exact-sorted-tool-set-passes" inventory_fixture_passes \
  $'verbundene MCP-Server: alpha\nmcp__alpha__first\nmcp__alpha__second'
check_pass "matching-tool-hash-passes" inventory_fixture_passes \
  "verbundene MCP-Server: alpha"$'\n'"MCP-Toolnamen SHA256 (sortiert): $("$PYTHON_BIN" "$SCRIPT_DIR/welle0-contract.py" hash --expected "$contract" | sed -E 's/.*\"([0-9a-f]{64})\"/\1/')"

# (a) Same cardinality is irrelevant: a replacement must fail the exact-set gate.
check_fail "tool-replaced-same-count-fails" inventory_fixture_fails \
  $'verbundene MCP-Server: alpha\nmcp__alpha__first\nmcp__alpha__replacement'

# (b) A server mentioned only by a missing warning is not affirmative connection proof.
check_fail "server-only-in-missing-warning-fails" inventory_fixture_fails \
  $'WARNUNG: Soll-MCP fehlt: alpha\nmcp__alpha__first\nmcp__alpha__second'

# (c) A thinking placeholder is still an observed bot action, so silence fails.
check_fail "placeholder-only-expect-silence-fails" "$PYTHON_BIN" -c \
  "import sys; sys.path.insert(0, '$SCRIPT_DIR'); from turn_rules import has_unexpected_silence_activity; raise SystemExit(0 if not has_unexpected_silence_activity('Denke nach …') else 1)"

# (d) TgCrypto-like stderr before the JSON line keeps the LAST parseable JSON result.
json_fixture_parses() {
  [ "$(printf '%s\n' 'TgCrypto is missing! Pyrogram will work, but at a much slower speed.' '{"status":"PASS"}' | welle0_json_field status FAIL)" = "PASS" ]
}
check_pass "stderr-before-json-parses" json_fixture_parses

# The shared rules also prove that a footer/pointer cannot replace actual content.
check_pass "shared-placeholder-footer-rules" "$PYTHON_BIN" -c \
  "import sys; sys.path.insert(0, '$SCRIPT_DIR'); from turn_rules import is_substantive_reply; raise SystemExit(0 if not is_substantive_reply('Denke nach …') and not is_substantive_reply('⏱ ~2 Min') and not is_substantive_reply('👆') and is_substantive_reply('TEXT-TURN-OK') else 1)"

printf 'Summary: PASS=%d FAIL=0\n' "$pass"
