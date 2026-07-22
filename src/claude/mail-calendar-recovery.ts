export interface MailCalendarRecoveryInput {
  localAccountLabels: readonly string[];
  connectedServers?: readonly string[];
  missingServers?: readonly string[];
}

/**
 * Deterministic recovery contract for the Master. Tool failures are data, not
 * a reason for the model to end in a generic "kann ich nicht" dead end.
 */
export function buildMailCalendarRecoveryPrompt(input: MailCalendarRecoveryInput): string {
  const labels = [...new Set(input.localAccountLabels)].sort();
  const connected = input.connectedServers?.length ? input.connectedServers.join(', ') : 'noch kein Laufzeit-Inventar';
  const missing = input.missingServers?.length ? input.missingServers.join(', ') : 'keine im letzten Inventar';
  return `

MAIL- UND KALENDER-FEHLERVERTRAG (MASTER, VERBINDLICH):
- Kanonische lokale Kontolabels: ${labels.length ? labels.join(', ') : 'Registry aktuell nicht lesbar'}. Das separate Workspace-Konto "mastor.prime" läuft ausschließlich über workspace-google-rw.
- Letztes Laufzeit-Inventar: verbunden=${connected}; fehlend=${missing}. Entscheidend sind immer die im aktuellen Turn tatsächlich angebotenen Tools.
- "Konto nicht gefunden" ist KEIN Endpunkt: nenne die kanonischen verfügbaren Konten, korrigiere nur eine eindeutige Label-Abweichung und wiederhole eine READ-/LIST-Operation einmal. Ist die Zuordnung nicht eindeutig, biete die Liste an und frage gezielt nach dem gewünschten Label.
- Bei Mail-/Kalender-Suche mit unbekanntem Konto: nutze zuerst das passende List-/Aggregate-Tool ohne account-Filter, sofern verfügbar. Behaupte nie pauschal, Mail oder Kalender seien unmöglich, wenn ein anderer verbundener Account-/Serverpfad noch funktioniert.
- Mutationen (Senden, Anlegen, Löschen, Bulk-Commit) NIEMALS blind wiederholen. Nach Teilfehler Status/IDs prüfen und eine neue Bestätigung verlangen, wenn der freigegebene Intent geändert werden müsste.
- Jede endgültige Fehlerantwort enthält genau diese drei Informationen: (1) was konkret fehlgeschlagen ist, (2) welche Konten/Tools weiterhin verfügbar sind, (3) den nächsten ausführbaren Schritt. Bei fehlendem MCP/Token ist der nächste Schritt: /health prüfen und den betroffenen Account/Server benennen; nicht nur "ich kann nicht" sagen.
- Rohe Provider-, Python- oder MCP-Fehler nie als ganze Nutzerantwort weiterreichen. Kurz übersetzen, Ursache nicht erfinden, nächsten Schritt nennen.
`;
}
