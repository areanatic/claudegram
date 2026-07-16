/**
 * withHardTimeout — Schlachtplan Akt 1.3, Fix B (2026-05-21).
 *
 * A small, local hard-cap for the Voice agent path. The Phase-C RequestContext
 * state machine guards the *text* path; the Voice path hangs directly on
 * `queueRequest(... sendToAgent ...)` with no short cap — which is the exact
 * incident pathway (RI-01 / RI-19). Codex' explicit recommendation: do NOT
 * port the RequestContext machine onto Voice — add a tiny local hard-cap.
 *
 * Contract:
 *  - Runs `op()`. If it settles within `timeoutMs`, its result/rejection is
 *    passed through unchanged.
 *  - If `timeoutMs` elapses first, `onTimeout()` is invoked (e.g. gracefulCancel
 *    to tear the SDK down) and the returned promise rejects with a
 *    `HardTimeoutError`. A late settle of `op()` afterwards is ignored.
 *  - `onTimeout` errors are swallowed — the timeout reject still fires.
 */
export class HardTimeoutError extends Error {
    timeoutMs;
    name = 'HardTimeoutError';
    constructor(timeoutMs, label) {
        super(`Hard timeout after ${Math.round(timeoutMs / 1000)}s${label ? ` (${label})` : ''}`);
        this.timeoutMs = timeoutMs;
    }
}
export async function withHardTimeout(op, timeoutMs, onTimeout, label) {
    let timer = null;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            Promise.resolve()
                .then(() => onTimeout())
                .catch((err) => {
                console.debug('[withHardTimeout] onTimeout threw (ignored):', err);
            });
            reject(new HardTimeoutError(timeoutMs, label));
        }, timeoutMs);
    });
    try {
        return await Promise.race([op(), timeoutPromise]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (timedOut) {
            // op() may still settle later — its result is now meaningless. Nothing
            // to clean up here; the caller already saw the HardTimeoutError reject.
        }
    }
}
//# sourceMappingURL=hard-timeout.js.map