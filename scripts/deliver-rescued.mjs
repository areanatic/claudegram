#!/usr/bin/env node
// Deliver: send already-rescued capture transcripts back to the user via Telegram.
// Use case: bot timed out so the user never got the bot's reply.
// We send the transcript so the conversation history is at least preserved.

import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config({ path: '/Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram/.env' });
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const db = new Database('/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db');
const ids = process.argv.slice(2).map(Number).filter(Boolean);

const select = db.prepare('SELECT * FROM captures WHERE id = ?');

async function send(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`sendMessage failed: ${json.description}`);
  return json.result.message_id;
}

for (const id of ids) {
  const cap = select.get(id);
  if (!cap) { console.log(`#${id}: not found`); continue; }
  if (!cap.transcript) { console.log(`#${id}: no transcript yet`); continue; }
  const ts = cap.created_at.replace('T', ' ').slice(0, 16);
  const head = `📥 Nachgeholt aus Capture #${cap.id} — ${cap.capture_type} vom ${ts}\n(Bot hatte Watchdog-Timeout, OAuth war abgelaufen.)\n\n`;
  const text = head + cap.transcript;
  try {
    const mid = await send(cap.chat_id, text);
    console.log(`#${id}: sent as message_id ${mid} (${cap.transcript.length} chars)`);
  } catch (err) {
    console.log(`#${id}: ${err.message}`);
  }
}

db.close();
