import * as fs from 'fs';
import * as path from 'path';
import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
/**
 * Stage 2 Voice-Quality-Gate (2026-05-28): well-known Whisper-on-silence
 * hallucinations. Groq's whisper-large-v3-turbo returns `no_speech_prob=0.000`
 * even on a 1s silent OGG and just emits one of these short stock phrases.
 *
 * Two-tier matching (Codex Pattern-B Review Residual #3, Conf 0.74→0.80):
 *  - STRICT set: phrases that virtually never appear as legitimate short
 *    voice replies — reject at duration <1.5s.
 *  - AMBIGUOUS set: "bye" / "goodbye" / "thanks" can be a real short user
 *    utterance at ~1-1.4s — only reject when very short (<0.8s).
 *
 * "ok / ja / nein / ..." are NOT in here — those can be legitimate replies
 * (see Codex review §3 "Silent / kurzer legitimer User 'ok'").
 */
const STRICT_SHORT_SILENCE_HALLUCINATIONS = new Set([
    'thank you',
    'thank you for watching',
    'thank you for watching!',
    'thanks for watching',
    'thanks for watching!',
    'please subscribe',
    'please like and subscribe',
    'subscribe',
    'you',
    '.',
]);
const AMBIGUOUS_SHORT_UTTERANCES = new Set([
    'bye',
    'goodbye',
    'thanks',
]);
function isWhisperSilenceHallucination(text, durationSec) {
    const normalized = text.toLowerCase().replace(/[.!?,;:]+$/g, '').trim();
    if (durationSec < 1.5 && STRICT_SHORT_SILENCE_HALLUCINATIONS.has(normalized))
        return true;
    if (durationSec < 0.8 && AMBIGUOUS_SHORT_UTTERANCES.has(normalized))
        return true;
    return false;
}
/**
 * Stage 2 Voice-Quality-Gate: sliding n-gram repetition detector.
 *
 * Flags the Groq Whisper "Thank you for watching!"-style hallucinations that
 * surface when the input is silence/noise. Looks for short n-grams (1..4) that
 * either cover >=70% of the transcript or repeat >=4 times consecutively while
 * still covering >=50% — heuristic from Codex pre-review 2026-05-27.
 *
 * Legitimate utterances like "ja ja ja okay schick den Link" stay below the
 * 70% coverage threshold and are NOT flagged.
 */
