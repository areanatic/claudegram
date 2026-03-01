# Voice Enhancement — Vollständiger Plan & Kontext

## Ausgangslage & Sparring

### Was der User wollte
Der User wollte **kein Voice-Note-Ping-Pong** optimieren, sondern ein **echtes Telefongespräch** mit Claude:
- Live sprechen, unterbrechen können ("stopp!", "halt!", "kürzer bitte!")
- Natürliche Sprache, kein abgelesener Text
- Nach dem Gespräch: automatische Zusammenfassung + Dateien über Telegram
- Plattform: Telegram-Anruf oder echte Telefonleitung

### Erkenntnis
Das ist **fundamental anders** als Voice Notes optimieren. Deshalb zwei Tracks:
- **Track 1 (Quick Win):** Telegram Voice Notes so gut wie möglich machen
- **Track 2 (Das echte Ziel):** Eigenes Real-Time Voice Call System

---

## Research: Real-Time Voice AI Plattformen

### Ergebnis der Recherche

| Plattform | Typ | Claude-Support | Kosten | Bemerkung |
|-----------|-----|----------------|--------|-----------|
| **Pipecat** | Open-Source Framework | ✅ | Kostenlos + API-Kosten | Bestes Framework für Custom-Pipelines |
| **LiveKit** | Open-Source WebRTC | ✅ | Self-hosted auf Mac Mini | Perfekt für lokales Hosting |
| **Twilio** | Echte Telefonnummer | ✅ | ~$0.01/min | Für echte Anrufe über Telefonnetz |
| **Vapi.ai** | Managed Platform | ✅ | ~$0.13-0.31/min | Einfachster Setup, teuerster Betrieb |

### Empfehlung
**Pipecat + LiveKit** auf dem Mac Mini:
- Volle Kontrolle, kein Vendor Lock-in
- Kosten nur für API-Calls (STT/LLM/TTS): ~$0.05-0.11/min
- Interruption-Support nativ in Pipecat
- WebRTC für Browser-basierte Calls

---

## Track 1: Telegram Voice Enhancement (IMPLEMENTIERT ✅)

### Architektur-Änderungen

```
VORHER:
User Voice → Whisper (fix EN) → Transcript → Claude (normal) → Text → [optional TTS wenn /tts an]

NACHHER:
User Voice → Whisper (auto-detect lang) → Transcript + Language
  → Claude (voiceMode: kurz, natürlich, gleiche Sprache)
  → Text → Auto-TTS (Voice-First Mode)
  → Bei nicht-EN: Fallback OpenAI TTS (Groq nur EN)
User tippt Text → Voice-First Mode deaktiviert sich
```

### Geänderte Dateien (9 Dateien, +153/-19 Zeilen)

#### 1. `src/audio/transcribe.ts`
- Neues Interface `TranscribeResult { text: string; language: string }`
- Neue Funktion `transcribeFileWithLanguage()`:
  - Wenn `VOICE_AUTO_DETECT=true`: nutzt `verbose_json` Format ohne `language` Parameter → Whisper erkennt Sprache automatisch
  - Wenn `VOICE_AUTO_DETECT=false`: nutzt altes Verhalten mit fixem `VOICE_LANGUAGE`
- Alte `transcribeFile()` delegiert an neue Funktion (Backward-Compatible)

#### 2. `src/tts/tts-settings.ts`
- Neue Felder im Interface: `voiceFirstMode: boolean`, `detectedLanguage: string`
- `isVoiceActive(sessionKey)`: Gibt `true` wenn TTS manuell enabled ODER voiceFirstMode aktiv
- `activateVoiceFirstMode(sessionKey, language)`: Setzt voiceFirstMode=true + speichert Sprache
- `deactivateVoiceFirstMode(sessionKey)`: Setzt voiceFirstMode=false (wenn User Text tippt)
- `getDetectedLanguage(sessionKey)`: Gibt gespeicherte Sprache zurück

#### 3. `src/claude/agent.ts`
- `AgentOptions` erweitert um `voiceMode?: boolean`
- Neuer `VOICE_MODE_PROMPT` Constant:
  - Gleiche Sprache wie User
  - 2-4 Sätze max
  - Kein Markdown
  - Natürlich wie ein Kollege
  - Bei komplexen Antworten: kurze Zusammenfassung verbal, Details als Text anbieten
- System Prompt wird conditional: `voiceMode ? SYSTEM_PROMPT + VOICE_MODE_PROMPT : SYSTEM_PROMPT`

#### 4. `src/tts/tts.ts`
- `generateSpeech()` hat neuen `language?: string` Parameter
- Logik: Wenn Provider=groq UND Sprache≠en UND OPENAI_API_KEY vorhanden → Fallback auf OpenAI
- Warnung wenn nicht-EN aber kein OpenAI Key → versucht Groq trotzdem

