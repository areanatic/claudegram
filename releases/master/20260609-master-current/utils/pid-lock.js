import * as fs from 'fs';
import * as path from 'path';
const LOCK_DIR = path.join(process.env.HOME || '/tmp', '.nexusgram', 'locks');
function lockPath(botName) {
    const safe = botName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(LOCK_DIR, `${safe}.pid`);
}
/**
 * Check whether a process with the given PID is currently alive.
 * signal 0 sends nothing — it only probes existence. EPERM means the
 * process exists but is owned by another user (still alive).
 */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
/**
 * Acquire PID lock. Returns true if lock acquired successfully.
 * Returns false if another live instance of this bot is already running.
 *
 * The lock file is created atomically via openSync(..., 'wx'), so two
 * processes starting at the same instant cannot both win the lock — the
 * previous existsSync()-then-writeFileSync() sequence had a check-then-write
 * race where both would see "no file" and both proceed.
 */
export function acquireLock(botName) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const file = lockPath(botName);
    // Two attempts: the second covers the case where we removed a stale lock
    // and need to re-run the atomic create.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // 'wx' = create + exclusive: fails atomically with EEXIST if the file exists.
            const fd = fs.openSync(file, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            console.log(`[PID Lock] Acquired lock for "${botName}" (PID ${process.pid}).`);
            return true;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            // Lock file already exists — inspect the holder.
            let existingPid = NaN;
            try {
                existingPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
            }
            catch { /* unreadable — treat as stale below */ }
            // Our own lock (supports in-process re-entry) — accept it.
            if (existingPid === process.pid) {
                return true;
            }
            // Held by another LIVE process — refuse.
            if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
                console.error(`[PID Lock] Another instance (PID ${existingPid}) holds the lock for "${botName}".`);
                return false;
            }
            // Stale lock (holder dead, or file unreadable) — remove and retry once.
            console.log(`[PID Lock] Removing stale lock for "${botName}" (PID ${isNaN(existingPid) ? 'unreadable' : existingPid}).`);
            try {
                fs.unlinkSync(file);
            }
            catch { /* ignore — another process may have cleaned it */ }
        }
    }
    console.error(`[PID Lock] Could not acquire lock for "${botName}" after stale-lock cleanup (lost a startup race).`);
    return false;
}
/**
 * Release PID lock. Only removes the file if it contains our own PID.
 */
export function releaseLock(botName) {
    const file = lockPath(botName);
    try {
        const storedPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        if (storedPid === process.pid) {
            fs.unlinkSync(file);
            console.log(`[PID Lock] Released lock for "${botName}".`);
        }
    }
    catch {
        // File doesn't exist or can't be read — nothing to release
    }
}
//# sourceMappingURL=pid-lock.js.map