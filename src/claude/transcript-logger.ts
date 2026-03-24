import * as fs from 'fs';
import * as path from 'path';
import { sessionManager } from './session-manager.js';
import { config } from '../config.js';

const TRANSCRIPT_DIR = path.join(config.DATA_DIR, 'transcripts');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function timestampStr(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function transcriptPath(userId: string): string {
  const dir = path.join(TRANSCRIPT_DIR, todayStr());
  ensureDir(dir);
  return path.join(dir, `${userId}.md`);
}

/**
 * Record a single message (user or assistant) to the daily transcript file.
 * Appends to <DATA_DIR>/transcripts/YYYY-MM-DD/<userId>.md
 */
export function recordTranscript(
  sessionKey: string,
  role: 'user' | 'assistant',
  content: string
): void {
  try {
    const session = sessionManager.getSession(sessionKey);
    const convId = session?.conversationId ?? 'unknown';
    const project = session?.workingDirectory ? path.basename(session.workingDirectory) : '';
    const filePath = transcriptPath(sessionKey);

    let line: string;
    if (role === 'user') {
      // Session header only on first user message per conversation block
      const header = `\n## ${timestampStr()} | ${convId} | ${project}\n`;
      line = `${header}**User:** ${content}\n`;
    } else {
      line = `**Claude:** ${content}\n\n---\n`;
    }

    fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Transcript logging must never crash the bot
  }
}
