export const MINI_TAP_REPLY =
  'Das war nur ein Sekundenbruchteil — wolltest du etwas sagen?';

const MINI_TAP_MAX_DURATION_SECONDS = 1;
const MINI_TAP_MIN_FILE_SIZE_BYTES = 8 * 1024; // allow-hardcoded: reason="fixe Mini-Tap-Untergrenze (Telegram-OGG unter ~8KB = Sekundenbruchteil-Fehltap, DIAGNOSE_master-voice-timeout); kein Tuning-Wert"

export interface VoiceMiniTapMetadata {
  duration?: number;
  fileSize?: number;
}

export interface VoiceMiniTapActions {
  markDropped: (reason: 'mini_tap') => void;
  interruptTask: (reason: 'mini_tap') => void;
  reply: (message: string) => Promise<unknown>;
}

/**
 * Telegram occasionally emits a sub-second recording after an accidental mic
 * tap. Do not send those clips to Whisper: short noise can be expanded into a
 * confident-looking transcript and then become durable memory.
 */
export function isMiniTapVoice(metadata: VoiceMiniTapMetadata): boolean {
  const durationIsMiniTap =
    typeof metadata.duration === 'number' &&
    Number.isFinite(metadata.duration) &&
    metadata.duration <= MINI_TAP_MAX_DURATION_SECONDS;
  const fileIsMiniTap =
    typeof metadata.fileSize === 'number' &&
    Number.isFinite(metadata.fileSize) &&
    metadata.fileSize < MINI_TAP_MIN_FILE_SIZE_BYTES;
  return durationIsMiniTap || fileIsMiniTap;
}

/**
 * Terminal pre-transcription gate. Returning true means the caller must stop:
 * the input is durably classified and the user has received the R31-safe reply.
 */
export async function handleMiniTapVoice(
  metadata: VoiceMiniTapMetadata,
  actions: VoiceMiniTapActions,
): Promise<boolean> {
  if (!isMiniTapVoice(metadata)) return false;
  actions.markDropped('mini_tap');
  actions.interruptTask('mini_tap');
  await actions.reply(MINI_TAP_REPLY);
  return true;
}