#### 5. `src/tts/voice-reply.ts`
- `isVoiceActive()` statt `isTTSEnabled()` → respektiert Voice-First Mode
- Holt `getDetectedLanguage()` und gibt es an `generateSpeech()` weiter
- Format-Detection berücksichtigt OpenAI-Fallback (groq→ogg, openai→config format)

#### 6. `src/bot/handlers/voice.handler.ts`
- Nutzt `transcribeFileWithLanguage()` statt `transcribeFile()`
- Nach Transkription: `activateVoiceFirstMode(sessionKey, detectedLanguage)` wenn Config enabled
- Übergibt `voiceMode: true` an `sendToAgent()` in beiden Flows (streaming + wait)

#### 7. `src/bot/handlers/message.handler.ts`
- Import von `deactivateVoiceFirstMode`
- Ruft `deactivateVoiceFirstMode(sessionKey)` auf bei jedem Text-Input
- Position: direkt nach sessionKey Extraktion, vor allen anderen Checks

#### 8. `src/config.ts`
- `VOICE_AUTO_DETECT`: boolean, default `true` — Whisper Auto-Detect statt fixer Sprache
- `VOICE_FIRST_MODE_ENABLED`: boolean, default `true` — Auto-TTS bei Voice Input

#### 9. `docs/index.html`
- Neue Feature-Card "Voice-First Mode" in der Voice-Kategorie
- Aktualisierte "Voice Transcription" Beschreibung (auto-language detection, 50+ languages)

### Neue ENV-Variablen
```env
VOICE_AUTO_DETECT=true           # Whisper erkennt Sprache automatisch
VOICE_FIRST_MODE_ENABLED=true    # TTS aktiviert sich automatisch bei Voice Input
```

---

## Track 2: nexus-voice-call (GEPLANT — noch nicht implementiert)

### Architektur

```
nexus-voice-call/
├── src/
│   ├── pipeline.py          # Pipecat Pipeline: STT → Claude → TTS
│   ├── claude_brain.py      # Claude Agent mit Voice-Persona
│   └── actions/
│       └── telegram.py      # Post-Call: Summary + Dateien via Telegram
├── docker-compose.yml       # LiveKit Server
├── requirements.txt         # Python Dependencies
└── .env.example
```

### Pipeline-Flow
```
Mikrofon/Browser → WebRTC (LiveKit) → STT (Deepgram/Whisper)
    → Claude Brain (Anthropic API, voice-optimized)
    → TTS (OpenAI gpt-4o-mini-tts)
    → WebRTC (LiveKit) → Lautsprecher/Browser

Post-Call:
    → Conversation Summary → Telegram Bot
    → Relevante Links → Telegram Bot
    → Dateien/Code → Telegram Bot
```

### Key Features (geplant)
- **Interruption**: User kann jederzeit unterbrechen (Pipecat `allow_interruptions=True`)
- **Sprach-Detection**: Automatisch DE/EN
- **Post-Call Actions**: Zusammenfassung + Links über bestehenden Telegram Bot
- **Self-Hosted**: Alles auf dem Mac Mini, keine Cloud-Abhängigkeit außer APIs
- **Kosten**: ~$0.05-0.11/min (STT + LLM + TTS API-Kosten)

### Dependencies
- Pipecat (Python, Open-Source)
- LiveKit Server (Docker)
- Deepgram oder Groq Whisper (STT)
- Anthropic API (LLM)
- OpenAI TTS (Speech Output)
- python-telegram-bot (Post-Call Actions)

### Skeleton erstellt auf MacBook Pro
Auf dem MacBook Pro unter `/Users/az/Development/nexus-voice-call/` liegt ein Skeleton mit:
- `pipeline.py`, `claude_brain.py`, `actions/telegram.py`
- `docker-compose.yml`, `requirements.txt`, `.env.example`
- Noch nicht funktional, nur Boilerplate/Struktur

---

## Sandbox-Strategie

### Regel
- **Nichts an Production kaputt machen**
- Track 1: Git Branch `feature/voice-enhancement`, wird erst nach Test gemerged
- Track 2: Komplett separates Projekt, kann Production nicht berühren

### Test-Vorgehen
1. Branch auschecken auf Mac Mini
2. ENV-Variablen ergänzen
3. Bot starten im Dev-Modus
4. Voice Notes in verschiedenen Sprachen testen
5. Prüfen: Auto-Detect, Voice-First Mode, TTS-Antwort, Text-Deaktivierung
6. Bei Erfolg: Branch nach main mergen

### Rollback
Falls etwas nicht funktioniert:
```bash
git checkout main
# Bot ist sofort wieder im alten Zustand
```

---

## GitHub
- **Repo:** `https://github.com/areanatic/claudegram`
- **Branch:** `feature/voice-enhancement`
- **Commit:** `02b85e5` — "feat: add Voice-First Mode with auto-detect language and voice-optimized responses"
- **Branches auf GitHub:** main, feature/voice-enhancement, feature/telegraph-hybrid, fix/security-hardening-round2, claude/fix-telegram-latency-5BqCV
