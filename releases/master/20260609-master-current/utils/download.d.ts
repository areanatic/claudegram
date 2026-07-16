/**
 * Download a file from a URL using curl.
 * Uses execFile with explicit URL argument (safe from shell injection).
 * Validates URL to prevent curl-specific injection attacks.
 *
 * @param timeoutSeconds Max transfer time in seconds (default 30, increase for large files)
 */
export declare function downloadFileSecure(fileUrl: string, destPath: string, timeoutSeconds?: number): Promise<void>;
/**
 * Build a Telegram file download URL from the bot token and file path.
 * Automatically uses local API server URL when TELEGRAM_API_SERVER_URL is configured.
 * The apiRoot parameter is optional and overrides the env-based default.
 */
export declare function getTelegramFileUrl(botToken: string, filePath: string, apiRoot?: string): string;
//# sourceMappingURL=download.d.ts.map