/**
 * Sanitize a string by replacing sensitive paths and usernames.
 * Useful for error messages and logs to prevent information leakage.
 */
export declare function sanitizePath(str: string): string;
/**
 * Extract and sanitize an error message for user-facing display.
 * Returns a sanitized message string with sensitive paths removed.
 * Note: Does not sanitize stack traces — avoid logging raw error objects to users.
 */
export declare function sanitizeError(error: unknown): string;
//# sourceMappingURL=sanitize.d.ts.map