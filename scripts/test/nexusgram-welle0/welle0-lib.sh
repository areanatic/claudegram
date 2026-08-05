#!/usr/bin/env bash
# Sourceable helpers for Welle-0 checks and their fixture-only self-test.

WELLE0_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WELLE0_CONTRACT_PY="$WELLE0_LIB_DIR/welle0-contract.py"

welle0_json_field() {
  "${WELLE0_PYTHON:-python3}" "$WELLE0_CONTRACT_PY" json-field "$1" "$2"
}

welle0_check_mcp_inventory() {
  local expected_contract="$1"
  "${WELLE0_PYTHON:-python3}" "$WELLE0_CONTRACT_PY" check-inventory --expected "$expected_contract"
}

welle0_reserve_evidence_paths() {
  local evidence_dir="$1" base_name="$2" counter=0 candidate suffix
  mkdir -p "$evidence_dir" || return 1

  while :; do
    suffix=""
    [ "$counter" -eq 0 ] || suffix="-$counter"
    candidate="$evidence_dir/$base_name$suffix"
    if [ -e "$candidate.log" ] || [ -e "$candidate.meta.json" ]; then
      counter=$((counter + 1))
      continue
    fi
    if (set -o noclobber; : > "$candidate.log") \
      && (set -o noclobber; : > "$candidate.meta.json"); then
      WELLE0_EVIDENCE_LOG="$candidate.log"
      WELLE0_EVIDENCE_META="$candidate.meta.json"
      export WELLE0_EVIDENCE_LOG WELLE0_EVIDENCE_META
      return 0
    fi
    # A concurrent run may have reserved one path between -e and creation.
    # Leave that incomplete pair untouched and choose a new immutable suffix.
    counter=$((counter + 1))
  done
}
