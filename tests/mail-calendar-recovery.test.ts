import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMailCalendarRecoveryPrompt } from '../src/claude/mail-calendar-recovery.js';

test('mail/calendar account errors offer canonical accounts and an executable next step', () => {
  const prompt = buildMailCalendarRecoveryPrompt({
    localAccountLabels: ['work', 'private', 'work'],
    connectedServers: ['nexus-mail'],
    missingServers: ['workspace-google-rw'],
  });
  assert.match(prompt, /private, work/);
  assert.match(prompt, /mastor\.prime/);
  assert.match(prompt, /Konto nicht gefunden.*KEIN Endpunkt/);
  assert.match(prompt, /List-\/Aggregate-Tool ohne account-Filter/);
  assert.match(prompt, /welche Konten\/Tools weiterhin verfügbar/);
  assert.match(prompt, /nächsten ausführbaren Schritt/);
  assert.match(prompt, /\/health/);
});

test('mail/calendar recovery never retries mutations or exposes a raw provider error as the answer', () => {
  const prompt = buildMailCalendarRecoveryPrompt({ localAccountLabels: [] });
  assert.match(prompt, /Mutationen.*NIEMALS blind wiederholen/);
  assert.match(prompt, /Rohe Provider-, Python- oder MCP-Fehler nie/);
  assert.match(prompt, /Registry aktuell nicht lesbar/);
});
