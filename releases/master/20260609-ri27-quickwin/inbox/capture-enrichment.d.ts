/**
 * Universal Telegram Capture — Enrichment (Phase 1.5)
 *
 * Beim Capture-Time automatisch:
 *   - Voice/Audio: Whisper-Transcript via Groq → `captures.transcript`
 *   - Photo: Vision-Caption via Groq Llama Vision → `captures.transcript`
 *
 * User-Vorgabe 2026-05-07: "Bilder + Audios müssen IMMER eingeschlossen werden."
 *
 * Defensive: alles try/catch, silent fail, blockt nie den Conversation-Flow.
 * Async fire-and-forget vom captureRouter aufgerufen.
 */
import { type Context } from 'grammy';
/**
 * Run Whisper on a voice/audio capture and write transcript to DB.
 */
export declare function enrichVoiceCapture(ctx: Context, captureId: number, telegramFileId: string): Promise<void>;
/**
 * Run Vision on a photo capture and write caption/extracted-data to DB.
 *
 * Uses Groq Llama-4-Scout Vision (free tier, fast, ~1s).
 */
export declare function enrichPhotoCapture(ctx: Context, captureId: number, telegramFileId: string): Promise<void>;
/**
 * Run yt-dlp / Reader extraction on a URL capture and write Title/Description
 * to DB. Bug-Fix 2026-05-09: vorher hatten URL-Captures keinen Worker — sie
 * blieben Tage in `status='queued'` (26 Stk seit 2026-05-02 in Master-Bot).
 *
 * extract.ts bringt yt-dlp + redirect-resolution + platform-detection mit.
 * Wir nehmen mode='text' für minimum-cost (nur metadata, kein audio download).
 */
export declare function enrichUrlCapture(captureId: number, sourceUrl: string): Promise<void>;
/**
 * Entry point — fire-and-forget called by captureRouter after insertCapture.
 * Decides based on capture_type which enrichment to run.
 *
 * Bug-Fix 2026-05-09: url-Branch hinzugefügt (Title/Description-Extract).
 * sourceUrl-Parameter optional dazu — nur für url-type genutzt.
 */
export declare function enrichCaptureAsync(ctx: Context, captureId: number, captureType: string, telegramFileId: string | null, sourceUrl?: string | null): void;
//# sourceMappingURL=capture-enrichment.d.ts.map