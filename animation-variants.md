# Telegram Bot Animation Varianten

## Variante 1: ⚡ Blitz (schnell & energisch)
```
Emoji: ⚡
Text: "Denke nach..."
Spinner: ←↖↑↗→↘↓↙ (Pfeile im Kreis)
Speed: 150ms pro Frame
```

## Variante 2: 🧠 Gehirn (intelligent)
```
Emoji: 🧠
Text: "Prozessiere..."
Spinner: ◐◓◑◒ (Kreis dreht)
Speed: 200ms pro Frame
```

## Variante 3: 🔄 Reload (technisch)
```
Emoji: 🔄
Text: "Arbeite..."
Spinner: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ (Braille - aktuell)
Speed: 100ms pro Frame (schneller)
```

## Variante 4: 🤖 Robot (AI-Style)
```
Emoji: 🤖
Text: "Berechne..."
Spinner: ▁▂▃▄▅▆▇█▇▆▅▄▃▂ (Audio-Bars)
Speed: 120ms pro Frame
```

## Variante 5: 💫 Sterne (smooth & modern)
```
Emoji: 💫
Text: "Moment..."
Spinner: ✶✸✹✺✹✸ (Stern pulsiert)
Speed: 180ms pro Frame
```

## Implementierung

Jede Variante braucht Änderungen in:
1. `src/telegram/terminal-renderer.ts` (Emoji + Spinner)
2. `src/telegram/message-sender.ts` (Text + Speed)

### Code-Locations:
- **Emoji:** Zeile 29 in `terminal-renderer.ts`
- **Text:** Zeile 173, 315 in `message-sender.ts`
- **Spinner:** Zeile 36-40 in `terminal-renderer.ts`
- **Speed:** Spinner Interval (aktuell nicht explizit gesetzt, vermutlich ~500ms)

## Wie konfigurieren?

In `.env` einfach hinzufügen/ändern:

```bash
# Variante 1: Lightning
ANIMATION_VARIANT=lightning
ANIMATION_TEXT=Denke nach...
ANIMATION_SPEED=150

# Variante 2: Brain (AKTUELL AKTIV)
ANIMATION_VARIANT=brain
ANIMATION_TEXT=Denke nach...
ANIMATION_SPEED=200

# Variante 3: Reload
ANIMATION_VARIANT=reload
ANIMATION_TEXT=Arbeite...
ANIMATION_SPEED=100

# Variante 4: Robot
ANIMATION_VARIANT=robot
ANIMATION_TEXT=Berechne...
ANIMATION_SPEED=120

# Variante 5: Stars
ANIMATION_VARIANT=stars
ANIMATION_TEXT=Moment...
ANIMATION_SPEED=180

# Custom Text (überschreibt Default)
ANIMATION_TEXT=Deine eigene Nachricht...
```

Nach Änderung: `pm2 restart claudegram` oder `npm run dev`

## Implementiert! ✅

Code geändert in:
- `src/telegram/terminal-renderer.ts` - Animation Varianten
- `src/telegram/message-sender.ts` - Dynamic text + emoji
- `.env` - Brain Variante als Standard

Aktuell läuft: **◐◓◑◒ 🧠 Denke nach...**
