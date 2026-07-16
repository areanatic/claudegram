/**
 * Universal Telegram Capture — "wichtig"-Trigger (deep-pass)
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * User replies to a captured message with text starting with "wichtig" /
 * "important" / "deep" → look up the original capture, run the type-specific
 * deep handler (Whisper for voice, transcript-extract for URLs, …), append the
 * user-supplied free-text as additional tag/context.
 *
 * "wichtig" is interpreted on the message that the user is REPLYING to, not on
 * the reply itself.
 */
import { type Context } from 'grammy';
/**
 * Returns true if `text` looks like a "wichtig"-style trigger.
 */
export declare function isWichtigTrigger(text: string | undefined | null): boolean;
/**
 * Handle a wichtig-reply. Returns true if a deep-pass was started.
 * Returns false if there was nothing to deep-process (e.g. no original capture
 * found, or already processed) — caller should fall through to normal flow.
 */
export declare function handleWichtigReply(ctx: Context): Promise<boolean>;
//# sourceMappingURL=wichtig-trigger.d.ts.map