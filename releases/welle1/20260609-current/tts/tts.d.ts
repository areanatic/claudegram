/**
 * Split text into chunks of at most maxLen characters, breaking at sentence
 * boundaries (.!?) first, then word boundaries, then hard-cutting.
 */
export declare function chunkText(text: string, maxLen?: number): string[];
export interface GenerateSpeechOptions {
    /** ISO 639-1 language code (e.g. "de", "en"). When non-English + Groq provider, auto-falls back to OpenAI */
    language?: string;
}
/**
 * Thrown when no TTS provider can synthesize the requested language
 * (e.g. non-English while the OpenAI fallback is disabled). Callers should
 * catch this and degrade to text-only — it is NOT an error condition.
 */
export declare class TtsUnavailableError extends Error {
}
/**
 * Generate speech using the configured TTS provider.
 * Returns an audio Buffer (format depends on provider:
 *   - groq: OGG/Opus
 *   - openai: format from TTS_RESPONSE_FORMAT config)
 *
 * When language is non-English and provider is Groq (English-only),
 * automatically falls back to OpenAI TTS if OPENAI_API_KEY is available.
 */
export declare function generateSpeech(text: string, voice?: string, options?: GenerateSpeechOptions): Promise<Buffer>;
//# sourceMappingURL=tts.d.ts.map