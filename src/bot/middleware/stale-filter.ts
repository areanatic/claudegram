const BOT_START_TIME = Date.now();
const STALE_THRESHOLD_MS = 180_000; // 3 minutes — covers Claude response time (30–120s)

/** Sessions already notified about offline gap this boot cycle. One notify per session. */
const notifiedSessions = new Set<string>();

export function isStaleMessage(messageDate: number): boolean {
  // messageDate is Unix timestamp in seconds, convert to ms
  const messageDateMs = messageDate * 1000;
  return messageDateMs < BOT_START_TIME - STALE_THRESHOLD_MS;
}

/**
 * Returns true (and marks session) if we should send an "I was offline" notification.
 * Only fires once per session per bot restart to prevent spam.
 */
export function shouldNotifyStale(sessionKey: string): boolean {
  if (notifiedSessions.has(sessionKey)) return false;
  notifiedSessions.add(sessionKey);
  return true;
}

/** How many minutes ago the message was sent (relative to now, not bot start). */
export function getStaleAgeMinutes(messageDate: number): number {
  const messageDateMs = messageDate * 1000;
  return Math.max(1, Math.round((Date.now() - messageDateMs) / 60_000));
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - BOT_START_TIME) / 1000);
}

export function getUptimeFormatted(): string {
  const seconds = getUptimeSeconds();

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  return `${days}d ${remainingHours}h`;
}
