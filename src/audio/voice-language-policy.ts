export type BotRole = 'master' | 'person' | undefined;

/**
 * R7 language policy: the Master is the operator's unrestricted lane and must
 * accept every Whisper-detected language unless explicitly constrained. Person
 * bots keep the conservative German/English default.
 */
export function resolveVoiceAllowedLanguages(
  configured: string | undefined,
  botRole: BotRole,
  botName: string,
): string[] {
  const master = botRole === 'master' || (botRole === undefined && botName === 'Nexusgram');
  if (configured === undefined && master) return [];
  return (configured ?? 'de,en')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
}
