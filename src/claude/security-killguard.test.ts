/**
 * REGRESSION — the self-management security guard must block PROCESS-management
 * (kill <pid>, launchctl, pkill…) but ALLOW shell JOB-control (kill %1, kill $!).
 *
 * Run: npx tsx src/claude/security-killguard.test.ts
 *
 * Bug (live, dev1.err.log:10, OMI-conversation): the bare `kill` alternative in
 *   /\b(launchctl|kickstart|bootout|killall|pkill|kill|shutdown|reboot|halt)\b/i
 * matches `kill %1` — but `kill %1` is shell job-control (terminate the bot's OWN
 * backgrounded job), NOT killing the bot service. A harmless `ssh … & sleep 3; kill %1`
 * connectivity test got denied, and the bot then burned its whole tool budget retrying
 * variants → contributed to the "16/15 budget exceeded" in the same turn.
 *
 * The fix keeps every real process-mgmt verb blocked and only narrows `kill`:
 *   - kill <pid> / kill -9 <pid> / kill $(pgrep …)  → DENY (process mgmt)
 *   - kill %1 / kill %+ / kill -TERM $! / kill $!     → ALLOW (job control)
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function expect(cmd: string, shouldBlock: boolean, why: string, blocker: (c: string) => boolean) {
  const blocked = blocker(cmd);
  const ok = blocked === shouldBlock;
  if (ok) { pass++; console.log(`  ✅ ${shouldBlock ? 'DENY ' : 'ALLOW'} ${JSON.stringify(cmd).padEnd(42)} (${why})`); }
  else { fail++; console.error(`  ❌ ${JSON.stringify(cmd)} → blocked=${blocked}, expected ${shouldBlock} (${why})`); }
}

// ---- OLD guard (the bug) — bare `kill` in the alternation ----
const OLD = /\b(launchctl|kickstart|bootout|killall|pkill|kill|shutdown|reboot|halt)\b/i;
const oldBlocks = (c: string) => OLD.test(c);

// ---- NEW guard (the fix, Codex M-11 P1 hardened) — process verbs + FULL kill-target check ----
const SELF_MGMT = /\b(launchctl|kickstart|bootout|killall|pkill|shutdown|reboot|halt)\b/i;
// `kill` is allowed ONLY when EVERY target is shell job-control (%N/%+/%-/%str) or $!.
// We extract each `kill …` invocation (up to the next ; | & or newline) and inspect ALL its
// args: any bare PID, $(...), `…`, or $VAR target → process mgmt → DENY. Mixed lists like
// `kill %1 123` are denied (123 is a PID). Leading -SIGNAL flags (-9, -s TERM, --) are skipped.
function killIsProcessMgmt(cmd: string): boolean {
  // find every kill invocation segment
  const re = /\bkill\b([^;|&\n]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const args = m[1].trim();
    // tokenise args; drop signal flags (-9, -TERM, -s TERM, --)
    const toks = args.length ? args.split(/\s+/) : [];
    const targets: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '--') continue;
      if (/^-[A-Za-z0-9]+$/.test(t)) {
        // -s / -n take a following signal-name/number argument
        if ((t === '-s' || t === '-n') && i + 1 < toks.length) i++;
        continue;
      }
      targets.push(t);
    }
    if (targets.length === 0) return true; // bare `kill` → conservative DENY
    // allowed target = job-spec (%…) or last-bg-pid ($!). Anything else (PID, $(...), `…`, $VAR) → DENY.
    // Strip surrounding shell quotes/parens that cling to a token when kill sits inside a quoted
    // string (e.g. ssh host "… ; kill %1") so `%1"` is still recognised as the job-spec %1.
    const clean = (t: string) => t.replace(/^["'`()]+/, '').replace(/["'`()]+$/, '');
    const allJobControl = targets.every((t) => {
      const c = clean(t);
      return /^%[0-9+\-A-Za-z]*$/.test(c) || c === '$!';
    });
    if (!allJobControl) return true;
  }
  return false;
}
const newBlocks = (c: string) => SELF_MGMT.test(c) || killIsProcessMgmt(c);

console.log('\n=== OLD guard: demonstrate the bug (kill %1 wrongly blocked) ===');
expect('ssh host "… & sleep 3; kill %1"', true, 'OLD wrongly blocks job-control', oldBlocks);

console.log('\n=== NEW guard: job-control ALLOWED ===');
expect('kill %1', false, 'job-control: terminate bg job 1', newBlocks);
expect('kill %2', false, 'job-control', newBlocks);
expect('kill %+', false, 'job-control: current job', newBlocks);
expect('kill -TERM $!', false, 'job-control: last bg pid with signal', newBlocks);
expect('kill $!', false, 'job-control: last bg pid', newBlocks);
expect('ssh h "ping x & sleep 3; kill %1"', false, 'the exact live-blocked command', newBlocks);
expect('kill -9 %1', false, 'job-control with signal', newBlocks);

console.log('\n=== Codex M-11 P2: more legit job-control forms ALLOWED ===');
expect('kill -s TERM %1', false, '-s SIGNAL job-spec', newBlocks);
expect('kill -- %1', false, '-- then job-spec', newBlocks);
expect('kill -n 9 %2', false, '-n SIGNUM job-spec', newBlocks);

console.log('\n=== Codex M-11 P1: mixed-target BYPASS must be DENIED ===');
expect('kill %1 123', true, 'mixed: job-spec + PID → must DENY (the bypass)', newBlocks);
expect('kill -9 %1 123', true, 'mixed with signal + PID', newBlocks);
expect('kill $! 123', true, 'mixed: $! + PID', newBlocks);
expect('kill %1 $(pgrep -f nexusgram)', true, 'mixed: job-spec + cmd-subst', newBlocks);

console.log('\n=== NEW guard: real process-management still DENIED ===');
expect('kill 51366', true, 'kill a PID', newBlocks);
expect('kill -9 51366', true, 'kill a PID with signal', newBlocks);
expect('kill $(pgrep -f nexusgram)', true, 'kill by pgrep — process mgmt', newBlocks);
expect('kill $BOT_PID', true, 'kill a $VAR PID — process mgmt', newBlocks);
expect('kill `pgrep node`', true, 'kill backtick subst', newBlocks);
expect('launchctl kickstart com.nexus.nexusgram', true, 'the original self-restart vector', newBlocks);
expect('pkill -f nexusgram', true, 'pkill', newBlocks);
expect('killall node', true, 'killall', newBlocks);
expect('bootout gui/501/com.nexus.nexusgram', true, 'bootout', newBlocks);
expect('shutdown -h now', true, 'shutdown', newBlocks);
expect('sudo reboot', true, 'reboot', newBlocks);

console.log('\n=== NEW guard: bare kill (no target) stays blocked (conservative) ===');
expect('kill', true, 'bare kill — no job-spec → treat as process mgmt', newBlocks);

console.log('\n=== false-positive checks (must NOT block harmless words) ===');
expect('echo killing time', false, 'word "killing" ≠ kill', newBlocks);
expect('skill issue test', false, 'skill ≠ kill', newBlocks);
expect('git log --oneline', false, 'unrelated', newBlocks);

console.log(`\n${fail === 0 ? '✅' : '❌'} security kill-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
