/**
 * Regressionstests fuer die einheitliche Modellauswahl.
 *
 * WARUM ES DIESE DATEI GIBT
 * -------------------------
 * Zwei Defekte sollen nicht zurueckkommen:
 *
 * 1. **Hartkodierte Modell-Listen driften.** `/model` kannte drei fest eingetippte
 *    Claude-Namen, `OLLAMA_MODELS` listete 5 Modelle waehrend 7 installiert waren.
 *    Dieselbe Klasse Fehler liess den Master fuenf Monate auf einer Februar-Engine
 *    laufen. Der Katalog muss deshalb live abfragen, was live abfragbar ist.
 *
 * 2. **Die Auswahl ueberlebte keinen Neustart.** Sie lag nur in Modul-Level-Maps.
 *    Nach jedem Restart sprach der Nutzer wieder mit dem Default — ohne Hinweis.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-modelsel-'));

before(() => {
  process.env.DATA_DIR = tmpDir;
  process.env.BOT_NAME = 'selectiontest';
  process.env.TELEGRAM_BOT_TOKEN ??= 'test';
  process.env.ALLOWED_USER_IDS ??= '1';
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Modell-Katalog', () => {
  it('fuehrt Claude, Codex und lokale Modelle in EINER Liste', async () => {
    const { buildCatalog } = await import('../src/engines/model-catalog.js');
    const catalog = await buildCatalog();

    assert.ok(catalog.claude.length >= 3, 'Claude-Eintraege fehlen');
    assert.ok(catalog.codex.length >= 1, 'Codex-Profile fehlen');
    // Lokale duerfen leer sein (Ollama nicht erreichbar) — dann MUSS das Flag stimmen,
    // damit das Menue es ehrlich anzeigt statt stillschweigend nichts zu zeigen.
    assert.equal(catalog.localUnavailable, catalog.local.length === 0);
  });

  it('bietet die neuen Claude-Generationen an, die der Nutzer verlangt hat', async () => {
    const { claudeEntries } = await import('../src/engines/model-catalog.js');
    const models = claudeEntries().map((e) => e.model);
    for (const wanted of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5']) {
      assert.ok(models.includes(wanted), `${wanted} fehlt im Katalog`);
    }
  });

  it('markiert ehrlich, welche Modelle die geladene Engine nicht nativ kennt', async () => {
    const { claudeEntries } = await import('../src/engines/model-catalog.js');
    const byModel = new Map(claudeEntries().map((e) => [e.model, e]));
    // Das Alias kennt jede Engine; die neue Generation nicht — genau das muss sichtbar sein,
    // sonst verspricht das Menue ein 1M-Fenster, das der Bot gar nicht bekommt.
    assert.equal(byModel.get('opus')?.nativelyKnown, true);
    assert.equal(byModel.get('claude-opus-5')?.nativelyKnown, false);
  });

  it('vergibt eindeutige Callback-IDs unter dem Telegram-Limit von 64 Byte', async () => {
    const { buildCatalog } = await import('../src/engines/model-catalog.js');
    const catalog = await buildCatalog();
    const all = [...catalog.claude, ...catalog.codex, ...catalog.local];
    const ids = all.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'doppelte Callback-IDs');
    for (const id of ids) {
      assert.ok(Buffer.byteLength(`model:${id}`) <= 64, `callback_data zu lang: ${id}`);
    }
  });

  it('akzeptiert genau die Effort-Stufen, die die geladene Engine kennt', async () => {
    const { isEffortLevel, SUPPORTED_EFFORTS } = await import('../src/engines/model-catalog.js');
    for (const lvl of SUPPORTED_EFFORTS) assert.ok(isEffortLevel(lvl));
    // 'xhigh' ist in der gebuendelten Engine 2.1.63 nicht vorhanden (gemessen: 0 Treffer).
    // Es anzubieten waere ein Versprechen, das der Bot nicht halten kann.
    assert.equal(isEffortLevel('xhigh'), false);
    assert.equal(isEffortLevel('turbo'), false);
    // 'max' stand im Engine-Bundle und wurde deshalb angeboten — die Laufzeit lehnt es
    // fuer Claude.ai-Abos aber ab und brach JEDEN Turn mit Exit 1 ab (2026-08-03).
    // Ein Knopf, den das Abo nicht kann, darf nicht im Menue stehen.
    assert.equal(isEffortLevel('max'), false);
    assert.equal(SUPPORTED_EFFORTS.includes('max' as never), false);
  });
});

describe('Auswahl ueberlebt den Neustart', () => {
  it('schreibt und liest Modell plus Effort ueber einen Prozessneustart hinweg', async () => {
    const mod = await import('../src/engines/selection-store.js');
    mod.setStoredSelection('chat-42', { engine: 'anthropic', model: 'claude-opus-5' });
    mod.setStoredSelection('chat-42', { effort: 'max' });

    // Neustart simulieren: Cache verwerfen, von der Platte lesen.
    mod.resetSelectionCache();
    const restored = mod.getStoredSelection('chat-42');

    assert.equal(restored.model, 'claude-opus-5');
    assert.equal(restored.effort, 'max');
    assert.equal(restored.engine, 'anthropic');
    assert.ok(restored.updatedAt, 'Zeitstempel fehlt');
  });

  it('haelt verschiedene Chats getrennt', async () => {
    const mod = await import('../src/engines/selection-store.js');
    mod.setStoredSelection('chat-a', { model: 'sonnet' });
    mod.setStoredSelection('chat-b', { model: 'qwen3:14b', engine: 'ollama' });
    mod.resetSelectionCache();

    assert.equal(mod.getStoredSelection('chat-a').model, 'sonnet');
    assert.equal(mod.getStoredSelection('chat-b').engine, 'ollama');
  });

  it('ueberlebt eine beschaedigte Auswahldatei, statt den Start zu verhindern', async () => {
    const mod = await import('../src/engines/selection-store.js');
    fs.writeFileSync(mod.selectionFilePath(), '{ das ist kein JSON', 'utf-8');
    mod.resetSelectionCache();

    // Darf NICHT werfen — eine kaputte Komfortdatei ist kein Grund, den Bot zu stoppen.
    assert.deepEqual(mod.getStoredSelection('egal'), {});
    mod.setStoredSelection('egal', { model: 'haiku' });
    mod.resetSelectionCache();
    assert.equal(mod.getStoredSelection('egal').model, 'haiku');
  });

  it('legt die Auswahldatei nur fuer den Besitzer lesbar an', async () => {
    const mod = await import('../src/engines/selection-store.js');
    mod.setStoredSelection('chat-perm', { model: 'opus' });
    const mode = fs.statSync(mod.selectionFilePath()).mode & 0o777;
    assert.equal(mode, 0o600, `Dateimodus ${mode.toString(8)} statt 600`);
  });
});

describe('Rollen-Gate: Personen-Bots duerfen keine Engine wechseln', () => {
  it('haelt Codex und lokale Modelle aus dem Katalog fern, wenn der Bot kein Master ist', async () => {
    // Regression: das vereinheitlichte /model-Menue hatte die Sperre kurzzeitig ausgehebelt.
    // `/engine` und `/codex` sind in bot.ts bewusst nur fuer den Master registriert — das
    // Menue darf daran nicht vorbeifuehren, sonst kann jede Personen-Instanz die Engine
    // umschalten und damit Kosten und Datenwege veraendern.
    const { buildCatalog, scopeCatalogForRole } = await import('../src/engines/model-catalog.js');
    const full = await buildCatalog();

    // Die ECHTE Gate-Funktion, nicht eine Nachbildung — sonst testet der Test sich selbst.
    const scoped = scopeCatalogForRole(full, false);
    const asMaster = scopeCatalogForRole(full, true);

    assert.ok(scoped.claude.length > 0, 'Claude muss auch fuer Personen-Bots waehlbar bleiben');
    assert.equal(scoped.codex.length, 0, 'Codex darf fuer Nicht-Master nicht erscheinen');
    assert.equal(scoped.local.length, 0, 'lokale Modelle duerfen fuer Nicht-Master nicht erscheinen');

    // Und der Master sieht weiterhin alles.
    assert.ok(asMaster.codex.length > 0, 'Master muss Codex sehen');
    assert.equal(asMaster.local.length, full.local.length, 'Master darf nichts verlieren');
  });
});
