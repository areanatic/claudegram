/**
 * Runtime-Truth: was laeuft hier WIRKLICH?
 *
 * Hintergrund (2026-07-28): Der Master lief fuenf Monate lang auf der im SDK
 * gebuendelten Claude-Code-Engine 2.1.63 vom 2026-02-28, waehrend lokal 2.1.205
 * installiert war. Folge: 200k statt 1M Kontext, die konfigurierte Effort-Stufe
 * existierte in dieser Engine gar nicht, und die gepinnte Modell-ID war ihr
 * unbekannt. Es ist niemandem aufgefallen, weil die Engine-Version NIRGENDS
 * ausgegeben wurde und es keinen Soll-Wert gab, gegen den irgendetwas verglichen
 * haette werden koennen. Ein Versionsstand, der nicht verglichen wird, ist Deko.
 *
 * Zusaetzliche Falle: package.json pinnt das SDK mit einer Caret-Range. Die
 * erlaubt nur Patch-/Minor-Spruenge innerhalb derselben Nuller-Minor. Eine neuere
 * gebuendelte Engine kommt in einer hoeheren Version und wird damit von genau
 * dieser Schreibweise blockiert — `npm update` laeuft erfolgreich durch und
 * aendert nichts. Deshalb muss die Abweichung aktiv gemeldet werden.
 *
 * Dieses Modul sammelt den tatsaechlichen Laufzeitstand und vergleicht ihn gegen
 * `runtime-expected.json`. Es wirft nie und blockiert den Boot nicht.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RuntimeTruth {
  botName: string;
  botRole: string;
  model: string;
  sdkPackageVersion: string | null;
  engineVersion: string | null;
  engineBuildDate: string | null;
  artifactDir: string;
  buildCommit: string | null;
  nodeVersion: string;
}

export interface RuntimeExpectation {
  engineVersion?: string;
  sdkPackageVersion?: string;
  model?: string;
  /** Aeltestes noch akzeptiertes Build-Datum der gebuendelten Engine (ISO). */
  engineBuildDateNotBefore?: string;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Sucht das SDK-Paket ausgehend vom Artefakt und vom Arbeitsverzeichnis. */
function findSdkDir(artifactDir: string): string | null {
  const rel = path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const roots = [artifactDir, path.dirname(artifactDir), path.dirname(path.dirname(artifactDir)), process.cwd()];
  for (const root of roots) {
    const candidate = path.join(root, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readBuildCommit(artifactDir: string): string | null {
  const buildInfo = readJsonSafe(path.join(artifactDir, 'BUILD_INFO.json'));
  const sha = buildInfo?.commit_sha;
  if (typeof sha === 'string' && sha.length > 0) return sha;
  try {
    const legacy = path.join(artifactDir, '.build-commit');
    if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf8').trim() || null;
  } catch {
    /* ignore */
  }
  return null;
}

export function collectRuntimeTruth(input: {
  botName: string;
  botRole: string;
  model: string;
  artifactDir: string;
}): RuntimeTruth {
  const sdkDir = findSdkDir(input.artifactDir);
  const sdkPkg = sdkDir ? readJsonSafe(path.join(sdkDir, 'package.json')) : null;
  const manifest = sdkDir ? readJsonSafe(path.join(sdkDir, 'manifest.json')) : null;

  return {
    botName: input.botName,
    botRole: input.botRole,
    model: input.model,
    sdkPackageVersion: typeof sdkPkg?.version === 'string' ? sdkPkg.version : null,
    engineVersion: typeof manifest?.version === 'string' ? manifest.version : null,
    engineBuildDate: typeof manifest?.buildDate === 'string' ? manifest.buildDate : null,
    artifactDir: input.artifactDir,
    buildCommit: readBuildCommit(input.artifactDir),
    nodeVersion: process.version,
  };
}

/** Vergleicht Ist gegen Soll. Leeres Ergebnis = keine Abweichung. */
export function diffRuntimeTruth(truth: RuntimeTruth, expected: RuntimeExpectation): string[] {
  const drift: string[] = [];
  if (expected.engineVersion && truth.engineVersion !== expected.engineVersion) {
    drift.push(`Engine ${truth.engineVersion ?? 'unbekannt'} statt erwartet ${expected.engineVersion}`);
  }
  if (expected.sdkPackageVersion && truth.sdkPackageVersion !== expected.sdkPackageVersion) {
    drift.push(`SDK-Paket ${truth.sdkPackageVersion ?? 'unbekannt'} statt erwartet ${expected.sdkPackageVersion}`);
  }
  if (expected.model && truth.model !== expected.model) {
    drift.push(`Modell ${truth.model} statt erwartet ${expected.model}`);
  }
  if (expected.engineBuildDateNotBefore && truth.engineBuildDate) {
    const actual = Date.parse(truth.engineBuildDate);
    const floor = Date.parse(expected.engineBuildDateNotBefore);
    if (Number.isFinite(actual) && Number.isFinite(floor) && actual < floor) {
      const days = Math.round((floor - actual) / 86_400_000);
      drift.push(
        `Engine-Build ${truth.engineBuildDate.slice(0, 10)} ist ${days} Tage aelter als die Untergrenze ${expected.engineBuildDateNotBefore.slice(0, 10)}`,
      );
    }
  }
  return drift;
}

/**
 * Gibt den Laufzeitstand aus und meldet Abweichungen laut.
 * Wirft nie — ein Diagnosemodul darf den Boot nicht verhindern.
 */
export function reportRuntimeTruth(input: {
  botName: string;
  botRole: string;
  model: string;
  artifactDir: string;
  expectedFile?: string;
}): RuntimeTruth | null {
  try {
    const truth = collectRuntimeTruth(input);

    console.log(
      `[Runtime] bot=${truth.botName} role=${truth.botRole} model=${truth.model} ` +
        `engine=${truth.engineVersion ?? 'unbekannt'} (build ${truth.engineBuildDate?.slice(0, 10) ?? 'unbekannt'}) ` +
        `sdk=${truth.sdkPackageVersion ?? 'unbekannt'} node=${truth.nodeVersion} ` +
        `commit=${truth.buildCommit ?? 'unbekannt'} artifact=${truth.artifactDir}`,
    );

    const expectedFile = input.expectedFile ?? path.join(process.cwd(), 'runtime-expected.json');
    const expected = readJsonSafe(expectedFile) as RuntimeExpectation | null;

    if (!expected) {
      console.warn(
        `[Runtime] Kein Soll-Wert gefunden (${expectedFile}). Der Laufzeitstand wird ausgegeben, ` +
          'aber NICHT geprueft — genau so blieb die Februar-Engine fuenf Monate unbemerkt.',
      );
      return truth;
    }

    const drift = diffRuntimeTruth(truth, expected);
    if (drift.length === 0) {
      console.log('[Runtime] Soll-Ist-Vergleich: OK');
      return truth;
    }

    console.error(`[Runtime] ⚠️ ABWEICHUNG vom erwarteten Laufzeitstand (${drift.length}):`);
    for (const line of drift) console.error(`[Runtime]   - ${line}`);
    console.error('[Runtime] Erwartung pflegen in ' + expectedFile + ' — oder den Stand angleichen.');
    return truth;
  } catch (error) {
    console.warn('[Runtime] Laufzeitstand konnte nicht ermittelt werden:', error instanceof Error ? error.message : error);
    return null;
  }
}
