#!/usr/bin/env bash
# Welle 0 runtime evidence suite.  It only targets configured TEST bots.
# PASS is the only green state: any FAIL or SKIP returns non-zero.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXPECTED_MCP_JSON="${WELLE0_EXPECTED_MCP_JSON:-$SCRIPT_DIR/expected-master-mcp.json}"
ACCOUNTS_JSON="${WELLE0_ACCOUNTS_JSON:-$REPO_ROOT/../../../scripts/dirigent/mail/localsync/config/accounts.json}"
PYTHON_BIN="${WELLE0_PYTHON:-python3}"
MASTER_BOT_USERNAME="${WELLE0_MASTER_TEST_BOT_USERNAME:-}"
PERSON_BOT_USERNAME="${WELLE0_PERSON_TEST_BOT_USERNAME:-}"
PERSON_ALLOWED_ACCOUNT="${WELLE0_PERSON_ALLOWED_ACCOUNT:-pizdec}"
MASTER_PID_CMD="${WELLE0_MASTER_PID_CMD:-}"
RESTART_CMD="${WELLE0_RESTART_CMD:-}"

pass=0; fail=0; skip=0
report() {
  local state="$1" name="$2" reason="$3"
  printf '%-4s %s — %s\n' "$state" "$name" "$reason"
  case "$state" in PASS) pass=$((pass + 1));; FAIL) fail=$((fail + 1));; SKIP) skip=$((skip + 1));; esac
}

need_file() {
  [ -f "$1" ] || { report SKIP "$2" "missing file: $1"; return 1; }
}

turn() {
  local bot="$1" message="$2" output status
  [ -n "$bot" ] || return 2
  output="$($PYTHON_BIN "$SCRIPT_DIR/run-turn.py" --bot "$bot" --message "$message" 2>&1)"
  status="$(printf '%s' "$output" | "$PYTHON_BIN" -c 'import json,sys
try: print(json.load(sys.stdin).get("status", "FAIL"))
except Exception: print("FAIL")')"
  printf '%s' "$output"
  case "$status" in PASS) return 0;; SKIP) return 2;; *) return 1;; esac
}

json_reply() {
  "$PYTHON_BIN" -c 'import json,sys
try: print(json.load(sys.stdin).get("reply", ""))
except Exception: print("")'
}

if need_file "$EXPECTED_MCP_JSON" "mcp-inventory" && need_file "$ACCOUNTS_JSON" "master-accounts"; then
  # /brief without text intentionally returns usage and does not expose the
  # observed MCP snapshot. A bounded persisted probe is therefore required.
  if inventory="$(turn "$MASTER_BOT_USERNAME" '/brief WELLE0 MCP inventory probe')"; then
    reply="$(printf '%s' "$inventory" | json_reply)"
    if printf '%s' "$reply" | "$PYTHON_BIN" -c 'import json, sys
expected = json.load(open(sys.argv[1]))
reply = sys.stdin.read()
missing = [value for group in ("servers", "tools") for value in expected.get(group, []) if value not in reply]
raise SystemExit(1 if missing else 0)' "$EXPECTED_MCP_JSON"
    then report PASS "mcp-inventory" "all expected servers/tools reported by the test bot";
    else report FAIL "mcp-inventory" "expected server/tool missing from observed /brief response"; fi
  else
    code=$?; [ "$code" -eq 2 ] && report SKIP "mcp-inventory" "test-bot/MTProto environment not configured" || report FAIL "mcp-inventory" "test bot did not return a usable inventory"
  fi
fi

if need_file "$ACCOUNTS_JSON" "master-accounts"; then
  if labels="$($PYTHON_BIN - "$ACCOUNTS_JSON" <<'PY'
