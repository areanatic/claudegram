export interface TTSSettings {
    enabled: boolean;
    voice: string;
    autoplay: boolean;
    /** Auto-enabled when user sends voice message, auto-disabled when they type text */
    voiceFirstMode: boolean;
    /** Last detected language code from STT (e.g. "de", "en") */
    detectedLanguage: string | null;
}
export declare function getTTSSettings(sessionKey: string): TTSSettings;
export declare function setTTSEnabled(sessionKey: string, enabled: boolean): void;
export declare function setTTSVoice(sessionKey: string, voice: string): void;
export declare function setTTSAutoplay(sessionKey: string, autoplay: boolean): void;
export declare function isTTSEnabled(sessionKey: string): boolean;
/** Returns true only if TTS is enabled AND voice-first mode is active.
 * enabled=false is a hard-off — voiceFirstMode cannot override it. */
export declare function isVoiceActive(sessionKey: string): boolean;
export declare function setVoiceFirstMode(sessionKey: string, enabled: boolean): void;
export declare function setDetectedLanguage(sessionKey: string, language: string | null): void;
export declare function getDetectedLanguage(sessionKey: string): string | null;
//# sourceMappingURL=tts-settings.d.ts.map