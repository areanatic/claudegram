import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
// Zod schema for Telegraph settings
const telegraphSettingsSchema = z.object({
    enabled: z.boolean().optional(),
});
// Zod schema for the full Telegraph settings file
const telegraphSettingsFileSchema = z.object({
    settings: z.record(z.string(), telegraphSettingsSchema),
});
const SETTINGS_DIR = config.DATA_DIR;
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'telegraph-settings.json');
const chatTelegraphSettings = new Map();
/**
 * Validate sessionKey is a non-empty string to prevent injection.
 */
function validateSessionKey(sessionKey) {
    if (!sessionKey || typeof sessionKey !== 'string') {
        throw new Error(`Invalid sessionKey: ${sessionKey}`);
    }
}
function ensureDirectory() {
    if (!fs.existsSync(SETTINGS_DIR)) {
        fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    }
    else {
        // Verify existing directory has correct permissions (owner-only)
        try {
            const stats = fs.statSync(SETTINGS_DIR);
            // Check if it's a directory and has restrictive permissions (mode 0o700)
            if (!stats.isDirectory()) {
                throw new Error(`${SETTINGS_DIR} exists but is not a directory`);
            }
            // On non-Windows, verify permissions
            if (process.platform !== 'win32') {
                const perms = stats.mode & 0o777;
                if (perms !== 0o700) {
                    // Fix permissions if too permissive
                    fs.chmodSync(SETTINGS_DIR, 0o700);
                }
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('[Telegraph] Directory permission check failed:', error);
            }
        }
    }
}
function normalizeSettings(settings) {
    return {
        // Default to global config value if not set
        enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.TELEGRAPH_ENABLED,
    };
}
function loadSettings() {
    ensureDirectory();
    if (!fs.existsSync(SETTINGS_FILE))
        return;
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Validate with Zod schema
        const result = telegraphSettingsFileSchema.safeParse(parsed);
        if (!result.success) {
            console.warn('[Telegraph] Invalid settings file format, starting fresh:', result.error.message);
            return;
        }
        for (const [key, settings] of Object.entries(result.data.settings)) {
            chatTelegraphSettings.set(key, normalizeSettings(settings));
        }
    }
    catch (error) {
        console.error('[Telegraph] Failed to load settings:', error);
    }
}
function saveSettings() {
    ensureDirectory();
    const settings = {};
    for (const [key, value] of chatTelegraphSettings.entries()) {
        settings[key] = value;
    }
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
    }
    catch (error) {
        console.error('[Telegraph] Failed to save settings:', error);
    }
}
loadSettings();
export function getTelegraphSettings(sessionKey) {
    validateSessionKey(sessionKey);
    const existing = chatTelegraphSettings.get(sessionKey);
    if (existing)
        return existing;
    const defaults = normalizeSettings();
    chatTelegraphSettings.set(sessionKey, defaults);
    saveSettings();
    return defaults;
}
export function setTelegraphEnabled(sessionKey, enabled) {
    validateSessionKey(sessionKey);
    const settings = getTelegraphSettings(sessionKey);
    settings.enabled = enabled;
    saveSettings();
}
export function isTelegraphEnabled(sessionKey) {
    return getTelegraphSettings(sessionKey).enabled;
}
//# sourceMappingURL=telegraph-settings.js.map