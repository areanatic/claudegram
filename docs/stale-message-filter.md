# Stale Message Filter — Design & Decision Log

## Problem

When NexusGram restarts (dev cycle, launchd crash, deploy), Telegram queues all messages
sent while the bot was offline. On restart, grammY delivers them all at once.

Without a filter: the bot processes messages from minutes/hours ago — wrong context,
confusing replies, stale commands.

With too aggressive a filter (30s): messages sent **while Claude is responding** (30–120s)
are dropped silently. User doesn't know why the bot doesn't respond.

**Root cause of the silence bug:** `STALE_THRESHOLD = 30_000ms` but Claude API takes
30–120s → message age exceeds threshold during normal processing → silent drop.

---

## Implemented Solution (2026-03-26)

**Threshold: 180s (3 minutes)**
Covers Claude response time + restart window. Messages sent within 3 minutes before
restart are processed normally.

**Notification on drop:**
When a message IS older than 180s, instead of silent drop, user gets:
> ⚡ Ich war kurz offline. Deine Nachricht von vor ~Xmin habe ich leider verpasst — bitte schick sie nochmal!

**Once per session per restart:**
A `notifiedSessions` Set ensures only ONE notification per chat per bot start,
even if the user sent 10 messages while the bot was down.

**Affected handlers:**
- `message.handler.ts` — text messages
- `voice.handler.ts` — voice notes
- `photo.handler.ts` — photos
- `document.handler.ts` — files/PDFs

---

## Alternative Options (for future consideration)

### Option A — Larger threshold only (no notification)
```typescript
const STALE_THRESHOLD_MS = 300_000; // 5 minutes
```
Pros: Simple, one-line change.
Cons: Silent drop still happens after 5 min. User still doesn't know why bot didn't respond.

### Option B — Flush all updates on startup (skip backlog)
Before starting the runner, call getUpdates once to drain the queue:
```typescript
// Before bot.start() / run(bot):
await bot.api.getUpdates({ timeout: 0, limit: 100 });
```
Pros: Zero stale messages, always starts fresh.
Cons: Loses ALL messages sent during downtime, including important ones. Not suitable
for personal assistant use.

### Option C (Current) — Threshold 180s + notification
Best balance for personal assistant: handles normal restart window, informs user on
longer outages.

### Option D — Deduplicate by update_id, no threshold
Remove stale filter entirely. Track processed update_ids in a persistent store.
Process all messages but deduplicate.
Pros: Never silently drops anything.
Cons: After long outage, processes old context-irrelevant messages. Requires persistent
update_id store across restarts.

### Option E — "I'm back" startup message (complement to C)
On every restart, proactively notify the user:
```typescript
// In index.ts after bot starts:
await bot.api.sendMessage(ARASH_CHAT_ID, '🟢 Ich bin wieder online!');
```
Can be combined with Option C. Currently NOT implemented to avoid noise on frequent
dev restarts. Worth adding once deployment is stable.

---

## Rollback

To revert to original behavior:
```typescript
// stale-filter.ts
const STALE_THRESHOLD_MS = 30_000; // back to 30s
// Remove shouldNotifyStale + getStaleAgeMinutes exports
// Remove notification blocks in all 4 handlers
```

Or: `git revert HEAD` (commit 1e1c4b9 is the last safe state before this change).
