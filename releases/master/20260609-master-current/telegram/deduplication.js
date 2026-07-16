const processedMessages = new Map();
const MESSAGE_TTL = 60000; // 1 minute
let cleanupInterval = null;
export function isDuplicate(messageId) {
    return processedMessages.has(messageId);
}
export function markProcessed(messageId) {
    processedMessages.set(messageId, Date.now());
    ensureCleanupRunning();
}
function ensureCleanupRunning() {
    if (cleanupInterval)
        return;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [id, timestamp] of processedMessages) {
            if (now - timestamp > MESSAGE_TTL) {
                processedMessages.delete(id);
            }
        }
        if (processedMessages.size === 0 && cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }
    }, 30000); // Cleanup every 30 seconds
}
export function stopCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}
//# sourceMappingURL=deduplication.js.map