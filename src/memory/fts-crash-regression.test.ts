/**
 * REGRESSION — memory search must NEVER crash on FTS5-special user input.
 *
 * Run: npx tsx src/memory/fts-crash-regression.test.ts
 *
 * Bug (live, dev1.err.log:1, OMI-conversation 2026-06-04 22:36 "schau in Memory nach"):
 *   an unsanitized MATCH 'OMI-Sync' → SqliteError: no such column: Sync.
 *   FTS5 reads a hyphenated token as `OMI` MINUS column `Sync`. The exception was
 *   swallowed to [] and the bot said "nothing found" although the memory existed.
 *
 * The RI-25 product seam must compile every user input as: quoted phrase first,
 * quoted OR-tokens only after zero phrase hits. No caller builds MATCH syntax.
 *
 * This test first proves the historical unsanitized ROT repro directly against the
 * throwaway FTS5 table, then proves both production search paths are green.
 * It also runs a deterministic 1,000-case fuzz corpus (fixed seed + classes).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-ftscrash-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
process.env.BOT_NAME = 'Nexusgram';

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ❌ FAIL: ${msg}`); }
}

const FILTER_PUBLIC = 'FILTER_PUBLIC_TARGET';
const FILTER_PRIVATE = 'FILTER_PRIVATE_MUST_STAY_HIDDEN';
const FILTER_EXCLUDED = 'FILTER_EXCLUDED_MUST_STAY_HIDDEN';
const FILTER_WRONG_PROJECT = 'FILTER_WRONG_PROJECT_MUST_STAY_HIDDEN';
const FILTER_WRONG_BOT = 'FILTER_WRONG_BOT_MUST_STAY_HIDDEN';

function seed(): { excludedId: number } {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('semantic','episodic')),
      content TEXT NOT NULL, source TEXT, project TEXT, tags TEXT,
      score REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
      last_accessed TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
      access_count INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.02,
      archived INTEGER NOT NULL DEFAULT 0, file_path TEXT,
      privacy TEXT NOT NULL DEFAULT 'public' CHECK(privacy IN ('public','private')),
      bot TEXT
    );
    CREATE INDEX idx_memories_bot ON memories(bot);
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, tags, project, content=memories, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, project)
      VALUES (new.id, new.content, new.tags, new.project);
    END;
  `);
  // A memory that contains the words OMI and Sync, but NOT the exact phrase "OMI-Sync Mai"
  // (so the phrase-pass returns 0 and the token-fallback runs — the crash path).
  const ins = db.prepare(`INSERT INTO memories (type, content, project) VALUES ('semantic', ?, 'test')`);
  ins.run('OMI Sync status: seit dem 24. Mai keine Sessions mehr extrahierbar, Workaround gebaut');
  ins.run('Auto Continue feature for voice timeouts works');
  ins.run('Cross Bot Awareness across the family');
  const scoped = db.prepare(`
    INSERT INTO memories (type, content, source, project, privacy, bot)
    VALUES ('semantic', ?, 'fixture', ?, ?, ?)
  `);
  scoped.run(`${FILTER_PUBLIC} Filter Alpha public target Beta evidence`, 'scope-target', 'public', 'Nexusgram');
  scoped.run(`${FILTER_PRIVATE} Filter Alpha private target Beta evidence`, 'scope-target', 'private', 'Nexusgram');
  const excluded = scoped.run(`${FILTER_EXCLUDED} Filter Alpha excluded target Beta evidence`, 'scope-target', 'public', 'Nexusgram');
  scoped.run(`${FILTER_WRONG_PROJECT} Filter Alpha other project Beta evidence`, 'scope-other', 'public', 'Nexusgram');
  scoped.run(`${FILTER_WRONG_BOT} Filter Alpha other bot Beta evidence`, 'scope-target', 'public', 'OtherBot');
  scoped.run('PRECISION_EXACT Precision Exact Phrase', 'precision', 'public', 'Nexusgram');
  scoped.run('PRECISION_BROAD Precision filler Exact filler Phrase', 'precision', 'public', 'Nexusgram');
  scoped.run('NFD_TARGET Müller provenance anchor', 'unicode', 'public', 'Nexusgram');
  db.close();
  return { excludedId: Number(excluded.lastInsertRowid) };
}
const { excludedId } = seed();

function directMatchCount(matchExpression: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all(matchExpression).length;
  } finally {
    db.close();
  }
}

console.log('\n=== historical ROT: unsanitized MATCH must prove the original crash ===');
let rotObserved = false;
try {
  directMatchCount('OMI-Sync');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  rotObserved = /no such column:\s*Sync/i.test(message);
  console.log(`  ${rotObserved ? '✅' : '❌'} ROT unsanitized historical fixture → ${message}`);
}
check(rotObserved, 'historical unsanitized MATCH OMI-Sync proves "no such column: Sync"');

// Import AFTER the historical ROT and temp seed. The module caches the configured DB path.
const { searchMemory, searchMemoryReadOnly } = await import('./nexus-memory.js');

function hasContent(rows: Array<{ content: string }>, fragment: string): boolean {
  return rows.some((row) => row.content.includes(fragment));
}

let unhandledTotal = 0;
let unhandledFts5 = 0;
function productNoThrow(label: string, query: string): void {
  for (const [pathName, search] of [
    ['searchMemoryReadOnly', () => searchMemoryReadOnly(query, 5)],
    ['searchMemory', () => searchMemory(query, 5)],
  ] as const) {
    try {
      const rows = search();
      check(Array.isArray(rows), `${pathName} returns an array for ${label}`);
    } catch (error) {
      unhandledTotal++;
      const message = error instanceof Error ? error.message : String(error);
      if (/fts5|no such column|syntax error|malformed match/i.test(message)) unhandledFts5++;
      check(false, `${pathName} threw for ${label}: ${message}`);
    }
  }
}

// Every one of these is a real thing a user types. NONE may throw.
const HOSTILE_QUERIES: Array<[string, string]> = [
  ['OMI-Sync Mai', 'hyphen → FTS5 reads as column-negation "no such column: Sync" (the live bug)'],
  ['Auto-Continue', 'hyphenated common project term'],
  ['Cross-Bot Awareness', 'hyphenated'],
  ['e-mail check', 'hyphenated everyday word'],
  ['Sync AND Mai', 'bare AND operator'],
  ['Sync OR Mai', 'bare OR operator'],
  ['NOT found here', 'bare NOT operator'],
  ['Sync NEAR Mai', 'bare NEAR operator'],
  ['status: Mai', 'colon → column-filter syntax'],
  ['@handle test', 'at-sign'],
  ['unbalanced " quote', 'lone double-quote'],
  ['wildcard*', 'trailing star'],
  ['^anchor', 'caret anchor'],
  ['(group) test', 'parens'],
  ['emoji 🚀 search', 'emoji mixed with words'],
  ['../../../tmp/memory.db', 'filesystem-like path'],
  ['   ', 'empty after trim → fail closed'],
  ['---', 'tokenless punctuation → fail closed'],
  ['\u0000', 'NUL control → fail closed'],
  ['\uD800', 'unpaired surrogate → fail closed'],
  ['x'.repeat(4097), 'over length budget → fail closed'],
];

console.log('\n=== FTS5 crash-regression: none of these user inputs may throw ===');
for (const [index, [q, why]] of HOSTILE_QUERIES.entries()) {
  productNoThrow(`hostile#${index}`, q);
  console.log(`  ✅ no-throw  hostile#${index} input_length=${q.length}  (${why})`);
}

console.log('\n=== product seam green: the historical query recalls through both paths ===');
const omiReadOnly = searchMemoryReadOnly('OMI-Sync Mai', 5);
const omiWritable = searchMemory('OMI-Sync Mai', 5);
check(hasContent(omiReadOnly, 'OMI Sync status'), 'searchMemoryReadOnly recalls OMI after phrase miss');
check(hasContent(omiWritable, 'OMI Sync status'), 'searchMemory recalls OMI after phrase miss');
console.log(`  ${hasContent(omiReadOnly, 'OMI Sync status') && hasContent(omiWritable, 'OMI Sync status') ? '✅' : '❌'} GREEN readOnly=${omiReadOnly.length} writable=${omiWritable.length}`);

console.log('\n=== fallback filter/parameter invariants ===');
const publicPolicy = { scope: 'public' as const, trustedPrivateSources: [] };
const filteredReadOnly = searchMemoryReadOnly('Filter-Alpha Beta', 20, 'scope-target', {
  policy: publicPolicy,
  originBot: 'Nexusgram',
  excludeMemoryIds: [excludedId],
});
check(hasContent(filteredReadOnly, FILTER_PUBLIC), 'read-only fallback keeps the allowed public row');
check(!hasContent(filteredReadOnly, FILTER_PRIVATE), 'read-only fallback keeps private row hidden');
check(!hasContent(filteredReadOnly, FILTER_EXCLUDED), 'read-only fallback preserves excludeMemoryIds');
check(!hasContent(filteredReadOnly, FILTER_WRONG_PROJECT), 'read-only fallback preserves project filter');
check(!hasContent(filteredReadOnly, FILTER_WRONG_BOT), 'read-only fallback preserves bot filter');
check(filteredReadOnly.length === 1, `read-only fallback returns exactly one allowed row (got ${filteredReadOnly.length})`);

const filteredWritable = searchMemory('Filter-Alpha Beta', 20, 'scope-target', false, 'Nexusgram');
check(hasContent(filteredWritable, FILTER_PUBLIC), 'writable fallback keeps the allowed public row');
check(hasContent(filteredWritable, FILTER_EXCLUDED), 'writable fallback keeps other allowed public row');
check(!hasContent(filteredWritable, FILTER_PRIVATE), 'writable fallback keeps private row hidden');
check(!hasContent(filteredWritable, FILTER_WRONG_PROJECT), 'writable fallback preserves project filter');
check(!hasContent(filteredWritable, FILTER_WRONG_BOT), 'writable fallback preserves bot filter');

console.log('\n=== phrase hit must suppress broad OR fallback ===');
const preciseReadOnly = searchMemoryReadOnly('Precision Exact Phrase', 20);
const preciseWritable = searchMemory('Precision Exact Phrase', 20);
check(preciseReadOnly.length === 1 && hasContent(preciseReadOnly, 'PRECISION_EXACT'),
  `read-only phrase hit suppresses fallback (rows=${preciseReadOnly.length})`);
check(preciseWritable.length === 1 && hasContent(preciseWritable, 'PRECISION_EXACT'),
  `writable phrase hit suppresses fallback (rows=${preciseWritable.length})`);
check(!hasContent(preciseReadOnly, 'PRECISION_BROAD') && !hasContent(preciseWritable, 'PRECISION_BROAD'),
  'broad token-only row stays absent when exact phrase matched');

console.log('\n=== Unicode NFD token recall ===');
const nfdReadOnly = searchMemoryReadOnly('Mu\u0308ller absent', 20);
const nfdWritable = searchMemory('Mu\u0308ller absent', 20);
check(hasContent(nfdReadOnly, 'NFD_TARGET'), 'read-only fallback preserves combining mark with base token');
check(hasContent(nfdWritable, 'NFD_TARGET'), 'writable fallback preserves combining mark with base token');

console.log('\n=== explicit fail-closed result assertions ===');
const REJECTED_QUERIES = [
  'OMI\uD83D',
  '\u001A',
  `${' '.repeat(4097)}x`,
] as const;
for (const [index, query] of REJECTED_QUERIES.entries()) {
  check(searchMemoryReadOnly(query, 5).length === 0, `read-only rejected#${index} returns []`);
  check(searchMemory(query, 5).length === 0, `writable rejected#${index} returns []`);
}

// Phrase-vs-safe-fallback recall accounting. The quoted phrase expressions are
// fixed baseline fixtures, not a second implementation of the product compiler.
const RECALL_CASES: ReadonlyArray<{ query: string; phraseExpression: string; expectedContent: string }> = [
  { query: 'OMI-Sync Mai', phraseExpression: '"OMI-Sync Mai"', expectedContent: 'OMI Sync status' },
  { query: 'Auto-Continue voice', phraseExpression: '"Auto-Continue voice"', expectedContent: 'Auto Continue feature' },
  { query: 'Cross-Bot family', phraseExpression: '"Cross-Bot family"', expectedContent: 'Cross Bot Awareness' },
];
let phraseZero = 0;
let expectedHit = 0;
let truePositive = 0;
let falseEmpty = 0;
for (const recallCase of RECALL_CASES) {
  const phraseHits = directMatchCount(recallCase.phraseExpression);
  if (phraseHits === 0) phraseZero++;
  expectedHit++;
  const rows = searchMemoryReadOnly(recallCase.query, 5);
  if (hasContent(rows, recallCase.expectedContent)) truePositive++;
  else falseEmpty++;
  check(phraseHits === 0, `phrase baseline misses ${recallCase.query} (forces fallback)`);
  check(hasContent(rows, recallCase.expectedContent), `safe fallback recalls ${recallCase.query}`);
}
console.log(`\n=== recall delta phrase-vs-fallback: cases=${RECALL_CASES.length} phrase_zero=${phraseZero} expected_hit=${expectedHit} TP=${truePositive} false_empty=${falseEmpty} ===`);

const FUZZ_SEED = 0x5EEDC0DE;
const FUZZ_TOTAL = 1000;
const FUZZ_CLASSES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['phrase', ['OMI', 'Sync', 'Mai', 'Alpha', 'Beta']],
  ['punctuation', ['...', '::', '()', '[]', '{}', '?!']],
  ['emoji', ['🚀', '🧪', '💾', '👩‍💻']],
  ['quotes', ['"', '""', '"AND"', 'unbalanced"']],
  ['operators', ['AND', 'OR', 'NOT', 'NEAR']],
  ['hyphen', ['OMI-Sync', 'Auto-Continue', 'e-mail', 'Cross-Bot']],
  ['paths', ['/tmp/a.db', '../memory.db', 'C:\\tmp\\memory.db', 'https://example.test/a?b=c']],
  ['empty-tokenless', ['', '   ', '---', '***', '🚀']],
  ['pathological', ['\u0000', '\uD800', 'x'.repeat(4097), '\u0001control']],
];

let fuzzState = FUZZ_SEED;
function nextFuzz(): number {
  fuzzState = (Math.imul(fuzzState, 1664525) + 1013904223) >>> 0;
  return fuzzState;
}

function fuzzPart(parts: readonly string[]): string {
  return parts[nextFuzz() % parts.length];
}

function buildFuzzQuery(index: number): string {
  const [kind, parts] = FUZZ_CLASSES[index % FUZZ_CLASSES.length];
  const left = fuzzPart(parts);
  const right = fuzzPart(parts);
  switch (kind) {
    case 'punctuation': return `OMI${left}Sync${right}Mai`;
    case 'emoji': return `${left} OMI ${right} Sync`;
    case 'quotes': return `${left} OMI ${right} Sync`;
    case 'operators': return `OMI ${left} Sync ${right} Mai`;
    case 'hyphen': return `${left} ${right} Mai`;
    case 'paths': return `${left} ${right}`;
    case 'empty-tokenless': return `${left}${right}`;
    case 'pathological': return left;
    default: return `${left} ${right} ${index}`;
  }
}

console.log(`\n=== deterministic FTS5 fuzz: seed=0x${FUZZ_SEED.toString(16)} classes=${FUZZ_CLASSES.map(([name]) => name).join(',')} ===`);
for (let index = 0; index < FUZZ_TOTAL; index++) {
  productNoThrow(`fuzz#${index}`, buildFuzzQuery(index));
}
check(unhandledFts5 === 0, `0 unhandled FTS5 exceptions across ${FUZZ_TOTAL * 2} product calls (got ${unhandledFts5})`);
check(unhandledTotal === 0, `0 unhandled total exceptions across ${FUZZ_TOTAL * 2} product calls (got ${unhandledTotal})`);
console.log(`  ${unhandledTotal === 0 && unhandledFts5 === 0 ? '✅' : '❌'} FUZZ total=${FUZZ_TOTAL} calls=${FUZZ_TOTAL * 2} unhandled_total=${unhandledTotal} unhandled_fts5=${unhandledFts5}`);

console.log('\n=== NaN limit remains bounded instead of silent-empty ===');
check(hasContent(searchMemoryReadOnly('OMI-Sync Mai', Number.NaN), 'OMI Sync status'),
  'read-only NaN limit falls back to the default limit');
check(hasContent(searchMemory('OMI-Sync Mai', Number.NaN), 'OMI Sync status'),
  'writable NaN limit falls back to the default limit');

console.log('\n=== rejected input performs no MATCH; error logs never contain query bytes ===');
const breaker = new Database(DB_PATH);
breaker.exec('DROP TABLE memories_fts');
breaker.close();

type SearchFailurePayload = {
  raw?: { length?: number; hmacSha256?: string | null };
  sanitized?: { tokenCount?: number; rejected?: boolean };
};
const capturedErrors: unknown[][] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => { capturedErrors.push(args); };
try {
  for (const [index, query] of REJECTED_QUERIES.entries()) {
    check(searchMemoryReadOnly(query, 5).length === 0, `read-only rejected#${index} stays [] with broken FTS table`);
    check(searchMemory(query, 5).length === 0, `writable rejected#${index} stays [] with broken FTS table`);
  }
  check(capturedErrors.length === 0,
    `rejected inputs return before MATCH/logging even when FTS table is absent (logs=${capturedErrors.length})`);

  const secretQuery = 'Secret-LowEntropy';
  searchMemoryReadOnly(secretQuery, 5);
  searchMemory(secretQuery, 5);
  check(capturedErrors.length === 2, `valid failing query emits one safe log per path (logs=${capturedErrors.length})`);
  const renderedLogs = JSON.stringify(capturedErrors);
  check(!renderedLogs.includes(secretQuery), 'safe failure logs exclude raw query bytes');
  check(!renderedLogs.includes(`"${secretQuery}"`), 'safe failure logs exclude compiled phrase bytes');
  const firstPayload = capturedErrors[0]?.[1] as SearchFailurePayload | undefined;
  check(firstPayload?.raw?.length === secretQuery.length, 'safe log retains raw length metadata');
  check(typeof firstPayload?.raw?.hmacSha256 === 'string' && firstPayload.raw.hmacSha256.length === 64,
    'safe log uses a 64-hex ephemeral HMAC rather than a stable raw digest');

  const repeatedQuery = `${'Repeat '.repeat(100)}Needle`;
  searchMemory(repeatedQuery, 5);
  const repeatedPayload = capturedErrors.at(-1)?.[1] as SearchFailurePayload | undefined;
  check(repeatedPayload?.sanitized?.tokenCount === 2,
    `fallback tokens are deduplicated before MATCH (got ${repeatedPayload?.sanitized?.tokenCount})`);

  const uniqueQuery = Array.from({ length: 100 }, (_, index) => `Token${index}`).join(' ');
  searchMemory(uniqueQuery, 5);
  const cappedPayload = capturedErrors.at(-1)?.[1] as SearchFailurePayload | undefined;
  check(cappedPayload?.sanitized?.tokenCount === 64,
    `fallback token count is capped at 64 (got ${cappedPayload?.sanitized?.tokenCount})`);
} finally {
  console.error = originalConsoleError;
}

console.log(`\n${fail === 0 ? '✅' : '❌'} FTS crash-regression: ${pass} passed, ${fail} failed, historical_ROT=${rotObserved ? 'observed' : 'missing'}, final_GREEN=${hasContent(omiReadOnly, 'OMI Sync status') && hasContent(omiWritable, 'OMI Sync status')}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
