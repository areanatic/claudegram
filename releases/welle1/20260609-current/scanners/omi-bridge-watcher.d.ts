export declare function startOmiBridgeWatcher(): void;
export declare function stopOmiBridgeWatcher(): Promise<void>;
export interface OmiBridgeWatcherStatus {
    enabled: boolean;
    reason?: string;
    running: boolean;
    current_phase: string | null;
    disabled_persistent: boolean;
    disabled_reason: string | null;
    consecutive_failures: number;
    total_runs: number;
    total_success_runs: number;
    last_run_started_at: string | null;
    last_run_duration_ms: number | null;
    last_pipeline_at: string | null;
    last_ocr_at: string | null;
    last_ner_at: string | null;
    last_tasks_at: string | null;
}
export declare function getOmiBridgeWatcherStatus(): OmiBridgeWatcherStatus;
//# sourceMappingURL=omi-bridge-watcher.d.ts.map