import { Context } from 'grammy';
export interface VoiceReplyOptions {
    /** Override detected language for TTS (ISO 639-1 code, e.g. "de") */
    language?: string;
    /** When true (voice-first mode), skip the min-length check — voice replies are intentionally short */
    voiceMode?: boolean;
}
export declare function maybeSendVoiceReply(ctx: Context, text: string, options?: VoiceReplyOptions): Promise<void>;
//# sourceMappingURL=voice-reply.d.ts.map