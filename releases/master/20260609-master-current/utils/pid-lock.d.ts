/**
 * Acquire PID lock. Returns true if lock acquired successfully.
 * Returns false if another live instance of this bot is already running.
 *
 * The lock file is created atomically via openSync(..., 'wx'), so two
 * processes starting at the same instant cannot both win the lock — the
 * previous existsSync()-then-writeFileSync() sequence had a check-then-write
 * race where both would see "no file" and both proceed.
 */
export declare function acquireLock(botName: string): boolean;
/**
 * Release PID lock. Only removes the file if it contains our own PID.
 */
export declare function releaseLock(botName: string): void;
//# sourceMappingURL=pid-lock.d.ts.map