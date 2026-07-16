/**
 * Agent watchdog that monitors the SDK message loop for unresponsive behavior.
 * Logs warnings when no messages are received for extended periods.
 */
import { formatDuration } from '../utils/agent-timer.js';
export class AgentWatchdog {
    chatId;
    warnAfterMs;
    logIntervalMs;
    timeoutMs;
    onWarning;
    onTimeout;
    startTime = 0;
    lastActivityTime = 0;
    intervalId = null;
    hasWarned = false;
    stopped = false;
    // V2.4-7 tool-aware state. Keyed by tool_use_id when available,
    // falls back to a synthetic counter otherwise. Multiple parallel tools supported.
    activeTools = new Map();
    fallbackToolCounter = 0;
    constructor(options) {
        this.chatId = options.chatId;
        this.warnAfterMs = options.warnAfterSeconds * 1000;
        this.logIntervalMs = options.logIntervalSeconds * 1000;
        this.timeoutMs = options.timeoutMs || 0;
        this.onWarning = options.onWarning;
        this.onTimeout = options.onTimeout;
    }
    /**
     * Start the watchdog timer.
     */
    start() {
        this.startTime = Date.now();
        this.lastActivityTime = this.startTime;
        this.hasWarned = false;
        this.stopped = false;
        this.intervalId = setInterval(() => {
            if (this.stopped)
                return;
            this.check();
        }, this.logIntervalMs);
    }
    /**
     * Record activity (message received from SDK).
     */
    recordActivity(_messageType) {
        this.lastActivityTime = Date.now();
        this.hasWarned = false; // Reset warning state on activity
    }
    /**
     * Record start of a tool invocation. Refreshes activity AND tracks the tool
     * so check() can extend the warning window while it is running.
     *
     * @param toolUseId — SDK-provided ID if available, '' to synthesize one
     * @param toolName  — for logging only; not used to match end-events (tool_use_summary has no name)
     */
    recordToolStart(toolUseId, toolName) {
        const id = toolUseId || `__synthetic-${++this.fallbackToolCounter}`;
        this.activeTools.set(id, { name: toolName, startTime: Date.now() });
        this.lastActivityTime = Date.now();
        this.hasWarned = false;
    }
    /**
     * Tool-progress event (heartbeat). Refreshes activity without changing the
     * active-tools map. Safe to call even when no tool is recorded.
     */
    recordToolProgress() {
        this.lastActivityTime = Date.now();
        this.hasWarned = false;
    }
    /**
     * End of a tool invocation. If a specific id matches, remove just that one;
     * otherwise drop the oldest entry (best-effort), and always refresh activity.
     * tool_use_summary may not carry the original tool_use_id reliably — that is
     * why this is a best-effort drop, not an assertion.
     */
    recordToolEnd(toolUseId) {
        if (toolUseId && this.activeTools.has(toolUseId)) {
            this.activeTools.delete(toolUseId);
        }
        else if (this.activeTools.size > 0) {
            // Drop oldest entry
            const oldestKey = [...this.activeTools.entries()]
                .sort((a, b) => a[1].startTime - b[1].startTime)[0][0];
            this.activeTools.delete(oldestKey);
        }
        this.lastActivityTime = Date.now();
        this.hasWarned = false;
    }
    /**
     * Hard-clear all active tools — call on error_during_execution / Interrupt /
     * Permission-denial / any event that may end the run without per-tool summaries.
     */
    clearActiveTools(reason) {
        if (this.activeTools.size > 0) {
            console.log(`[Claude] WATCHDOG: clearActiveTools(${reason}) — dropping ${this.activeTools.size} active tool(s), chat:${this.chatId}`);
        }
        this.activeTools.clear();
        this.lastActivityTime = Date.now();
        this.hasWarned = false;
    }
    /**
     * Check if watchdog should fire warnings or timeout.
     * V2.4-7: while tools are active, the warn threshold is relaxed (×4) but
     * the hard timeout (timeoutMs) is ALWAYS respected — tools cannot suppress
     * it indefinitely.
     */
    check() {
        const now = Date.now();
        const sinceLastActivity = now - this.lastActivityTime;
        const totalElapsed = now - this.startTime;
        const toolsActive = this.activeTools.size > 0;
        const effectiveWarnMs = toolsActive ? this.warnAfterMs * 4 : this.warnAfterMs;
        // Hard timeout — never suppressed, even with active tools
        if (this.timeoutMs > 0 && totalElapsed >= this.timeoutMs) {
            console.log(`[Claude] WATCHDOG TIMEOUT: No response after ${formatDuration(totalElapsed)}, chat:${this.chatId}${toolsActive ? ` (${this.activeTools.size} tool(s) still active)` : ''}`);
            this.onTimeout?.();
            this.stop();
            return;
        }
        // Warning threshold (relaxed while tools run)
        if (sinceLastActivity >= effectiveWarnMs) {
            if (!this.hasWarned) {
                this.hasWarned = true;
                const toolsNote = toolsActive ? ` [tools-active: ${[...this.activeTools.values()].map(t => t.name).join(',')}]` : '';
                console.log(`[Claude] WATCHDOG WARNING: No messages for ${formatDuration(sinceLastActivity)} (total: ${formatDuration(totalElapsed)}, threshold=${formatDuration(effectiveWarnMs)})${toolsNote}, chat:${this.chatId}`);
                this.onWarning?.(sinceLastActivity, totalElapsed);
            }
            else {
                console.log(`[Claude] [${formatDuration(totalElapsed)}] WATCHDOG: Still waiting, no messages for ${formatDuration(sinceLastActivity)}, chat:${this.chatId}`);
            }
        }
        else {
            console.log(`[Claude] [${formatDuration(totalElapsed)}] WATCHDOG: Logging - still waiting for messages${toolsActive ? ` (${this.activeTools.size} tool(s) active)` : ''}`);
        }
    }
    /**
     * Stop the watchdog timer.
     */
    stop() {
        this.stopped = true;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    /**
     * Get total elapsed time since start.
     */
    getElapsedMs() {
        return Date.now() - this.startTime;
    }
}
//# sourceMappingURL=agent-watchdog.js.map