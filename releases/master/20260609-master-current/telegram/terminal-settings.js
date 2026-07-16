/**
 * Terminal UI settings per chat.
 * Persists user preferences for terminal-style display mode.
 */
import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
// Zod schema for terminal UI settings
const terminalSettingsSchema = z.object({
    enabled: z.boolean().optional(),
});
// Zod schema for the full settings file
const terminalSettingsFileSchema = z.object({
    settings: z.record(z.string(), terminalSettingsSchema),
});
const SETTINGS_DIR = config.DATA_DIR;
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'terminal-ui-settings.json');
const chatTerminalSettings = new Map();
function ensureDirectory() {
    if (!fs.existsSync(SETTINGS_DIR)) {
        fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    }
}
function normalizeSettings(settings) {
    return {
        enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.TERMINAL_UI_DEFAULT,
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
        const result = terminalSettingsFileSchema.safeParse(parsed);
        if (!result.success) {
            console.warn('[TerminalUI] Invalid settings file format, starting fresh:', result.error.message);
            return;
        }
        for (const [key, settings] of Object.entries(result.data.settings)) {
            chatTerminalSettings.set(key, normalizeSettings(settings));
        }
    }
    catch (error) {
        console.error('[TerminalUI] Failed to load settings:', error);
    }
}
function saveSettings() {
    ensureDirectory();
    const settings = {};
    for (const [key, value] of chatTerminalSettings.entries()) {
        settings[key] = value;
    }
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
    }
    catch (error) {
        console.error('[TerminalUI] Failed to save settings:', error);
    }
}
loadSettings();
export function getTerminalUISettings(sessionKey) {
    const existing = chatTerminalSettings.get(sessionKey);
    if (existing)
        return existing;
    const defaults = normalizeSettings();
    chatTerminalSettings.set(sessionKey, defaults);
    saveSettings();
    return defaults;
}
export function setTerminalUIEnabled(sessionKey, enabled) {
    const settings = getTerminalUISettings(sessionKey);
    settings.enabled = enabled;
    saveSettings();
}
export function isTerminalUIEnabled(sessionKey) {
    return getTerminalUISettings(sessionKey).enabled;
}
//# sourceMappingURL=terminal-settings.js.map