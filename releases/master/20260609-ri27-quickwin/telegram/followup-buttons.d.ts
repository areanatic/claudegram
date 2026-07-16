import { Context } from 'grammy';
/**
 * Send follow-up buttons as a separate message after the response.
 * Only shows buttons when Claude provides them via [BUTTONS: ...] markup.
 */
export declare function sendFollowUpButtons(ctx: Context, sessionKey: string, responseText?: string, buttons?: string[]): Promise<void>;
/**
 * Dismiss (delete) stale follow-up buttons when user sends a new message.
 */
export declare function dismissFollowUpButtons(ctx: Context, sessionKey: string): Promise<void>;
/**
 * Handle follow-up button presses. Registered in bot.ts callback router.
 * callback_data format: "followup:{index}:{label}"
 */
export declare function handleFollowUpCallback(ctx: Context): Promise<void>;
//# sourceMappingURL=followup-buttons.d.ts.map