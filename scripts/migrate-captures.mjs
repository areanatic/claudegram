#!/usr/bin/env node
// Migration: 9 link-inbox memories + 12 tiktok-archive folder items → captures table
// Idempotent: skips rows that would violate UNIQUE(chat_id, message_id, bot_id).

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';
const ARCHIVE_DIR = '/Volumes/AstronOne/shared-memory/nexus/tiktok-archive';
const BOT_ID = 'nexusgram'; // matches default config.BOT_NAME → lowercased
const CHAT_ID = '7067348774'; // Arash main chat
const SYNTHETIC_BASE = 9000000; // synthetic message_ids for legacy items (unlikely to clash)

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 1) Bootstrap captures schema if not present (mirrors initCapturesSchema()).
db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    user_id TEXT,
    message_thread_id INTEGER,
    update_id INTEGER,
    media_group_id TEXT,
    capture_type TEXT NOT NULL CHECK(capture_type IN
      ('url','photo','voice','video','video_note','document','audio','sticker','text','forward','animation')),
    platform TEXT,
    source_url TEXT,
    raw_text TEXT,
    raw_meta_json TEXT,
    telegram_file_id TEXT,
    telegram_file_unique_id TEXT,
    mime_type TEXT,
    file_size INTEGER,
    original_filename TEXT,
    file_path TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','processing','processed','failed','skipped')),
    claimed_by TEXT,
    claimed_at TEXT,
    processing_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    retry_after TEXT,
    processed_at TEXT,
    analyzed_at TEXT,
    transcript TEXT,
    summary TEXT,
    category TEXT,
    tags TEXT,
    memory_id INTEGER,
    privacy TEXT NOT NULL DEFAULT 'public'
      CHECK(privacy IN ('public','private')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    UNIQUE(chat_id, message_id, bot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_captures_queue
    ON captures(status, retry_after, created_at)
    WHERE status IN ('queued','failed');
  CREATE INDEX IF NOT EXISTS idx_captures_chat
    ON captures(chat_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_captures_type_plat
    ON captures(capture_type, platform);
  CREATE INDEX IF NOT EXISTS idx_captures_public_processed
    ON captures(status, privacy, analyzed_at)
    WHERE status='processed' AND privacy='public';
`);
console.log('Schema bootstrapped (CREATE IF NOT EXISTS).');

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO captures (
    chat_id, message_id, bot_id, user_id,
    capture_type, platform, source_url,
    raw_text, raw_meta_json,
    file_path, status, transcript, summary, tags, privacy, processed_at, created_at
  ) VALUES (
    @chat_id, @message_id, @bot_id, @user_id,
    @capture_type, @platform, @source_url,
    @raw_text, @raw_meta_json,
    @file_path, @status, @transcript, @summary, @tags, @privacy, @processed_at, @created_at
  )
`);

let migratedFromMemories = 0;
let skippedFromMemories = 0;
let migratedFromArchive = 0;
let skippedFromArchive = 0;

// ───────────────────────────────────────────────────────────────────────────
// Part A — link-inbox rows from `memories`
// ───────────────────────────────────────────────────────────────────────────
const memRows = db
  .prepare(
    `SELECT id, content, tags, project, source, created_at
     FROM memories WHERE source = 'link-inbox' ORDER BY id`,
  )
  .all();

console.log(`Found ${memRows.length} link-inbox memories.`);

for (const row of memRows) {
  const tags = (row.tags || '').toLowerCase();
  // tags pattern: link_inbox,tiktok,finanzen | link_inbox,tiktok,no_transcript | …
  const tagsArr = tags.split(',').map((s) => s.trim()).filter(Boolean);
  const platform =
    tagsArr.find((t) => ['youtube', 'tiktok', 'instagram'].includes(t)) || null;
  const noTranscript = tagsArr.includes('no_transcript');
  const status = noTranscript ? 'queued' : 'processed';

  // Extract source_url from content (regex)
  const urlMatch = row.content.match(/https?:\/\/[^\s)]+/);
  const sourceUrl = urlMatch ? urlMatch[0] : null;

  // Extract transcript section if present
  let transcript = null;
  let summary = null;
  const transMatch = row.content.match(/Transkript:\s*\n([\s\S]+)$/);
  if (transMatch) {
    transcript = transMatch[1].trim();
    summary = transcript.slice(0, 200);
  }

  // Synthetic message_id: 9000000 + memory id → guaranteed unique vs real telegram ids
  const messageId = SYNTHETIC_BASE + row.id;

  const result = insertStmt.run({
    chat_id: CHAT_ID,
    message_id: messageId,
    bot_id: BOT_ID,
    user_id: CHAT_ID,
    capture_type: 'url',
    platform,
    source_url: sourceUrl,
    raw_text: row.content.slice(0, 500),
    raw_meta_json: JSON.stringify({ migrated_from: 'memories', original_id: row.id }),
    file_path: null,
    status,
    transcript,
    summary,
    tags: ['legacy_link_inbox', 'tiktok', platform, noTranscript ? 'no_transcript' : null]
      .filter(Boolean)
      .join(','),
    privacy: 'public',
    processed_at: status === 'processed' ? row.created_at : null,
    created_at: row.created_at,
  });

  if (result.changes > 0) migratedFromMemories++;
  else skippedFromMemories++;
}

console.log(`  → migrated: ${migratedFromMemories}, skipped (duplicate): ${skippedFromMemories}`);

// ───────────────────────────────────────────────────────────────────────────
// Part B — tiktok-archive folder
// ───────────────────────────────────────────────────────────────────────────
const archiveItems = fs
  .readdirSync(ARCHIVE_DIR)
  .filter((f) => fs.statSync(path.join(ARCHIVE_DIR, f)).isDirectory());

console.log(`Found ${archiveItems.length} tiktok-archive folder items.`);

let archiveSyntheticOffset = 100000; // separate range from memory-derived ids
for (const item of archiveItems) {
  const itemDir = path.join(ARCHIVE_DIR, item);
  const metaPath = path.join(itemDir, 'meta.json');
  const transcriptPath = path.join(itemDir, 'transcript.md');

  if (!fs.existsSync(metaPath)) {
    console.warn(`  ⚠️ ${item}: no meta.json, skipping`);
    continue;
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    console.warn(`  ⚠️ ${item}: meta.json parse error: ${err.message}`);
    continue;
  }

  let transcript = null;
  let summary = null;
  if (fs.existsSync(transcriptPath)) {
    const md = fs.readFileSync(transcriptPath, 'utf8');
    const transMatch = md.match(/## Transkript\s*\n([\s\S]+)$/);
    if (transMatch) {
      transcript = transMatch[1].trim();
      summary = transcript.slice(0, 200);
    }
  }

  const status = transcript ? 'processed' : 'queued';
  const messageId = SYNTHETIC_BASE + archiveSyntheticOffset++;

  const result = insertStmt.run({
    chat_id: CHAT_ID,
    message_id: messageId,
    bot_id: BOT_ID,
    user_id: CHAT_ID,
    capture_type: 'url',
    platform: 'tiktok',
    source_url: meta.original_url || meta.resolved_url || null,
    raw_text: `${meta.type === 'photo' ? 'TikTok-Photo' : 'TikTok-Video'} ${meta.id}`,
    raw_meta_json: JSON.stringify({
      migrated_from: 'tiktok-archive-folder',
      legacy_path: itemDir,
      original_meta: meta,
    }),
    file_path: itemDir,
    status,
    transcript,
    summary,
    tags: `legacy_tiktok_2026-05-03,tiktok,${meta.type || 'video'}`,
    privacy: 'public',
    processed_at: status === 'processed' ? meta.archived_at || null : null,
    created_at: meta.archived_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
  });

  if (result.changes > 0) migratedFromArchive++;
  else skippedFromArchive++;
}

console.log(`  → migrated: ${migratedFromArchive}, skipped (duplicate): ${skippedFromArchive}`);

// Final counts
const totalCaptures = db.prepare('SELECT COUNT(*) as n FROM captures').get();
const byStatus = db.prepare('SELECT status, COUNT(*) as n FROM captures GROUP BY status').all();
const byType = db.prepare('SELECT capture_type, COUNT(*) as n FROM captures GROUP BY capture_type').all();

console.log('');
console.log(`=== Migration complete ===`);
console.log(`Total captures:`, totalCaptures.n);
console.log(`By status:`, byStatus);
console.log(`By type:`, byType);

db.close();
