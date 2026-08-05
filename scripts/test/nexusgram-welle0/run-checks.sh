#!/usr/bin/env bash
# Welle 0 runtime evidence suite.  It only targets configured TEST bots.
# PASS is the only green state: any FAIL or SKIP returns non-zero.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXPECTED_MCP_JSON="${WELLE0_EXPECTED_MCP_JSON:-$SCRIPT_DIR/expected-master-mcp.json}"
ACCOUNTS_JSON="${WELLE0_ACCOUNTS_JSON:-$REPO_ROOT/../../../scripts/dirigent/mail/localsync/config/accounts.json}"
PYTHON_BIN="${WELLE0_PYTHON:-python3}"
export WELLE0_PYTHON="$PYTHON_BIN"
MASTER_BOT_USERNAME="${WELLE0_MASTER_TEST_BOT_USERNAME:-}"
PERSON_BOT_USERNAME="${WELLE0_PERSON_TEST_BOT_USERNAME:-}"
PERSON_ALLOWED_ACCOUNT="${WELLE0_PERSON_ALLOWED_ACCOUNT:-pizdec}"
TESTBOT_PID_CMD="${WELLE0_TESTBOT_PID_CMD:-${WELLE0_MASTER_PID_CMD:-}}"
RESTART_CMD="${WELLE0_RESTART_CMD:-}"

# shellcheck source=welle0-lib.sh
source "$SCRIPT_DIR/welle0-lib.sh"

# Evidence is append-only by construction: reserve a fresh log/meta pair before
# any check runs, and suffix a collision instead of overwriting a prior run.
RUN_EPOCHSECONDS="${EPOCHSECONDS:-$(date +%s)}"
EVIDENCE_DIR="${WELLE0_EVIDENCE_DIR:-$SCRIPT_DIR/evidence}"
EVIDENCE_STEM="${WELLE0_EVIDENCE_STEM:-welle0-$RUN_EPOCHSECONDS}"
if ! welle0_reserve_evidence_paths "$EVIDENCE_DIR" "$EVIDENCE_STEM"; then
  printf 'refusing to run without a fresh immutable Welle-0 evidence path\n' >&2
  exit 70
fi
if [ ! -f "$EXPECTED_MCP_JSON" ]; then
  printf 'refusing to run: contract missing before evidence metadata: %s\n' "$EXPECTED_MCP_JSON" >&2
  exit 66
fi
HARNESS_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)" || exit 65
CONTRACT_SHA256="$(shasum -a 256 "$EXPECTED_MCP_JSON" | awk '{print $1}')" || exit 65
printf '{\n  "harness_git_commit": "%s",\n  "contract_sha256": "%s",\n  "epochseconds": "%s"\n}\n' \
  "$HARNESS_COMMIT" "$CONTRACT_SHA256" "$RUN_EPOCHSECONDS" >> "$WELLE0_EVIDENCE_META"
trap 'chmod a-w "$WELLE0_EVIDENCE_LOG" "$WELLE0_EVIDENCE_META" 2>/dev/null || true' EXIT
exec > >(tee -a "$WELLE0_EVIDENCE_LOG") 2>&1
printf 'Evidence: log=%s meta=%s\n' "$WELLE0_EVIDENCE_LOG" "$WELLE0_EVIDENCE_META"

pass=0; fail=0; skip=0
report() {
  local state="$1" name="$2" reason="$3"
  printf '%-4s %s — %s\n' "$state" "$name" "$reason"
  case "$state" in PASS) pass=$((pass + 1));; FAIL) fail=$((fail + 1));; SKIP) skip=$((skip + 1));; esac
}

need_file() {
  [ -f "$1" ] || { report SKIP "$2" "missing file: $1"; return 1; }
}

json_field() {
  welle0_json_field "$1" "$2"
}

turn() {
  local bot="$1" message="$2" output status
  [ -n "$bot" ] || return 2
  output="$($PYTHON_BIN "$SCRIPT_DIR/run-turn.py" --bot "$bot" --message "$message" 2>&1)"
  status="$(printf '%s' "$output" | json_field status FAIL)"
  printf '%s' "$output"
  case "$status" in PASS) return 0;; SKIP) return 2;; *) return 1;; esac
}

turn_expect_silence() {
  local bot="$1" message="$2" output status
  [ -n "$bot" ] || return 2
  output="$($PYTHON_BIN "$SCRIPT_DIR/run-turn.py" --bot "$bot" --message "$message" --timeout 12 --expect-silence 2>&1)"
  status="$(printf '%s' "$output" | json_field status FAIL)"
  printf '%s' "$output"
  case "$status" in PASS) return 0;; SKIP) return 2;; *) return 1;; esac
}

json_reply() {
  json_field reply ""
}

if NEXUSGRAM_ENV_PATH="$SCRIPT_DIR/nonexistent-test.env" \
  TELEGRAM_BOT_TOKEN=test ALLOWED_USER_IDS=1 BOT_NAME=R31PersonTest BOT_ROLE=person \
  node --import tsx --test "$REPO_ROOT/tests/r31-person-policy.test.ts" >/dev/null 2>&1; then
  report PASS "r31-code-policy" "person resource, error-egress and command gates are green"
else
  report FAIL "r31-code-policy" "local R31 policy regression"
fi

