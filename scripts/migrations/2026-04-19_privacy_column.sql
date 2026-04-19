-- Migration: privacy column on memories table
-- Date: 2026-04-19
-- Feature: Privacy Mode Phase 1 (NexusGram)
-- Concept: shared-memory/nexus/concept_privacy_mode_2026-04-19.md
--
-- WARNING: Do NOT apply to the live database until Arash approves.
-- Apply against a local copy first:
--   cp .nexus-memory/memory.db /tmp/memory-test.db
--   sqlite3 /tmp/memory-test.db < .nexus-memory/migrations/2026-04-19_privacy_column.sql
--   sqlite3 /tmp/memory-test.db 'PRAGMA table_info(memories);'
--
-- Rollback:
--   SQLite does not support DROP COLUMN before 3.35. If rollback is needed,
--   restore from .nexus-memory/backups/memory-YYYY-MM-DD.db (maintenance.sh
--   creates a daily backup).

BEGIN TRANSACTION;

-- 1. Add privacy column with CHECK constraint + default 'public'.
--    Existing rows become 'public' automatically (backwards compatible).
--    'needs_review' is reserved for the Phase-2 auto-classification pass.
ALTER TABLE memories
  ADD COLUMN privacy TEXT
  CHECK (privacy IN ('public', 'private', 'needs_review'))
  DEFAULT 'public';

-- 2. Backfill any NULL values to 'public' (belt-and-braces; the DEFAULT
--    should already handle this for new and existing rows).
UPDATE memories
SET privacy = 'public'
WHERE privacy IS NULL;

-- 3. Index for the retrieval filter (common query:
--    WHERE privacy = 'public' AND archived = 0 ORDER BY last_accessed DESC).
CREATE INDEX IF NOT EXISTS idx_memories_privacy ON memories(privacy);

-- 4. Bump the schema_version metadata entry so operators can see the migration
--    has been applied on this DB.
INSERT INTO metadata (key, value)
VALUES ('schema_version', '2.2')
ON CONFLICT(key) DO UPDATE SET
  value = '2.2',
  updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime');

INSERT INTO metadata (key, value)
VALUES ('privacy_column_added_at', strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
ON CONFLICT(key) DO UPDATE SET
  value = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
  updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime');

COMMIT;

-- Note on FTS5:
--   The memories_fts virtual table only mirrors (content, tags, project). We
--   deliberately do NOT mirror `privacy` into FTS5 because the privacy filter
--   is applied after the FTS5 JOIN in nexus-memory.ts — that is cheaper than
--   rebuilding the FTS index and keeps this migration additive-only.
