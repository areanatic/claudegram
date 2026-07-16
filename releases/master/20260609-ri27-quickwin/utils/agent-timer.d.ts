/**
 * Agent timer utility for tracking elapsed time during agent queries.
 * Provides human-readable duration formatting and timing state management.
 */
export interface AgentTimer {
    startTime: number;
    lastMessageTime: number;
    messageCount: number;
}
/**
 * Create a new agent timer initialized to the current time.
 */
export declare function createAgentTimer(): AgentTimer;
/**
 * Record that a message was received, updating the last message time.
 */
export declare function recordMessage(timer: AgentTimer): void;
/**
 * Get elapsed milliseconds since timer start.
 */
export declare function getElapsedMs(timer: AgentTimer): number;
/**
 * Get milliseconds since last message was recorded.
 */
export declare function getSinceLastMessageMs(timer: AgentTimer): number;
/**
 * Format a duration in milliseconds to human-readable string.
 * Examples: "0s", "45s", "1m 30s", "2m 0s"
 */
export declare function formatDuration(ms: number): string;
/**
 * Get a timing report string for logging.
 */
export declare function getTimingReport(timer: AgentTimer): string;
/**
 * RF-6 Latenz-Marker (Wave 1 / Stream 1): freundliche, grobe Dauer für den User
 * ("⏱ ~2 Min") auf langsamen Antworten. Auf ganze Minuten AUFGERUNDET (ehrliche
 * Grob-Angabe, kein Pseudo-Präzises "1m 30s"); die Tilde signalisiert "ungefähr".
 * Unter 60s fällt es auf Sekunden ("Xs") zurück — nur relevant, wenn
 * LATENCY_MARKER_MIN_MS testweise < 60000 gesetzt ist. Reuse des bestehenden
 * Elapsed-Mechanismus (getElapsedMs/AgentTimer) — KEIN zweiter Timer.
 * Negative Inputs werden auf 0 geklemmt (Codex P2-Guard).
 */
export declare function formatLatencyMarker(ms: number): string;
//# sourceMappingURL=agent-timer.d.ts.map