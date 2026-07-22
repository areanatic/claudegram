/** User-facing recovery copy for optional engines. Never expose process stderr. */
export function engineUnavailableMessage(
  requested: string,
  activeEngine: string,
): string {
  return [
    `Die Engine ${requested} ist gerade nicht verfügbar.`,
    `Aktiv bleibt ${activeEngine}.`,
    'Nächster Schritt: Mit /engine den Status prüfen oder mit /engine anthropic zur Standard-Engine wechseln.',
  ].join(' ');
}

export function codexFailureMessage(): string {
  return [
    'Codex konnte den Auftrag nicht abschließen; interne Prozessdetails wurden nicht an Telegram ausgegeben.',
    'Nächster Schritt: Mit /engine den Status prüfen oder denselben Auftrag ohne /codex über die aktive Engine senden.',
  ].join(' ');
}