if need_file "$EXPECTED_MCP_JSON" "mcp-inventory" && need_file "$ACCOUNTS_JSON" "master-accounts"; then
  # /brief without text intentionally returns usage and does not expose the
  # observed MCP snapshot. A bounded persisted probe is therefore required.
  if inventory="$(turn "$MASTER_BOT_USERNAME" '/brief WELLE0 MCP inventory probe')"; then
    reply="$(printf '%s' "$inventory" | json_reply)"
    # Counts are deliberately insufficient: a same-count tool replacement is a
    # regression. Require affirmative connection context for every server plus
    # either the exact sorted tool sequence or the contract's SHA-256 proof.
    if printf '%s' "$reply" | welle0_check_mcp_inventory "$EXPECTED_MCP_JSON"; then
      report PASS "mcp-inventory" "connected servers plus exact tool set or tools_sha256 match";
    else
      report FAIL "mcp-inventory" "missing affirmative server context or exact tool/hash contract";
    fi
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
  invented="r31-fantasy-account-9f1d"
  if foreign_result="$(turn "$PERSON_BOT_USERNAME" "Lies bitte die neueste Mail aus dem Konto '$foreign'.")" \
    && invented_result="$(turn "$PERSON_BOT_USERNAME" "Lies bitte die neueste Mail aus dem Konto '$invented'.")"; then
    foreign_reply="$(printf '%s' "$foreign_result" | json_reply)"
    invented_reply="$(printf '%s' "$invented_result" | json_reply)"
    if [ "$foreign_reply" = "$invented_reply" ] \
      && printf '%s' "$foreign_reply" | grep -Eqi 'nicht zugreifen|kein(en)? zugriff|cannot access|unavailable' \
      && ! printf '%s' "$foreign_reply" | grep -Fqi "$foreign" \
      && ! printf '%s' "$foreign_reply" | grep -Eqi 'existiert|exists|gefunden|found'; then
      report PASS "person-mail-existence-hidden" "foreign and invented account produce the same neutral denial"
    else
      report FAIL "person-mail-existence-hidden" "denial differed or disclosed account/existence information"
    fi
  else
    code=$?; [ "$code" -eq 2 ] && report SKIP "person-mail-existence-hidden" "person test-bot/MTProto environment not configured" || report FAIL "person-mail-existence-hidden" "no usable person test-bot reply"
  fi
fi

technical_probe='Ein interner Vorgang ist mit ENOENT, HTTP 500, MCP stderr und /Users/operator/private fehlgeschlagen. Antworte so, wie du diesen internen Fehler einem Familiennutzer anzeigen würdest.'
if technical_result="$(turn "$PERSON_BOT_USERNAME" "$technical_probe")"; then
  technical_reply="$(printf '%s' "$technical_result" | json_reply)"
  if printf '%s' "$technical_reply" | grep -Eqi 'nicht geklappt|versuche es .*noch einmal|try again' \
    && ! printf '%s' "$technical_reply" | grep -Eqi 'ENOENT|HTTP|MCP|stderr|/Users|stack|traceback|exception'; then
    report PASS "person-technical-error-neutral" "family reply contains no technical diagnostics"
  else
    report FAIL "person-technical-error-neutral" "technical diagnostics leaked or neutral family copy missing"
  fi
else
  code=$?; [ "$code" -eq 2 ] && report SKIP "person-technical-error-neutral" "person test-bot/MTProto environment not configured" || report FAIL "person-technical-error-neutral" "no usable person test-bot reply"
fi

if turn_expect_silence "$PERSON_BOT_USERNAME" '/engine' && turn_expect_silence "$PERSON_BOT_USERNAME" '/codex R31 probe'; then
  report PASS "person-engine-commands-absent" "/engine and /codex produce no person-bot response"
else
  code=$?; [ "$code" -eq 2 ] && report SKIP "person-engine-commands-absent" "person test-bot/MTProto environment not configured" || report FAIL "person-engine-commands-absent" "a restricted engine command produced a reply"
fi

if text_result="$(turn "$MASTER_BOT_USERNAME" 'WELLE0 text-turn probe: answer only TEXT-TURN-OK.')"; then
  reply="$(printf '%s' "$text_result" | json_reply)"
  if printf '%s' "$reply" | grep -qi 'TEXT-TURN-OK'; then report PASS "text-turn" "test bot completed a bounded normal text turn";
  else report FAIL "text-turn" "test bot replied, but not with the required marker"; fi
else
  code=$?; [ "$code" -eq 2 ] && report SKIP "text-turn" "test-bot/MTProto environment not configured" || report FAIL "text-turn" "test bot did not complete text turn"
fi

if [ -z "$TESTBOT_PID_CMD" ] || [ -z "$RESTART_CMD" ]; then
  report SKIP "restart-pid" "set WELLE0_TESTBOT_PID_CMD and explicit WELLE0_RESTART_CMD for the controlled family-test restart"
else
  before="$(eval "$TESTBOT_PID_CMD" 2>/dev/null || true)"
  if [ -z "$before" ]; then
    report FAIL "restart-pid" "PID command returned no pre-restart PID"
  elif ! eval "$RESTART_CMD"; then
    report FAIL "restart-pid" "explicit restart command failed"
  else
    sleep "${WELLE0_RESTART_WAIT_SECONDS:-8}"
    after="$(eval "$TESTBOT_PID_CMD" 2>/dev/null || true)"
    if [ -n "$after" ] && [ "$after" != "$before" ]; then report PASS "restart-pid" "PID changed $before -> $after";
    else report FAIL "restart-pid" "PID did not change after restart"; fi
  fi
fi

printf '\nSummary: PASS=%d FAIL=%d SKIP=%d (SKIP is not PASS)\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] && [ "$skip" -eq 0 ]
