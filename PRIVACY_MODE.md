# Privacy Mode — Phase 1 (NexusGram)

**Status:** Built, not yet deployed (awaiting Arash's approval + bot restart).
**Concept doc:** `shared-memory/nexus/concept_privacy_mode_2026-04-19.md`
**Branch:** `feat/privacy-mode-phase1`

## What it does

A per-chat toggle that isolates a Telegram conversation from:

1. **Wiki synthesis.** Private turns are written to a separate log file that
   the nightly Ollama synthesizer does not read, so they never become L1
   truth-files.
2. **Memory retrieval.** Memories saved during private mode are tagged
   `privacy='private'` and excluded from default context injection. They
   only reappear when the same chat is back in private mode.
3. **Personal tone.** While private is on, the system prompt gets a
   neutralizing suffix telling the model to drop casual address, family
   names, DHL details, and personal follow-up buttons.

## Commands

| Command           | Effect                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `/private on`     | Enable private mode for this chat (or forum topic).                    |
| `/private off`    | Return to public mode. Prior private turns stay private — no rollback. |
| `/private status` | Show current mode + since-timestamp.                                   |
| `/private`        | Same as `/private status`.                                             |

Scope: the toggle keys on `sessionKey` (`chatId` or `chatId:threadId`), so
every chat / forum topic has its own independent state.

## Files changed

| Path                                                               | Why                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `src/memory/privacy-state.ts` (new)                                | File-backed JSON state + `isPrivate()` helper.                   |
| `src/memory/nexus-memory.ts`                                       | `saveMemory` / `searchMemory` / `recentMemories` / `injectContext` become privacy-aware. Privacy column detected at runtime so pre-migration DBs still work. |
| `src/memory/conversation-logger.ts`                                | Private turns go to `YYYY-MM-DD_{bot}.private.log` with a `[PRIVACY=PRIVATE]` marker. |
| `src/claude/agent.ts`                                              | Reads `isPrivate(sessionKey)` before injecting memory + before tagging PreCompact saves + before logging conversation. Appends `PRIVACY_MODE_PROMPT` when private. |
| `src/bot/handlers/command.handler.ts`                              | New `handlePrivate` handler.                                     |
| `src/bot/bot.ts`                                                   | Registers `bot.command('private', handlePrivate)`.               |
| `scripts/migrations/2026-04-19_privacy_column.sql`                 | SQL migration (ALTER TABLE + index + metadata bump).             |

## Database migration

**Do NOT run this against the live DB until Arash approves.**

```bash
# 1. Snapshot (maintenance.sh already does this nightly, but belt-and-braces)
cp /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db \
   /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/backups/memory-$(date +%F)-pre-privacy.db

# 2. Apply migration
sqlite3 /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db \
  < /Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram/scripts/migrations/2026-04-19_privacy_column.sql

# 3. Verify
sqlite3 /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db \
  "PRAGMA table_info(memories);"
# → expect a 'privacy' row with TEXT + DEFAULT 'public'

sqlite3 /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db \
  "SELECT key, value FROM metadata WHERE key IN ('schema_version','privacy_column_added_at');"
```

The code tolerates a pre-migration DB: `hasPrivacyColumn()` short-circuits
the INSERT / WHERE fragments so the bot keeps working; only the privacy
persistence + retrieval filter become no-ops until the migration is run.

## How to test (before deploy)

Recommended: local test DB copy + manual bot run against a test Telegram chat.

```bash
# 1. Fresh copy of the DB so we never touch production
cp /Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db /tmp/memory-test.db
sqlite3 /tmp/memory-test.db \
  < /Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram/scripts/migrations/2026-04-19_privacy_column.sql

# 2. Point the bot at the test DB (temporary) — set NEXUS_MEMORY_DB env, then npm run build && node dist/index.js
```

Manual acceptance walk-through:

1. `/private status` → shows OFF.
2. `/private on` → shows ON + timestamp.
3. Say a message containing a fake sensitive keyword. Check the log:
   - a file `logs/conversations/YYYY-MM-DD_{bot}.private.log` exists.
   - the regular `.log` file does NOT contain that turn.
4. `/private off` → shows OFF again, preserves the note that prior private
   turns remain private.
5. Run the synthesizer manually; confirm only `*.log` (not `*.private.log`)
   is piped into Ollama.
6. Query memory: while public mode is active, private-tagged rows must not
   appear in `injectContext` output.

## Out of scope (explicitly deferred)

- **Auto-classification** of private content via keyword heuristics
  (Concept doc Phase 2).
- **Mode system** (`/mode clean`, `no-dhl`, etc.) — Phase 2b.
- **Channel automation** (E-Mail routing per mode) — Phase 2c.
- **CV-export gate** — Phase 3.
- **Retroactive audit** of existing memories — separate script planned
  (`nexus-privacy-audit.sh`), not included here.

## Deployment checklist

- [ ] Arash reviews the diff on `feat/privacy-mode-phase1`.
- [ ] Apply SQL migration to `memory.db` (see above).
- [ ] Rebuild TypeScript: `npm run build`.
- [ ] Restart the four NexusGram bots (Master / Family / Mom / Dad).
- [ ] Smoke-test with `/private status` on each bot.
- [ ] Monitor first nightly `maintenance.sh` run to confirm `.private.log`
      files are untouched.

**No restart has been performed. Ready to deploy — Arash must approve.**

## Anthropic Compliance note

This is a privacy-enhancing feature; no human-in-the-loop decision is being
bypassed. The `/private on/off` command is initiated exclusively by the
human user via Telegram; the bot never flips the mode autonomously. No
changes to Anthropic-AUP-relevant surfaces (training data, scraping,
legal/financial autonomy) are introduced.
