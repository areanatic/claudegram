import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
// Zod schema for TTS settings
const ttsSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    voice: z.string().optional(),
    autoplay: z.boolean().optional(),
    voiceFirstMode: z.boolean().optional(),
    detectedLanguage: z.string().nullable().optional(),
});
// Zod schema for the full TTS settings file
const ttsSettingsFileSchema = z.object({
    settings: z.record(z.string(), ttsSettingsSchema),
});
const SETTINGS_DIR = config.DATA_DIR;
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'tts-settings.json');
const chatTTSSettings = new Map();
function ensureDirectory() {
    if (!fs.existsSync(SETTINGS_DIR)) {
        fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    }
}
const GROQ_TTS_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
const OPENAI_TTS_VOICES = [
    'alloy', 'ash', 'ballad', 'coral',
    'echo', 'fable', 'nova', 'onyx',
    'sage', 'shimmer', 'verse', 'marin', 'cedar',
];
function getDefaultVoice() {
    if (config.TTS_PROVIDER === 'groq') {
        // If the configured TTS_VOICE is valid for Groq, use it; otherwise default to 'troy'
        const voices = GROQ_TTS_VOICES;
        return voices.includes(config.TTS_VOICE) ? config.TTS_VOICE : 'troy';
    }
    return config.TTS_VOICE;
}
function isValidVoiceForProvider(voice) {
    const voices = config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
    return voices.includes(voice);
}
function normalizeSettings(settings) {
    const voice = typeof settings?.voice === 'string' && settings.voice.length > 0
        ? settings.voice
        : getDefaultVoice();
    return {
        enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.TTS_ENABLED,
        voice: isValidVoiceForProvider(voice) ? voice : getDefaultVoice(),
        autoplay: typeof settings?.autoplay === 'boolean' ? settings.autoplay : true,
        voiceFirstMode: false, // Always session-transient — never restored from disk
        detectedLanguage: typeof settings?.detectedLanguage === 'string' ? settings.detectedLanguage : null,
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
        const result = ttsSettingsFileSchema.safeParse(parsed);
        if (!result.success) {
            console.warn('[TTS] Invalid settings file format, starting fresh:', result.error.message);
            return;
        }
        for (const [key, settings] of Object.entries(result.data.settings)) {
            chatTTSSettings.set(key, normalizeSettings(settings));
        }
    }
    catch (error) {
        console.error('[TTS] Failed to load settings:', error);
    }
}
function saveSettings() {
    ensureDirectory();
    // voiceFirstMode is session-transient — strip it before writing to disk.
    // Otherwise a saveSettings() call from setTTSEnabled/setTTSVoice would accidentally
    // persist the current in-memory voiceFirstMode and resurrect it after the next restart.
    const settings = {};
    for (const [key, { voiceFirstMode: _transient, ...persistable }] of chatTTSSettings.entries()) {
        settings[key] = persistable;
    }
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
    }
    catch (error) {
        console.error('[TTS] Failed to save settings:', error);
    }
}
loadSettings();
export function getTTSSettings(sessionKey) {
    const existing = chatTTSSettings.get(sessionKey);
    if (existing)
        return existing;
    const defaults = normalizeSettings();
    chatTTSSettings.set(sessionKey, defaults);
    saveSettings();
    return defaults;
}
export function setTTSEnabled(sessionKey, enabled) {
    const settings = getTTSSettings(sessionKey);
    settings.enabled = enabled;
    saveSettings();
}
export function setTTSVoice(sessionKey, voice) {
    const settings = getTTSSettings(sessionKey);
    settings.voice = voice;
    saveSettings();
}
export function setTTSAutoplay(sessionKey, autoplay) {
    const settings = getTTSSettings(sessionKey);
    settings.autoplay = autoplay;
    saveSettings();
}
export function isTTSEnabled(sessionKey) {
    return getTTSSettings(sessionKey).enabled;
}
/** Returns true only if TTS is enabled AND voice-first mode is active.
 * enabled=false is a hard-off — voiceFirstMode cannot override it. */
export function isVoiceActive(sessionKey) {
    const settings = getTTSSettings(sessionKey);
    if (!settings.enabled)
        return false;
    return settings.voiceFirstMode;
}
export function setVoiceFirstMode(sessionKey, enabled) {
    const settings = getTTSSettings(sessionKey);
    settings.voiceFirstMode = enabled;
    // Don't persist voiceFirstMode to disk — it's session-transient
}
export function setDetectedLanguage(sessionKey, language) {
    const settings = getTTSSettings(sessionKey);
    settings.detectedLanguage = language;
}
export function getDetectedLanguage(sessionKey) {
    return getTTSSettings(sessionKey).detectedLanguage;
}
//# sourceMappingURL=tts-settings.js.map