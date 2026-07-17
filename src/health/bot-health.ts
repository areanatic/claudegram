import type { Bot } from 'grammy';
import { config, isMasterBot } from '../config.js';
import { BotEffectivenessReporter, type BotEffectivenessHealth } from './effectiveness.js';

const reporter = new BotEffectivenessReporter({
  dataDir: config.DATA_DIR,
  botName: config.BOT_NAME,
  botRole: isMasterBot ? 'master' : 'person',
});

let heartbeat: NodeJS.Timeout | undefined;
let inFlight = false;

export function getBotEffectivenessHealth(): BotEffectivenessHealth {
  return reporter.snapshot();
}

export function recordSuccessfulTurn(): void {
  reporter.markSuccessfulTurn();
}

export function recordInitialTelegramRoundtrip(): void {
  // bot.init() has just completed its getMe request successfully.
  reporter.markGetMeSuccess();
}

export function startBotHealthHeartbeat(bot: Bot): void {
  if (heartbeat) return;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await bot.api.getMe();
      reporter.markGetMeSuccess();
    } catch (error) {
      reporter.markGetMeFailure(error);
      console.error('[Health] Telegram getMe heartbeat failed:', error);
    } finally {
      inFlight = false;
    }
  };
  heartbeat = setInterval(() => { void tick(); }, config.BOT_HEALTH_GETME_INTERVAL_MS);
  heartbeat.unref();
}

export function stopBotHealthHeartbeat(): void {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}