function detectLoopHallucination(text) {
    const normalized = text.toLowerCase().replace(/[.,!?;:'"’…]+/g, ' ').trim();
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length < 8)
        return false;
    for (let n = 1; n <= 4; n++) {
        if (tokens.length < n * 4)
            break;
        const counts = new Map();
        for (let i = 0; i <= tokens.length - n; i++) {
            const ng = tokens.slice(i, i + n).join(' ');
            counts.set(ng, (counts.get(ng) ?? 0) + 1);
        }
        for (const [ng, count] of counts) {
            if (count < 4)
                continue;
            const coverage = (count * n) / tokens.length;
            if (coverage >= 0.7)
                return true;
            // Codex Pattern-B Review Residual #4 (2026-05-28): scan starting from
            // every offset 0..n-1 so a loop that begins at offset 1 (or 2,3) is also
            // detected. Plus a tokens.length>=10 guard for the 50%-coverage fallback
            // so legitimate short repetition like "ja ja ja ja okay schick den Link"
            // (8 tokens, 1-gram coverage 0.5, 4 consecutive 'ja') is NOT flagged as
            // hallucination.
            if (tokens.length < 10 && n === 1)
                continue;
            let maxConsecutive = 0;
            for (let offset = 0; offset < n; offset++) {
                let curr = 0;
                for (let i = offset; i <= tokens.length - n; i += n) {
                    if (tokens.slice(i, i + n).join(' ') === ng) {
                        curr++;
                        if (curr > maxConsecutive)
                            maxConsecutive = curr;
                    }
                    else {
                        curr = 0;
                    }
                }
            }
            if (maxConsecutive >= 4 && coverage >= 0.5)
                return true;
        }
    }
    return false;
}
/** Map Whisper's full language names to ISO 639-1 codes */
const LANGUAGE_NAME_TO_CODE = {
    english: 'en', german: 'de', spanish: 'es', french: 'fr',
    portuguese: 'pt', italian: 'it', dutch: 'nl', russian: 'ru',
    japanese: 'ja', chinese: 'zh', korean: 'ko', arabic: 'ar',
    turkish: 'tr', polish: 'pl', swedish: 'sv', norwegian: 'no',
    danish: 'da', finnish: 'fi', greek: 'el', czech: 'cs',
    romanian: 'ro', hungarian: 'hu', ukrainian: 'uk', hindi: 'hi',
    thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms',
    hebrew: 'he', persian: 'fa', catalan: 'ca', croatian: 'hr',
    slovak: 'sk', slovenian: 'sl', serbian: 'sr', bulgarian: 'bg',
    lithuanian: 'lt', latvian: 'lv', estonian: 'et',
};
function getGroqClient() {
    if (!config.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
    }
    return new OpenAI({
        apiKey: config.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
    });
}
/**
 * Transcribe an audio file with auto-detected language using verbose_json format.
 * Returns transcript text, detected language name, and ISO 639-1 code.
 */
export async function transcribeFileWithLanguage(filePath, options) {
    const groq = getGroqClient();
    const fileName = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);
    console.log(`[transcribeFileWithLanguage] fileName=${fileName} size=${fs.statSync(filePath).size}`);
    const fileSizeBytes = fs.statSync(filePath).size;
    const result = await groq.audio.transcriptions.create({
        file: await toFile(fileStream, fileName),
        model: GROQ_WHISPER_MODEL,
        response_format: 'verbose_json',
    });
    const transcript = (result.text || '').trim();
    // Diagnostic log: capture Whisper confidence signals so we can detect
    // hallucinated transcripts (e.g. from corrupt OGG headers) in the future.
    // Low avg_logprob (< -1.0) or high no_speech_prob (> 0.6) strongly suggests
    // the audio had no real speech content and Whisper is hallucinating.
    const firstSeg = result.segments?.[0];
    const avgLogprob = firstSeg?.avg_logprob;
    const noSpeechProb = firstSeg?.no_speech_prob;
    console.log(`[transcribeFileWithLanguage] result: lang=${result.language} duration=${result.duration}s ` +
        `len=${transcript.length} avg_logprob=${avgLogprob?.toFixed(3) ?? 'n/a'} ` +
        `no_speech_prob=${noSpeechProb?.toFixed(3) ?? 'n/a'}`);
    if (typeof avgLogprob === 'number' && avgLogprob < -1.0) {
        console.warn(`[transcribeFileWithLanguage] LOW CONFIDENCE transcript (avg_logprob=${avgLogprob.toFixed(3)}) — likely hallucination. Preview: "${transcript.slice(0, 80)}"`);
    }
    if (typeof noSpeechProb === 'number' && noSpeechProb > 0.6) {
        console.warn(`[transcribeFileWithLanguage] HIGH NO-SPEECH probability (${noSpeechProb.toFixed(3)}) — audio likely contains no speech. Preview: "${transcript.slice(0, 80)}"`);
    }
    if (!transcript && !options?.allowEmpty) {
        throw new Error('Empty transcription result');
    }
    const detectedLanguage = (result.language || 'english').toLowerCase();
    const languageCode = LANGUAGE_NAME_TO_CODE[detectedLanguage] || config.VOICE_LANGUAGE;
    // A2 confidence gate: surface Whisper's confidence signals so the caller can
    // refuse a hallucinated transcript instead of feeding nonsense to the agent.
    const lowConfidence = (typeof avgLogprob === 'number' && avgLogprob < -1.0) ||
        (typeof noSpeechProb === 'number' && noSpeechProb > 0.6);
    // Stage 2 Voice-Quality-Gate (2026-05-28): derive raw signals + qualityFlag.
    // bytesPerSec catches "hollow OGG" files (corrupt headers, ~234 b/s) that
    // Whisper still happily hallucinates a transcript for. detectLoopHallucination
    // catches "Thank you for watching!"-style silence-on-silence outputs.
    const durationSec = typeof result.duration === 'number' && result.duration > 0
        ? result.duration
        : null;
    const bytesPerSec = durationSec !== null
        ? Math.round(fileSizeBytes / durationSec)
        : null;
    let qualityFlag = 'ok';
    if (transcript.length < 2) {
        qualityFlag = 'empty_or_silent';
    }
    else if (bytesPerSec !== null && bytesPerSec < 500) {
        qualityFlag = 'low_bitrate_hollow';
    }
    else if (
    // Short audio + canonical Whisper-on-silence stock phrase. Groq's
    // whisper-large-v3-turbo emits "Thank you." / "you" / "Subscribe" on a 1s
    // silent OGG with no_speech_prob=0.000 — neither lowConfidence nor
    // bytesPerSec catch it. Forensik 2026-05-27 silent_short fixture: 650 bytes /
    // 1s = 646 b/s, transcript "Thank you." (10 chars, 2 tokens).
    durationSec !== null && isWhisperSilenceHallucination(transcript, durationSec)) {
        qualityFlag = 'empty_or_silent';
    }
    else if (detectLoopHallucination(transcript)) {
        qualityFlag = 'loop_hallucination';
    }
    else if (lowConfidence) {
        qualityFlag = 'low_confidence';
    }
    if (qualityFlag !== 'ok') {
        console.warn(`[transcribeFileWithLanguage] quality-flag=${qualityFlag} ` +
            `bytesPerSec=${bytesPerSec ?? 'n/a'} durationSec=${durationSec ?? 'n/a'} ` +
            `len=${transcript.length} preview="${transcript.slice(0, 60)}"`);
    }
    return {
        text: transcript,
        language: detectedLanguage,
        languageCode,
        avgLogprob: typeof avgLogprob === 'number' ? avgLogprob : null,
        noSpeechProb: typeof noSpeechProb === 'number' ? noSpeechProb : null,
        lowConfidence,
        durationSec,
        bytesPerSec,
        qualityFlag,
    };
}
/**
 * Transcribe an audio file using the Groq Whisper API via OpenAI SDK.
 * Uses fixed language from config (backward-compatible).
 */
export async function transcribeFile(filePath, options) {
    const groq = getGroqClient();
    const fileName = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);
    console.log(`[transcribeFile] fileName=${fileName} size=${fs.statSync(filePath).size}`);
    const result = await groq.audio.transcriptions.create({
        file: await toFile(fileStream, fileName),
        model: GROQ_WHISPER_MODEL,
        language: config.VOICE_LANGUAGE,
        response_format: 'json',
    });
    const transcript = (result.text || '').trim();
    if (!transcript && !options?.allowEmpty) {
        throw new Error('Empty transcription result');
    }
    return transcript;
}
/**
 * Download a file from Telegram servers securely.
 * Constructs the URL via getTelegramFileUrl and delegates to downloadFileSecure.
 */
export function downloadTelegramAudio(botToken, filePath, destPath) {
    const fileUrl = getTelegramFileUrl(botToken, filePath);
    return downloadFileSecure(fileUrl, destPath);
}
//# sourceMappingURL=transcribe.js.map