import * as os from 'os';

const HOME_DIR = os.homedir();
let USERNAME = '';
try { USERNAME = os.userInfo().username; } catch { USERNAME = ''; }

/**
 * Sanitize a string by replacing sensitive paths and usernames.
 * Useful for error messages and logs to prevent information leakage.
 */
export function sanitizePath(str: string): string {
  if (!str) return str;

  let sanitized = str;

  // Replace home directory with ~
  if (HOME_DIR) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(HOME_DIR), 'g'), '~');
  }

  // Replace username if it appears in paths
  if (USERNAME && USERNAME.length > 2) {
    // Only replace in path-like contexts to avoid false positives
    sanitized = sanitized.replace(
      new RegExp(`/Users/${escapeRegExp(USERNAME)}`, 'g'),
      '/Users/<user>'
    );
    sanitized = sanitized.replace(
      new RegExp(`/home/${escapeRegExp(USERNAME)}`, 'g'),
      '/home/<user>'
    );
  }

  return sanitized;
}

/**
 * Remove credential-shaped values before an error reaches a persistent log.
 * grammY's BotError contains the complete Context object, including the API
 * client token, so callers must log this bounded string instead of the raw
 * error object.
 */
export function sanitizeLogText(str: string): string {
  return sanitizePath(str)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-telegram-token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, 'Bearer <redacted>');
}

/**
 * Extract and sanitize an error message for user-facing display.
 * Returns a sanitized message string with sensitive paths removed.
 * Note: Does not sanitize stack traces — avoid logging raw error objects to users.
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeLogText(error.message);
  }
  if (typeof error === 'string') {
    return sanitizeLogText(error);
  }
  return 'Unknown error';
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
