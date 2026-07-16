export declare function isStaleMessage(messageDate: number): boolean;
/**
 * Returns true (and marks session) if we should send an "I was offline" notification.
 * Only fires once per session per bot restart to prevent spam.
 */
export declare function shouldNotifyStale(sessionKey: string): boolean;
/** How many minutes ago the message was sent (relative to now, not bot start). */
export declare function getStaleAgeMinutes(messageDate: number): number;
export declare function getUptimeSeconds(): number;
export declare function getUptimeFormatted(): string;
//# sourceMappingURL=stale-filter.d.ts.map