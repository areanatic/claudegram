# Voice Enhancement Handoff — Claude Code Session Prompt

**Kopiere alles ab hier in eine neue Claude Code Session auf dem Mac Mini:**

---

## KONTEXT: Was wurde gemacht

Wir haben auf dem Branch `feature/voice-enhancement` ein Voice-First Enhancement für Claudegram implementiert. Der Branch ist auf GitHub gepusht und muss hier auf dem Mac Mini gezogen und getestet werden.

### Was implementiert wurde (Track 1 — Telegram Voice Enhancement):

**9 Dateien geändert, +153/-19 Zeilen, TypeScript kompiliert fehlerfrei:**

1. **`src/audio/transcribe.ts`** — Neues `transcribeFileWithLanguage()` mit Auto-Detect via Whisper `verbose_json` Format. Gibt `{text, language}` zurück statt nur `string`. Die alte `transcribeFile()` delegiert an die neue Funktion.

2. **`src/tts/tts-settings.ts`** — Neue Felder: `voiceFirstMode: boolean` und `detectedLanguage: string` im TTSSettings Interface. Neue Funktionen: `isVoiceActive()` (prüft enabled ODER voiceFirstMode), `activateVoiceFirstMode(sessionKey, language)`, `deactivateVoiceFirstMode(sessionKey)`, `getDetectedLanguage(sessionKey)`.

3. **`src/claude/agent.ts`** — Neues `voiceMode?: boolean` in AgentOptions. Neuer `VOICE_MODE_PROMPT` Constant der Claude anweist: kurz antworten, gleiche Sprache wie User, kein Markdown, natürlich sprechen. System Prompt wird conditional erweitert: `voiceMode ? SYSTEM_PROMPT + VOICE_MODE_PROMPT : SYSTEM_PROMPT`.

4. **`src/tts/tts.ts`** — `generateSpeech()` hat neuen `language?: string` Parameter. Wenn Sprache nicht Englisch UND Provider ist Groq → automatischer Fallback auf OpenAI TTS (Groq Orpheus kann nur Englisch).

5. **`src/tts/voice-reply.ts`** — Nutzt jetzt `isVoiceActive()` statt `isTTSEnabled()`. Holt `getDetectedLanguage()` und gibt es an `generateSpeech()` weiter. Format-Detection berücksichtigt den OpenAI-Fallback.

6. **`src/bot/handlers/voice.handler.ts`** — Nutzt `transcribeFileWithLanguage()` statt `transcribeFile()`. Aktiviert Voice-First Mode nach Transkription wenn `VOICE_FIRST_MODE_ENABLED=true`. Übergibt `voiceMode: true` an `sendToAgent()`.

7. **`src/bot/handlers/message.handler.ts`** — Ruft `deactivateVoiceFirstMode(sessionKey)` auf wenn User Text tippt (= User hat von Voice zu Text gewechselt).

8. **`src/config.ts`** — Zwei neue ENV-Variablen: `VOICE_AUTO_DETECT` (default: true) und `VOICE_FIRST_MODE_ENABLED` (default: true).

9. **`docs/index.html`** — Neue Feature-Card "Voice-First Mode" und aktualisierte Voice Transcription Beschreibung.

### Was sich für den User ändert:
- 🎤 Voice Note senden → Sprache wird **automatisch erkannt** (DE/EN/etc.)
- 🔊 TTS aktiviert sich **automatisch** (kein `/tts` nötig)
- 🗣️ Claude antwortet **kurz, natürlich, ohne Markdown**
- 🌍 Nicht-englische Voice → **automatisch OpenAI TTS** (Groq ist nur Englisch)
- ⌨️ Text tippen → Voice-First Mode **deaktiviert sich automatisch**

### Track 2 (nexus-voice-call) — nur Projekt-Struktur erstellt:
Separates Projekt unter `/Users/az/Development/nexus-voice-call/` mit Pipecat + LiveKit Skeleton. Noch nicht funktional, nur Boilerplate. Ist NICHT auf GitHub, nur lokal auf dem MacBook Pro.

---

## AUFGABE: Was jetzt zu tun ist

### Schritt 1: Branch ziehen
```bash
cd /pfad/zu/claudegram   # <-- der Pfad wo claudegram auf dem Mac Mini liegt
git fetch origin
git checkout feature/voice-enhancement
```

### Schritt 2: ENV-Variablen hinzufügen
In der bestehenden `.env` auf dem Mac Mini diese zwei Zeilen ergänzen (falls nicht vorhanden):
```
VOICE_AUTO_DETECT=true
VOICE_FIRST_MODE_ENABLED=true
```

### Schritt 3: Dependencies prüfen
```bash
npm install
npx tsc --noEmit  # muss fehlerfrei kompilieren
```

### Schritt 4: Bot neustarten und testen
```bash
npm run dev
```

Dann im Telegram:
1. Eine Voice Note senden (deutsch oder englisch)
2. Prüfen ob: Sprache auto-detected wird (Log: `[Voice] Auto-detected language: de`)
3. Prüfen ob: Voice-First Mode aktiviert wird (Log: `[TTS] Voice-First Mode activated`)
4. Prüfen ob: Claude kurz und natürlich antwortet (kein Markdown)
5. Prüfen ob: TTS-Antwort als Voice Note kommt
6. Text tippen → prüfen ob Voice-First Mode deaktiviert wird (Log: `[TTS] Voice-First Mode deactivated`)

### Schritt 5: Wenn alles funktioniert
- Testen mit verschiedenen Sprachen (DE, EN, etc.)
- Bei nicht-Englisch: prüfen ob OpenAI TTS Fallback greift (braucht OPENAI_API_KEY in .env)
- Wenn zufrieden: Branch mergen oder PR erstellen

### WICHTIG — Sandbox-Strategie:
- Der `feature/voice-enhancement` Branch ist NICHT in main gemerged
- Die bestehende Production auf dem Mac Mini (main branch) wird NICHT berührt
- Erst nach erfolgreichem Test mergen

### GitHub Repo:
- URL: `https://github.com/areanatic/claudegram`
- Branch: `feature/voice-enhancement`
- Commit: `02b85e5` — "feat: add Voice-First Mode with auto-detect language and voice-optimized responses"

### Bekannter Testbot:
Auf dem MacBook Pro lief ein Testbot `@NexusOneVoiceBot` (Token: in der .env auf dem MacBook). Der muss gestoppt werden bevor der Mac Mini Bot mit demselben Token startet, oder der Mac Mini nutzt seinen eigenen Bot/Token.
