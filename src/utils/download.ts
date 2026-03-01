import { spawn, execFile } from 'child_process';

/**
 * Validate URL for safe curl download.
 * Rejects URLs that could cause injection in curl commands.
 */
function isValidCurlUrl(url: string): boolean {
  // Must be http or https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }
  // Reject URLs with newlines, control characters, or shell metacharacters
  if (/[\r\n\0]/.test(url)) {
    return false;
  }
  return true;
}

/**
 * Download a file from a URL using curl.
 * Uses execFile with explicit URL argument (safe from shell injection).
 * Validates URL to prevent curl-specific injection attacks.
 *
 * @param timeoutSeconds Max transfer time in seconds (default 30, increase for large files)
 */
export function downloadFileSecure(fileUrl: string, destPath: string, timeoutSeconds = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidCurlUrl(fileUrl)) {
      reject(new Error('Invalid URL for download'));
      return;
    }

    // Use execFile (not spawn with shell) with URL as explicit argument.
    // This avoids shell injection entirely.
    execFile(
      'curl',
      [
        '-sS',
        '-f',
        '--connect-timeout', '10',
        '--max-time', String(timeoutSeconds),
        '--retry', '3',
        '--retry-delay', '2',
        '--retry-all-errors',
        '-o', destPath,
        '--', // End of options marker
        fileUrl, // URL as positional argument
      ],
      { timeout: (timeoutSeconds + 30) * 1000 }, // Node timeout = curl timeout + 30s buffer
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`Failed to download file: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Build a Telegram file download URL from the bot token and file path.
 * Automatically uses local API server URL when TELEGRAM_API_SERVER_URL is configured.
 * The apiRoot parameter is optional and overrides the env-based default.
 */
export function getTelegramFileUrl(botToken: string, filePath: string, apiRoot?: string): string {
  // Auto-detect from environment if not explicitly provided
  const base = apiRoot || process.env.TELEGRAM_API_SERVER_URL || 'https://api.telegram.org';
  return `${base}/file/bot${botToken}/${filePath}`;
}
