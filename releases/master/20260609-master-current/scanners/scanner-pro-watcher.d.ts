export declare function startScannerProWatcher(): void;
export declare function stopScannerProWatcher(): Promise<void>;
export interface WatcherStatus {
    enabled: boolean;
    reason?: string;
    running: boolean;
    totalRuns: number;
    totalSuccessRuns: number;
    consecutiveFailures: number;
    lastRunAt: string | null;
    lastExitCode: number | null;
    lastDurationMs: number | null;
}
export declare function getScannerWatcherStatus(): WatcherStatus;
//# sourceMappingURL=scanner-pro-watcher.d.ts.map