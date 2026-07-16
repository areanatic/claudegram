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
export declare class HardTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly name = "HardTimeoutError";
    constructor(timeoutMs: number, label?: string);
}
export declare function withHardTimeout<T>(op: () => Promise<T>, timeoutMs: number, onTimeout: () => void | Promise<void>, label?: string): Promise<T>;
//# sourceMappingURL=hard-timeout.d.ts.map