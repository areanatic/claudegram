import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BotEffectivenessHealth {
  schema_version: 1;
  writer_pid: number;
  bot_name: string;
  bot_role: 'master' | 'person';
  started_at: string;
  updated_at: string;
  telegram_get_me: {
    last_success_at: string | null;
    last_failure_at: string | null;
    last_error: string | null;
  };
  turns: {
    last_success_at: string | null;
  };
}

export class BotEffectivenessReporter {
  private readonly filePath: string;
  private health: BotEffectivenessHealth;

  constructor(input: { dataDir: string; botName: string; botRole: 'master' | 'person'; now?: () => Date }) {
    const now = input.now ?? (() => new Date());
    const timestamp = now().toISOString();
    this.filePath = path.join(input.dataDir, 'health.json');
    this.health = {
      schema_version: 1,
      writer_pid: process.pid,
      bot_name: input.botName,
      bot_role: input.botRole,
      started_at: timestamp,
      updated_at: timestamp,
      telegram_get_me: { last_success_at: null, last_failure_at: null, last_error: null },
      turns: { last_success_at: null },
    };
  }

  snapshot(): BotEffectivenessHealth {
    return structuredClone(this.health);
  }

  markGetMeSuccess(at = new Date()): void {
    this.health.telegram_get_me.last_success_at = at.toISOString();
    this.health.telegram_get_me.last_failure_at = null;
    this.health.telegram_get_me.last_error = null;
    this.persist(at);
  }

  markGetMeFailure(error: unknown, at = new Date()): void {
    this.health.telegram_get_me.last_failure_at = at.toISOString();
    this.health.telegram_get_me.last_error = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    this.persist(at);
  }

  markSuccessfulTurn(at = new Date()): void {
    this.health.turns.last_success_at = at.toISOString();
    this.persist(at);
  }

  private persist(at: Date): void {
    this.health.updated_at = at.toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    // This module is the only writer. Temp+rename ensures monitors never read
    // a half-written JSON document.
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.health, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
