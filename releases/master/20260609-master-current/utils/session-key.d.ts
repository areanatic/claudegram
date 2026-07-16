/**
 * Session key utilities for forum topic support.
 *
 * In regular chats, the session key is just the chatId as a string: "12345"
 * In forum topics, it combines chatId and threadId: "12345:42"
 * This allows each forum topic to have an independent session.
 */
export type SessionKey = string;
export declare function buildSessionKey(chatId: number, threadId?: number): SessionKey;
export declare function parseSessionKey(key: SessionKey): {
    chatId: number;
    threadId?: number;
};
interface SessionKeyInfo {
    chatId: number;
    threadId?: number;
    sessionKey: SessionKey;
}
/**
 * Extract session key info from a Grammy context.
 * Uses message_thread_id only when is_topic_message is true (forum topics).
 */
export declare function getSessionKeyFromCtx(ctx: {
    chat?: {
        id: number;
    };
    message?: {
        is_topic_message?: boolean;
        message_thread_id?: number;
    } | undefined;
    callbackQuery?: {
        message?: {
            is_topic_message?: boolean;
            message_thread_id?: number;
        } | undefined;
    } | undefined;
}): SessionKeyInfo | null;
/**
 * Build a session key for pd (Product Development) parallel sessions.
 * Format: pd:{userId}:{chatId}:{projectSlug}:{agentId}
 * These are independent from the main session key and support multiple
 * concurrent product-development sessions per user.
 */
export declare function buildPdSessionKey(userId: number, chatId: number, projectSlug: string, agentId: string): string;
/**
 * Build a temporary session key for Council Mode.
 * Format: council:{timestamp}:{agentId}
 * These are ephemeral — discarded after council synthesis.
 */
export declare function buildCouncilSessionKey(timestamp: number, agentId: string): string;
/**
 * Check if a session key belongs to the pd namespace.
 */
export declare function isPdSessionKey(sessionKey: string): boolean;
/**
 * Check if a session key belongs to a council round.
 */
export declare function isCouncilSessionKey(sessionKey: string): boolean;
export {};
//# sourceMappingURL=session-key.d.ts.map