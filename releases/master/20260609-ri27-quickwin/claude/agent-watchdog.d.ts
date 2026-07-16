/**
 * Agent watchdog that monitors the SDK message loop for unresponsive behavior.
 * Logs warnings when no messages are received for extended periods.
 */
export interface WatchdogOptions {
    chatId: string;
    warnAfterSeconds: number;
    logIntervalSeconds: number;
    timeoutMs?: number;
    onWarning?: (sinceLastMessageMs: number, totalElapsedMs: number) => void;
    onTimeout?: () => void;
}
export declare class AgentWatchdog {
    private chatId;
    private warnAfterMs;
    private logIntervalMs;
    private timeoutMs;
    private onWarning?;
    private onTimeout?;
    private startTime;
    private lastActivityTime;
    private intervalId;
    private hasWarned;
    private stopped;
    private activeTools;
    private fallbackToolCounter;
    constructor(options: WatchdogOptions);
    /**
     * Start the watchdog timer.
     */
    start(): void;
    /**
     * Record activity (message received from SDK).
     */
    recordActivity(_messageType?: string): void;
    /**
     * Record start of a tool invocation. Refreshes activity AND tracks the tool
     * so check() can extend the warning window while it is running.
     *
     * @param toolUseId — SDK-provided ID if available, '' to synthesize one
     * @param toolName  — for logging only; not used to match end-events (tool_use_summary has no name)
     */
    recordToolStart(toolUseId: string, toolName: string): void;
    /**
     * Tool-progress event (heartbeat). Refreshes activity without changing the
     * active-tools map. Safe to call even when no tool is recorded.
     */
    recordToolProgress(): void;
    /**
     * End of a tool invocation. If a specific id matches, remove just that one;
     * otherwise drop the oldest entry (best-effort), and always refresh activity.
     * tool_use_summary may not carry the original tool_use_id reliably — that is
     * why this is a best-effort drop, not an assertion.
     */
    recordToolEnd(toolUseId?: string): void;
    /**
     * Hard-clear all active tools — call on error_during_execution / Interrupt /
     * Permission-denial / any event that may end the run without per-tool summaries.
     */
    clearActiveTools(reason: string): void;
    /**
     * Check if watchdog should fire warnings or timeout.
     * V2.4-7: while tools are active, the warn threshold is relaxed (×4) but
     * the hard timeout (timeoutMs) is ALWAYS respected — tools cannot suppress
     * it indefinitely.
     */
    private check;
    /**
     * Stop the watchdog timer.
     */
    stop(): void;
    /**
     * Get total elapsed time since start.
     */
    getElapsedMs(): number;
}
//# sourceMappingURL=agent-watchdog.d.ts.map