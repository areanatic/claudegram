import { config } from '../../config.js';
/**
 * Log authentication attempt for security auditing.
 * Avoids logging message content to protect privacy.
 */
function logAuthAttempt(success, userId, username, chatType) {
    const timestamp = new Date().toISOString();
    const userInfo = userId ? `user:${userId}` : 'user:unknown';
    const usernameInfo = username ? `@${username}` : '';
    const status = success ? 'ALLOWED' : 'DENIED';
    console.log(`[auth] ${timestamp} ${status} ${userInfo} ${usernameInfo} chat:${chatType || 'unknown'}`);
}
// Telegram's GroupAnonymousBot ID — used when admins post anonymously in groups/forums
const GROUP_ANONYMOUS_BOT_ID = 1087968824;
export async function authMiddleware(ctx, next) {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const chatType = ctx.chat?.type;
    const chatId = ctx.chat?.id;
    if (!userId) {
        logAuthAttempt(false, undefined, undefined, chatType);
        return;
    }
    // Allow anonymous admins in explicitly allowed groups (forum topics)
    if (userId === GROUP_ANONYMOUS_BOT_ID && chatId && config.ALLOWED_GROUP_IDS.includes(chatId)) {
        logAuthAttempt(true, userId, username, chatType);
        await next();
        return;
    }
    if (!config.ALLOWED_USER_IDS.includes(userId)) {
        logAuthAttempt(false, userId, username, chatType);
        await ctx.reply('⛔ You are not authorized to use this bot.');
        return;
    }
    logAuthAttempt(true, userId, username, chatType);
    await next();
}
//# sourceMappingURL=auth.middleware.js.map