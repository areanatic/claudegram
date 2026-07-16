export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'unknown';
export type ExtractMode = 'text' | 'audio' | 'video' | 'all';
export type SubtitleFormat = 'text' | 'srt' | 'vtt';
export interface ExtractResult {
    platform: Platform;
    title: string;
    url: string;
    duration: number | null;
    transcript?: string;
    subtitlePath?: string;
    subtitleFormat?: SubtitleFormat;
    audioPath?: string;
    videoPath?: string;
    warnings: string[];
    /** @internal temp dir for cleanup */
    _tempDir?: string;
}
export declare function detectPlatform(url: string): Platform;
/**
 * Quick synchronous URL validation for UI purposes.
 * Checks protocol only - full SSRF protection happens via isUrlAllowed() in extractMedia().
 */
export declare function isValidUrl(url: string): boolean;
export declare function platformLabel(platform: Platform): string;
export interface ExtractOptions {
    url: string;
    mode: ExtractMode;
    subtitleFormat?: SubtitleFormat;
    onProgress?: (message: string) => void;
}
export declare function extractMedia(opts: ExtractOptions): Promise<ExtractResult>;
/**
 * Clean up temp files from an extraction result.
 * Call this AFTER you've sent all files to Telegram.
 */
export declare function cleanupExtractResult(result: ExtractResult): void;
//# sourceMappingURL=extract.d.ts.map