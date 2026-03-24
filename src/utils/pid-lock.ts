import * as fs from 'fs';
import * as path from 'path';

const LOCK_DIR = path.join(process.env.HOME || '/tmp', '.nexusgram', 'locks');

function lockPath(botName: string): string {
  const safe = botName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOCK_DIR, `${safe}.pid`);
}

/**
 * Acquire PID lock. Returns true if lock acquired successfully.
 * Returns false if another instance of this bot is already running.
 */
export function acquireLock(botName: string): boolean {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(botName);

  if (fs.existsSync(file)) {
    try {
      const existingPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (!isNaN(existingPid)) {
        // If the lock is held by our own process, re-acquire silently (supports retry loops)
        if (existingPid === process.pid) {
          return true;
        }
        process.kill(existingPid, 0); // signal 0 = check if alive
        // Process is alive — lock is held by another instance
        console.error(`[PID Lock] Another instance (PID ${existingPid}) holds the lock for "${botName}".`);
        return false;
      }
    } catch {
      // process.kill threw — PID doesn't exist, stale lock
      console.log(`[PID Lock] Removing stale lock for "${botName}".`);
    }
    // Remove stale lock
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }

  // Write our PID
  fs.writeFileSync(file, String(process.pid), 'utf8');
  console.log(`[PID Lock] Acquired lock for "${botName}" (PID ${process.pid}).`);
  return true;
}

/**
 * Release PID lock. Only removes the file if it contains our own PID.
 */
export function releaseLock(botName: string): void {
  const file = lockPath(botName);
  try {
    const storedPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (storedPid === process.pid) {
      fs.unlinkSync(file);
      console.log(`[PID Lock] Released lock for "${botName}".`);
    }
  } catch {
    // File doesn't exist or can't be read — nothing to release
  }
}
