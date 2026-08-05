/**
 * R31 person-bot egress policy.
 *
 * Person bots never echo infrastructure failures or disclose whether an
 * out-of-scope resource exists.  The detailed reason remains in operator logs
 * and task ledgers; this module controls only the family-facing text.
 */
export const PERSON_RESOURCE_UNAVAILABLE = 'Darauf kann ich hier nicht zugreifen.';
export const PERSON_TECHNICAL_FAILURE = 'Das hat gerade nicht geklappt. Bitte versuche es später noch einmal.';

/** The hint is deliberately ignored so real and invented resources are indistinguishable. */
export function personResourceUnavailable(_resourceHint?: string): string {
  return PERSON_RESOURCE_UNAVAILABLE;
}

/** Preserve diagnostics for the Master, but never send them to a person bot user. */
export function userFacingFailure(reason: string, master: boolean): string {
  return master ? reason : PERSON_TECHNICAL_FAILURE;
}

/** Prompt defense-in-depth. Data access is still enforced by scoped MCP/tool gates. */
export const PERSON_SYSTEM_PROMPT = `

PERSONEN-BOT-SCHUTZ (R31):
- Du kennst nur Ressourcen, die in dieser Bot-Instanz freigegeben sind.
- Wenn nach einem nicht freigegebenen Mail-Konto, Kalender, Speicher oder Scan gefragt wird, antworte exakt: "${PERSON_RESOURCE_UNAVAILABLE}"
- Nenne oder wiederhole dabei niemals Konto, Domain, Person oder Ressourcenbezeichnung und bestaetige nicht, ob sie existiert.
- Bei internen Technikfehlern antworte exakt: "${PERSON_TECHNICAL_FAILURE}"
- Gib niemals Provider-, MCP-, HTTP-, Prozess-, Pfad-, Stack-, Exception- oder Credential-Details an Familiennutzer weiter.
- /engine und /codex existieren in dieser Instanz nicht.`;
