export declare const OMI_WRITER_SOURCES: readonly ["omi", "omi-bridge", "omi-bridge-task", "omi-synthesis", "scanner-pro", "scanner-pro-original"];
/** Codex P0-4: privacy postcondition — OMI writer-phase sources MUST NOT have
 *  public rows. Exported so it can be unit-tested against a fixture DB
 *  (NEXUS_MEMORY_DB env override). Checks OMI_WRITER_SOURCES only (the rows the
 *  watcher's phases can actually create), NOT the broader retrieval allowlist. */
export declare function privacyPostcondition(): {
    ok: boolean;
    details: string;
};
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