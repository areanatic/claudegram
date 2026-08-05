/**
 * Eine Quelle fuer ALLES, was per Telegram auswaehlbar ist.
 *
 * WARUM ES DIESE DATEI GIBT
 * -------------------------
 * Bisher war die Auswahl auf zwei Kommandos verteilt: `/model` kannte drei hartkodierte
 * Claude-Namen, `/engine` kannte die Engines. Neue Modelle tauchten nie von selbst auf —
 * dieselbe Drift, die den Master fuenf Monate auf einer Februar-Engine laufen liess.
 *
 * Deshalb hier: Claude, Codex und die lokalen Modelle in EINEM Katalog, und was live
 * abfragbar ist, wird live abgefragt statt gepflegt.
 *
 * EHRLICHE GRENZE (gemessen 2026-08-02 an `node_modules/@anthropic-ai/claude-agent-sdk`):
 * Die gebuendelte Engine 2.1.63 (Build 2026-02-28) kennt Effort `low|medium|high|max`,
 * aber NICHT `xhigh` (0 Treffer). Und sie kennt Modell-IDs nur bis `claude-opus-4-1`.
 * Neuere IDs werden durchgereicht und funktionieren, bekommen aber ein Fallback-
 * Faehigkeitsprofil (200k Kontext statt 1M, kein adaptives Thinking). Der Katalog
 * markiert das, statt es zu verschweigen — behoben wird es erst mit dem Engine-Update.
 */
import { config } from '../config.js';

export type EffortLevel = 'low' | 'medium' | 'high';

/**
 * Was tatsaechlich WAEHLBAR ist — nicht was die Engine-Binary kennt.
 *
 * GEMESSEN 2026-08-03 an der echten Fehlermeldung der Laufzeit:
 *   Error: Effort level "max" is not available for Claude.ai subscribers.
 *          Please use "low", "medium", or "high".
 * 'max' stand im Bundle und wurde deshalb angeboten. Der Klick darauf hat den Bot
 * lahmgelegt: jeder Turn brach mit Exit 1 ab, und weil die Auswahl persistiert wird,
 * blieb der Zustand ueber Neustarts bestehen. Ein Knopf, den das Abo nicht kann,
 * darf nicht im Menue stehen.
 */
export const SUPPORTED_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/** Vom gebuendelten Client nativ erkannte Claude-Familien (Stand Engine 2.1.63). */
const ENGINE_KNOWN_MODEL_PREFIXES = [
  'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-2',
  'claude-sonnet-4', 'claude-haiku-4', 'claude-haiku-3-5',
  'opus', 'sonnet', 'haiku',
];

export interface CatalogEntry {
  /** Stabiler Schluessel fuer Callback-Daten. Kurz halten — Telegram deckelt bei 64 Byte. */
  id: string;
  label: string;
  engine: 'anthropic' | 'codex' | 'ollama';
  /** Was an die Engine uebergeben wird. */
  model: string;
  /** Kurzer Hinweis fuer die Menuezeile. */
  note?: string;
  /** true = die geladene Engine kennt das Modell nativ; false = laeuft, aber mit Fallback-Profil. */
  nativelyKnown: boolean;
}

/** Claude-Modelle. Aliase zuerst, dann explizite IDs fuer neuere Generationen. */
export function claudeEntries(): CatalogEntry[] {
  const known = (m: string) => ENGINE_KNOWN_MODEL_PREFIXES.some((p) => m.startsWith(p));
  const raw: Array<[string, string, string, string | undefined]> = [
    ['opus', 'Opus', 'opus', 'staerkstes Alias'],
    ['sonnet', 'Sonnet', 'sonnet', 'ausgewogen'],
    ['haiku', 'Haiku', 'haiku', 'schnell'],
    ['o48', 'Opus 4.8', 'claude-opus-4-8', undefined],
    ['o5', 'Opus 5', 'claude-opus-5', undefined],
    ['s5', 'Sonnet 5', 'claude-sonnet-5', undefined],
    ['f5', 'Fable 5', 'claude-fable-5', undefined],
  ];
  const extra = config.CLAUDE_EXTRA_MODELS
    ? config.CLAUDE_EXTRA_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const entries = raw.map(([id, label, model, note]) => ({
    id, label, engine: 'anthropic' as const, model, note, nativelyKnown: known(model),
  }));
  for (const model of extra) {
    if (entries.some((e) => e.model === model)) continue;
    entries.push({
      id: `x${model.replace(/[^a-z0-9]/gi, '').slice(-8)}`,
      label: model, engine: 'anthropic', model,
      note: 'aus .env', nativelyKnown: known(model),
    });
  }
  return entries;
}

/** Codex-Profile. Laufen als eigener Prozess, deshalb unabhaengig von der Bot-Engine. */
export function codexEntries(): CatalogEntry[] {
  const models = (config.CODEX_MODELS || 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return models.map((model) => ({
    id: `c${model.split('-').pop()}`,
    label: model,
    engine: 'codex' as const,
    model,
    note: model.endsWith('sol') ? 'staerkstes Profil' : undefined,
    nativelyKnown: true,
  }));
}

interface OllamaTag { name?: string; size?: number }

/**
 * Lokale Modelle LIVE von Ollama. Kein Pflegeaufwand, keine Drift.
 * Faellt bei nicht erreichbarem Ollama auf eine leere Liste zurueck — dann zeigt das
 * Menue schlicht keine lokalen Optionen, statt zu luegen.
 */
export async function ollamaEntries(timeoutMs = 2500): Promise<CatalogEntry[]> {
  try {
    const base = config.OLLAMA_BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: OllamaTag[] };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .sort()
      .map((name, i) => ({
        id: `l${i}`,
        label: name,
        engine: 'ollama' as const,
        model: name,
        note: 'lokal',
        nativelyKnown: true,
      }));
  } catch {
    return [];
  }
}

export interface Catalog {
  claude: CatalogEntry[];
  codex: CatalogEntry[];
  local: CatalogEntry[];
  /** true, wenn Ollama nicht erreichbar war — fuer eine ehrliche Zeile im Menue. */
  localUnavailable: boolean;
}

export async function buildCatalog(): Promise<Catalog> {
  const local = await ollamaEntries();
  return {
    claude: claudeEntries(),
    codex: codexEntries(),
    local,
    localUnavailable: local.length === 0,
  };
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  return [...catalog.claude, ...catalog.codex, ...catalog.local].find((e) => e.id === id);
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (SUPPORTED_EFFORTS as readonly string[]).includes(value);
}

/**
 * Rollen-Gate fuer die Auswahl — bewusst als reine Funktion, damit sie testbar ist.
 *
 * `/engine` und `/codex` sind in bot.ts nur fuer den Master registriert. Das
 * vereinheitlichte `/model`-Menue darf diese Sperre nicht aushebeln: eine Personen-Instanz
 * waehlt weiterhin ausschliesslich Claude-Modelle. Sonst koennte sie ueber die Hintertuer
 * die Engine wechseln und damit Kosten und Datenwege veraendern.
 */
export function scopeCatalogForRole(catalog: Catalog, isMaster: boolean): Catalog {
  if (isMaster) return catalog;
  return { ...catalog, codex: [], local: [], localUnavailable: false };
}