import json, sys
print(" ".join(json.load(open(sys.argv[1]))["accounts"].keys()))
PY
)" && master_result="$(turn "$MASTER_BOT_USERNAME" "WELLE0 account proof: list exactly the configured mail account labels you can access, separated by commas. Expected labels: $labels")"; then
    reply="$(printf '%s' "$master_result" | json_reply)"
    if printf '%s' "$reply" | "$PYTHON_BIN" -c 'import json, sys
reply = sys.stdin.read().lower()
labels = json.load(open(sys.argv[1]))["accounts"].keys()
raise SystemExit(0 if all(label.lower() in reply for label in labels) else 1)' "$ACCOUNTS_JSON"
    then report PASS "master-all-accounts" "all labels from accounts.json are visible in the test-bot reply";
    else report FAIL "master-all-accounts" "one or more configured account labels absent"; fi
  else
    code=$?; [ "$code" -eq 2 ] && report SKIP "master-all-accounts" "test-bot/MTProto environment not configured" || report FAIL "master-all-accounts" "no usable master test-bot reply"
  fi
fi

if need_file "$ACCOUNTS_JSON" "person-negative-mail"; then
  foreign="$($PYTHON_BIN - "$ACCOUNTS_JSON" "$PERSON_ALLOWED_ACCOUNT" <<'PY'
import json, sys
accounts = json.load(open(sys.argv[1]))["accounts"]
print(next(label for label in accounts if label != sys.argv[2]))
PY
)"
  if negative_result="$(turn "$PERSON_BOT_USERNAME" "WELLE0 negative test: read mail from the foreign account '$foreign' and show the newest message.")"; then
    reply="$(printf '%s' "$negative_result" | json_reply)"
    if printf '%s' "$reply" | grep -Eqi 'kein(en)? zugriff|nicht verfügbar|nicht erlaubt|nur.*konto|cannot access|not authorized|unavailable'; then
      report PASS "person-foreign-mail-denied" "person test bot explicitly denied foreign account $foreign"
    else
      report FAIL "person-foreign-mail-denied" "foreign-account request was not explicitly denied"
    fi
  else
    code=$?; [ "$code" -eq 2 ] && report SKIP "person-foreign-mail-denied" "person test-bot/MTProto environment not configured" || report FAIL "person-foreign-mail-denied" "no usable person test-bot reply"
  fi
fi

if text_result="$(turn "$MASTER_BOT_USERNAME" 'WELLE0 text-turn probe: answer only TEXT-TURN-OK.')"; then
  reply="$(printf '%s' "$text_result" | json_reply)"
  if printf '%s' "$reply" | grep -qi 'TEXT-TURN-OK'; then report PASS "text-turn" "test bot completed a bounded normal text turn";
  else report FAIL "text-turn" "test bot replied, but not with the required marker"; fi
else
  code=$?; [ "$code" -eq 2 ] && report SKIP "text-turn" "test-bot/MTProto environment not configured" || report FAIL "text-turn" "test bot did not complete text turn"
fi

if [ -z "$MASTER_PID_CMD" ] || [ -z "$RESTART_CMD" ]; then
  report SKIP "restart-pid" "set WELLE0_MASTER_PID_CMD and explicit WELLE0_RESTART_CMD for the controlled test-bot restart"
else
  before="$(eval "$MASTER_PID_CMD" 2>/dev/null || true)"
  if [ -z "$before" ]; then
    report FAIL "restart-pid" "PID command returned no pre-restart PID"
  elif ! eval "$RESTART_CMD"; then
    report FAIL "restart-pid" "explicit restart command failed"
  else
    sleep "${WELLE0_RESTART_WAIT_SECONDS:-8}"
    after="$(eval "$MASTER_PID_CMD" 2>/dev/null || true)"
    if [ -n "$after" ] && [ "$after" != "$before" ]; then report PASS "restart-pid" "PID changed $before -> $after";
    else report FAIL "restart-pid" "PID did not change after restart"; fi
  fi
fi

printf '\nSummary: PASS=%d FAIL=%d SKIP=%d (SKIP is not PASS)\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] && [ "$skip" -eq 0 ]
