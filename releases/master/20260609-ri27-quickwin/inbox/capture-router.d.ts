/**
 * Universal Telegram Capture — Router (FIRST middleware)
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * Captures every non-command message into the captures table sub-ms.
 * No download, no transcript, no categorisation in Phase 1.
 * Mini-Ack via 📥-Reaction on the original user message.
 */
import { type Context, type NextFunction } from 'grammy';
export declare function captureRouter(ctx: Context, next: NextFunction): Promise<void>;
//# sourceMappingURL=capture-router.d.ts.map