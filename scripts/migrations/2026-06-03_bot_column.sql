-- Migration: per-bot origin `bot` column on memories table
-- Date: 2026-06-03
-- Feature: Cross-Bot T2 (a) — per-bot origin (WAVE-2)
-- Scope:   shared-memory/nexus/wave2_crossbot_t2_scope_2026-06-03.md
-- Dry-run: shared-memory/nexus/wave2_crossbot_t2_migration_dryrun_2026-06-03.md (GO,
--          invariants byte-identical before/after on a /tmp copy; 2000 rows, 1509 private,
--          public-scope 491, self_private 1812, leak-check 0 — all UNCHANGED by this column)
--
-- WARNING: Do NOT apply to the live database until Arash approves.
-- Apply against a local copy first:
--   cp .nexus-memory/memory.db /tmp/memory-test.db
--   sqlite3 /tmp/memory-test.db < scripts/migrations/2026-06-03_bot_column.sql
--   sqlite3 /tmp/memory-test.db 'PRAGMA table_info(memories);'
--
-- Live apply sequence (after approval):
--   1. cp .nexus-memory/memory.db .nexus-memory/backups/memory-pre-bot-$(date +%Y%m%d-%H%M%S).db
--   2. sqlite3 .nexus-memory/memory.db "PRAGMA wal_checkpoint(TRUNCATE);"
--   3. sqlite3 .nexus-memory/memory.db < scripts/migrations/2026-06-03_bot_column.sql
--   4. sqlite3 .nexus-memory/memory.db "PRAGMA table_info(memories);"  -- confirm `bot` present
--
-- Rollback:
--   SQLite >= 3.35 supports DROP COLUMN, BUT it FAILS while idx_memories_bot exists
--   (dry-run Surprise A) — drop the index FIRST, then the column. Preferred rollback is
--   restore-from-backup (step 1 above). The column is additive + nullable, so forward
--   compatibility needs no rollback unless a bug appears.
--     DROP INDEX IF EXISTS idx_memories_bot;
--     ALTER TABLE memories DROP COLUMN bot;   -- only if restore-from-backup is undesirable
--
-- The `bot` column is METADATA ONLY. It does NOT participate in buildPrivacyClause()
-- (privacy stays driven by the `privacy` + `source` columns). Adding it cannot widen or
-- narrow which private rows are visible — proven byte-identical in the dry-run.

BEGIN TRANSACTION;

-- 1. Additive, nullable origin column. NULL = legacy / unknown bot (no backfill in v0).
ALTER TABLE memories ADD COLUMN bot TEXT;

-- 2. Index for per-bot filtering / "saved by <bot>" lookups.
CREATE INDEX IF NOT EXISTS idx_memories_bot ON memories(bot);

-- 3. Bump schema_version so operators can see the migration has been applied.
INSERT INTO metadata (key, value)
VALUES ('schema_version', '2.3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

COMMIT;
