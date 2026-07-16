#!/usr/bin/env node
// Rescue: re-process queued voice captures via Whisper, write transcript into DB.
// Use case: the conversation-agent timed out so the user lost the bot reply,
// but the capture-layer still has the telegram_file_id. We pull it ourselves.

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

const ENV_PATH =
  '/Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram/.env';
const DB_PATH =
  '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';

dotenv.config({ path: ENV_PATH });

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!TG_TOKEN || !GROQ_KEY) {
  console.error('Missing TELEGRAM_BOT_TOKEN or GROQ_API_KEY');
  process.exit(1);
}

const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!ids.length) {
  console.error('Usage: rescue-voice-captures.mjs <id1> <id2> …');
  process.exit(1);
}

const db = new Database(DB_PATH);
const select = db.prepare(
  `SELECT id, telegram_file_id, capture_type, status FROM captures WHERE id = ?`,
);
const update = db.prepare(`
  UPDATE captures
  SET transcript = ?, summary = ?, status = 'processed',
      processed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
      tags = COALESCE(tags, '') || ',rescued'
  WHERE id = ?
`);

async function getTelegramFilePath(fileId) {
  const res = await fetch(
    `https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`,
  );
  const json = await res.json();
  if (!json.ok) throw new Error(`getFile failed: ${json.description}`);
  return json.result.file_path;
}

async function downloadVoice(filePath, dest) {
  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function whisperTranscribe(filePath) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'de');
  form.append('response_format', 'json');

  const res = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    { method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`whisper failed: ${json.error?.message || JSON.stringify(json)}`);
  return (json.text || '').trim();
}

for (const id of ids) {
  const row = select.get(id);
  if (!row) {
    console.log(`#${id}: not found`);
    continue;
  }
  if (!row.telegram_file_id) {
    console.log(`#${id}: no telegram_file_id`);
    continue;
  }
  console.log(`\n=== #${id} (${row.capture_type}, status=${row.status}) ===`);
  try {
    const filePath = await getTelegramFilePath(row.telegram_file_id);
    console.log(`  remote path: ${filePath}`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-'));
    // Telegram voice files come as .oga but Groq Whisper requires .ogg
    const dest = path.join(tmp, `voice.ogg`);
    const size = await downloadVoice(filePath, dest);
    console.log(`  downloaded ${size} bytes`);

    const transcript = await whisperTranscribe(dest);
    console.log(`  transcript (${transcript.length} chars):`);
    console.log(`  ${transcript}`);

    update.run(transcript, transcript.slice(0, 200), id);
    console.log(`  ✅ #${id} marked processed`);

    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }
}

db.close();
