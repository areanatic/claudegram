/**
 * Persistente Modell-/Engine-/Effort-Auswahl pro Chat.
 *
 * WARUM ES DIESE DATEI GIBT
 * -------------------------
 * Die Auswahl lag bisher ausschliesslich in Modul-Level-Maps (`chatModels` in agent.ts,
 * `sessionEngines` in engine.ts). Jeder Neustart warf sie weg und der Bot fiel still auf
 * den .env-Default zurueck — ohne es zu sagen. Wer umgeschaltet hatte, sprach nach dem
 * naechsten Restart wieder mit dem alten Modell und merkte es nicht.
 *
 * Ablage: eine kleine JSON-Datei je Bot unter DATA_DIR. Kein Schema, keine Migration,
 * kein Nebenlaufigkeitsproblem — Schreibvorgaenge sind selten und atomar (tmp + rename).
 * Kaputte oder fremde Inhalte werden ignoriert statt zu werfen: eine unlesbare
 * Auswahldatei darf niemals den Botstart verhindern.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { EffortLevel } from './model-catalog.js';

export interface StoredSelection {
  engine?: 'anthropic' | 'codex' | 'ollama';
  model?: string;
  effort?: EffortLevel;
  /** ISO-Zeitpunkt der letzten Aenderung — rein informativ, fuer /status. */
  updatedAt?: string;
}

type Store = Record<string, StoredSelection>;

const FILE = path.join(config.DATA_DIR, `${config.BOT_NAME}-model-selection.json`);

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    // Datei fehlt beim ersten Start, ist leer oder beschaedigt — alles unkritisch.
    cache = {};
  }
  return cache;
}

function persist(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (error) {
    // Persistenz ist Komfort, kein Muss. Ein Schreibfehler darf den Turn nicht kippen.
    console.warn('[SelectionStore] konnte Auswahl nicht speichern:',
      error instanceof Error ? error.message : String(error));
  }
}

export function getStoredSelection(sessionKey: string): StoredSelection {
  return load()[sessionKey] ?? {};
}

export function setStoredSelection(sessionKey: string, patch: StoredSelection): StoredSelection {
  const store = load();
  const next: StoredSelection = {
    ...(store[sessionKey] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store[sessionKey] = next;
  cache = store;
  persist(store);
  return next;
}

export function clearStoredSelection(sessionKey: string): void {
  const store = load();
  if (!(sessionKey in store)) return;
  delete store[sessionKey];
  cache = store;
  persist(store);
}

/** Nur fuer Tests: erzwingt ein Neulesen von der Platte. */
export function resetSelectionCache(): void {
  cache = null;
}

export function selectionFilePath(): string {
  return FILE;
}
