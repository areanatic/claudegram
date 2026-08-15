#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CTL="$ROOT/scripts/nexusgram-ctl.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/id" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == "-u" ]] || exit 64
printf '501\n'
SH

cat > "$WORK/launchctl" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == "print" && $# -eq 2 ]] || exit 64
printf '%s\n' "$2" >> "${NEXUSGRAM_CTL_CALL_LOG:?}"
case "$2" in
  gui/501/com.nexus.nexusgram)
    cat <<'OUT'
path = /fixture/master.plist
state = running
program = /fixture/node
runs = 7
pid = 42
last exit code = 0
OUT
    ;;
  gui/501/com.nexus.nexusgram-mom)
    printf 'Could not find service "com.nexus.nexusgram-mom" in domain for user gui: 501\n' >&2
    exit 113
    ;;
  gui/501/com.nexus.nexusgram-dev1)
    printf 'Operation not permitted\n' >&2
    exit 1
    ;;
  gui/501/com.nexus.nexusgram-dev2)
    cat <<'OUT'
path = /fixture/dev2.plist
state = running
program = /fixture/node
runs = 3
last exit code = 0
OUT
    ;;
  *)
    cat <<'OUT'
path = /fixture/other.plist
state = not running
program = /fixture/node
runs = 2
last exit code = 78
OUT
    ;;
esac
SH
chmod 700 "$WORK/id" "$WORK/launchctl"

cat > "$WORK/awk-fail" <<'SH'
#!/usr/bin/env bash
exit 42
SH
chmod 700 "$WORK/awk-fail"

: > "$WORK/launchctl.calls"

run_ctl() {
  NEXUSGRAM_CTL_TEST_MODE=1 \
    NEXUSGRAM_LAUNCHCTL_BIN="$WORK/launchctl" \
    NEXUSGRAM_ID_BIN="$WORK/id" \
    NEXUSGRAM_CTL_CALL_LOG="$WORK/launchctl.calls" \
    bash "$CTL" "$@"
}

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$CTL"

set +e
bash -c 'set +e; source "$0" >/dev/null 2>&1; rc=$?; if declare -F create_bot bot_action rebuild >/dev/null; then exit 99; fi; exit "$rc"' "$CTL"
rc=$?
set -e
[[ "$rc" -eq 2 ]] || fail "argv0-spoofed sourcing returned $rc or exposed legacy mutators"

out="$(run_ctl status master)" || fail 'running master status returned nonzero'
grep -q 'RUNNING \[master\].*pid=42.*runs=7.*last_exit=0' <<<"$out" \
  || fail 'running master status was not parsed'

set +e
out="$(run_ctl status mom 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 4 ]] || fail "not-loaded bot returned $rc instead of 4"
grep -q 'NOT_LOADED \[mom\]' <<<"$out" || fail 'not-loaded bot was not distinguished'

set +e
out="$(run_ctl status dev1 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 3 ]] || fail "restricted launchctl returned $rc instead of 3"
grep -q 'UNKNOWN \[dev1\].*rc=1' <<<"$out" || fail 'restricted query was not fail-closed'

set +e
out="$(run_ctl status dev2 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 3 ]] || fail "running bot without pid returned $rc instead of 3"
grep -q 'UNKNOWN \[dev2\].*running without a numeric pid' <<<"$out" \
  || fail 'running bot without pid was misclassified'

set +e
out="$(NEXUSGRAM_CTL_TEST_MODE=1 \
  NEXUSGRAM_LAUNCHCTL_BIN="$WORK/launchctl" \
  NEXUSGRAM_ID_BIN="$WORK/id" \
  NEXUSGRAM_AWK_BIN="$WORK/awk-fail" \
  NEXUSGRAM_CTL_CALL_LOG="$WORK/launchctl.calls" \
  bash "$CTL" status master 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 3 ]] || fail "parser failure returned $rc instead of 3"
grep -q 'UNKNOWN \[master\].*parser failed' <<<"$out" \
  || fail 'parser failure was not reported fail-closed'

: > "$WORK/launchctl.calls"
set +e
out="$(run_ctl list 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 3 ]] || fail "mixed list returned $rc instead of 3"
grep -q 'RUNNING \[master\]' <<<"$out" || fail 'list omitted running master'
grep -q 'NOT_LOADED \[mom\]' <<<"$out" || fail 'list omitted not-loaded bot'
grep -q 'UNKNOWN \[dev1\]' <<<"$out" || fail 'list omitted unknown bot'

cat > "$WORK/expected.calls" <<'EOF'
gui/501/com.nexus.nexusgram
gui/501/com.nexus.nexusgram-family
gui/501/com.nexus.nexusgram-mom
gui/501/com.nexus.nexusgram-dad
gui/501/com.nexus.nexusgram-family-arash
gui/501/com.nexus.nexusgram-family-test
gui/501/com.nexus.nexusgram-test
gui/501/com.nexus.nexusgram-work
gui/501/com.nexus.nexusgram-memo
gui/501/com.nexus.nexusgram-dev1
gui/501/com.nexus.nexusgram-dev2
gui/501/com.nexus.nexusgram-dev3
EOF
diff -u "$WORK/expected.calls" "$WORK/launchctl.calls" \
  || fail 'list did not query exactly the 12 canonical labels in order'

: > "$WORK/launchctl.calls"
set +e
out="$(run_ctl ls 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 64 ]] || fail "undeclared ls alias returned $rc instead of 64"
grep -q "Unknown action 'ls'" <<<"$out" \
  || fail 'undeclared ls alias did not fail loudly'
[[ ! -s "$WORK/launchctl.calls" ]] \
  || fail 'undeclared ls alias invoked launchctl'

for action in create-bot start stop restart logs log rebuild; do
  set +e
  out="$(run_ctl "$action" master 2>&1)"; rc=$?
  set -e
  [[ "$rc" -eq 2 ]] || fail "$action returned $rc instead of 2"
  grep -q "BLOCKED: nexusgram-ctl is read-only; '$action'" <<<"$out" \
    || fail "$action did not fail loudly"
done
[[ ! -s "$WORK/launchctl.calls" ]] \
  || fail 'a blocked lifecycle action invoked launchctl'

set +e
out="$(NEXUSGRAM_CTL_TEST_MODE=1 bash "$CTL" start master 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 2 ]] || fail "blocked start with incomplete test config returned $rc instead of 2"
grep -q "BLOCKED: nexusgram-ctl is read-only; 'start'" <<<"$out" \
  || fail 'blocked start did not precede status-tool initialization'

set +e
out="$(run_ctl status unknown 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 64 ]] || fail "unknown bot returned $rc instead of 64"

set +e
out="$(run_ctl typo 2>&1)"; rc=$?
set -e
[[ "$rc" -eq 64 ]] || fail "unknown action returned $rc instead of 64"

if grep -Eq 'pm2[[:space:]]+(start|stop|restart|jlist|status|logs|describe|save)' <(
  sed -n '/^# ─── Main /,$p' "$CTL"
); then
  fail 'public dispatch still contains a PM2 lifecycle call'
fi

printf 'NEXUSGRAM_CTL_READONLY_PASS\n'
