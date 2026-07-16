export interface TranscribeOptions {
    /** Timeout in milliseconds. Defaults to config.VOICE_TIMEOUT_MS */
    timeoutMs?: number;
    /** If true, return empty string instead of throwing on empty result */
    allowEmpty?: boolean;
}
export type VoiceQualityFlag = 'ok' | 'empty_or_silent' | 'low_bitrate_hollow' | 'loop_hallucination' | 'low_confidence';
export interface TranscribeResult {
    text: string;
    /** Full language name as returned by Whisper, e.g. "english", "german" */
    language: string;
    /** ISO 639-1 language code, e.g. "en", "de" */
    languageCode: string;
    /** Whisper avg_logprob of the first segment (null if unavailable). */
    avgLogprob: number | null;
    /** Whisper no_speech_prob of the first segment (null if unavailable). */
    noSpeechProb: number | null;
    /**
     * True when Whisper's confidence signals indicate a likely hallucination
     * (avg_logprob < -1.0 or no_speech_prob > 0.6). A2 confidence gate: the voice
     * handler refuses to forward a low-confidence transcript to the agent.
     */
    lowConfidence: boolean;
    /** Audio duration in seconds as reported by Whisper (null if unavailable). */
    durationSec: number | null;
    /** Raw file bytes / duration. Forensik 2026-05-23 incident: ~234-244 b/s for hollow OGGs; normal voice ~4000 b/s. Hard reject <500. */
    bytesPerSec: number | null;
    /** Stage 2 Voice-Quality-Gate: rough Whisper-output classification. 'ok' means the transcript is forwardable to the agent. */
    qualityFlag: VoiceQualityFlag;
}
/**
 * Transcribe an audio file with auto-detected language using verbose_json format.
 * Returns transcript text, detected language name, and ISO 639-1 code.
 */
export declare function transcribeFileWithLanguage(filePath: string, options?: TranscribeOptions): Promise<TranscribeResult>;
/**
 * Transcribe an audio file using the Groq Whisper API via OpenAI SDK.
 * Uses fixed language from config (backward-compatible).
 */
export declare function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string>;
/**
 * Download a file from Telegram servers securely.
 * Constructs the URL via getTelegramFileUrl and delegates to downloadFileSecure.
 */
export declare function downloadTelegramAudio(botToken: string, filePath: string, destPath: string): Promise<void>;
//# sourceMappingURL=transcribe.d.ts.map