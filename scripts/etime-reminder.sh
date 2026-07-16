#!/usr/bin/env bash
# etime-reminder.sh — DHL-Zeiterfassungs-Erinnerung via Telegram
# Wiederhergestellt 2026-07-11 (Original beim NexusGram-Umbau verloren, Exit 127 seit Wochen;
# HR-Warnung 26.06. = Null-Toleranz, tägliche Buchung + eTime freitags Pflicht).
# Aufrufer: com.nexus.etime-friday (Fr 16:30) + com.nexus.etime-sunday (So 17:00)
set -euo pipefail
PING="/Volumes/AstronOne/NEXUS_miniM_13-03-26/scripts/dirigent/telegram-ping.sh"
DAY="$(date +%u)"
if [[ "$DAY" == "5" ]]; then
  MSG="⏰ eTime-Erinnerung: Heute (Freitag) eTime ausfüllen + Wochenbuchungen prüfen! (HR-Null-Toleranz seit 26.06.)"
else
  MSG="⏰ Wochen-Check: Arbeitszeiten der Woche vollständig gebucht? Morgen beginnt die neue Woche. (HR-Null-Toleranz)"
fi
exec "$PING" --strict "$MSG"
