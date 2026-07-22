import {
  persistVoiceTranscriptMemory,
} from './captures-db.js';
import {
  claimDueTaskRetries,
  completeTaskRetry,
  enqueueTaskRetry,
  pendingTaskRetryCount,
  rescheduleTaskRetry,
} from './task-ledger.js';

export const VOICE_RECALL_DELAY_NOTICE =
  '⚠️ Deine Antwort läuft normal weiter. Der Recall-Index ist verzögert; ich versuche die Speicherung automatisch erneut.';

export interface VoiceRecallPayload {
  chatId: string;
  messageId: number;
  botId: string;
  transcript: string;
  privacy: 'public' | 'private';
}

export interface CommitVoiceRecallInput extends VoiceRecallPayload {
  parentTaskId: number | null;
  notifyDelayed?: (message: string) => Promise<unknown>;
}

export interface VoiceRecallCommitResult {
  memoryId: number | null;
  retryQueued: boolean;
}

interface VoiceRecallDependencies {
  persist: typeof persistVoiceTranscriptMemory;
  enqueue: typeof enqueueTaskRetry;
}

const defaultDependencies: VoiceRecallDependencies = {
  persist: persistVoiceTranscriptMemory,
  enqueue: enqueueTaskRetry,
};

function dedupeKey(payload: VoiceRecallPayload): string {
  return `${payload.botId}:${payload.chatId}:${payload.messageId}`;
}

/**
 * Recall indexing is a durable side effect, never a precondition for answering.
 * Every failure is logged, queued in the Sprint-3 ledger, and reported once to
 * the user. Even a ledger or Telegram-notice failure is contained here.
 */
export async function commitVoiceRecallNonBlocking(
  input: CommitVoiceRecallInput,
  dependencies: VoiceRecallDependencies = defaultDependencies,
): Promise<VoiceRecallCommitResult> {
  let memoryId: number | null = null;
  try {
    memoryId = dependencies.persist(
      input.chatId,
      input.messageId,
      input.botId,
      input.transcript,
      input.privacy,
    );
  } catch (error) {
    console.error(
      '[VoiceRecall] unexpected persist error; voice turn continues:',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (memoryId !== null) return { memoryId, retryQueued: false };

  let retryQueued = false;
  const payload: VoiceRecallPayload = {
    chatId: input.chatId,
    messageId: input.messageId,
    botId: input.botId,
    transcript: input.transcript,
    privacy: input.privacy,
  };
  try {
    const retryId = dependencies.enqueue({
      parentTaskId: input.parentTaskId,
      retryKind: 'voice_recall_index',
      dedupeKey: dedupeKey(payload),
      payloadJson: JSON.stringify(payload),
      lastError: 'voice_recall_index_commit_failed',
    });
    retryQueued = true;
    console.warn(`[VoiceRecall] index delayed; queued retry ${retryId} for ${dedupeKey(payload)}`);
  } catch (error) {
    console.error(
      '[VoiceRecall] retry queue FAILED; voice turn still continues:',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (input.notifyDelayed) {
    // Delivery starts immediately but is deliberately outside the critical
    // path: a slow Telegram request must not postpone the actual voice answer.
    void input.notifyDelayed(VOICE_RECALL_DELAY_NOTICE).catch((error) => {
      console.warn('[VoiceRecall] delayed-index notice delivery failed:', error instanceof Error ? error.message : String(error));
    });
  }
  return { memoryId: null, retryQueued };
}

export interface VoiceRecallRetryRun {
  claimed: number;
  completed: number;
  failed: number;
}

/** Drain a bounded due batch. Safe to call at boot and from an unref'ed timer. */
export function retryDueVoiceRecallJobs(limit = 10): VoiceRecallRetryRun {
  const jobs = claimDueTaskRetries('voice_recall_index', limit);
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payloadJson) as VoiceRecallPayload;
      const memoryId = persistVoiceTranscriptMemory(
        payload.chatId,
        payload.messageId,
        payload.botId,
        payload.transcript,
        payload.privacy,
      );
      if (memoryId === null) throw new Error('voice recall postcondition still unavailable');
      completeTaskRetry(job.id);
      completed++;
      console.log(`[VoiceRecall] retry ${job.id} completed as memory ${memoryId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backoffMs = Math.min(60 * 60_000, Math.max(30_000, 30_000 * (2 ** Math.min(job.attempts - 1, 7)))); // allow-hardcoded: reason="bounded exponential retry: 30s base, 1h cap, 7 doublings"
      rescheduleTaskRetry(job.id, message, backoffMs);
      failed++;
      console.warn(`[VoiceRecall] retry ${job.id} rescheduled: ${message}`);
    }
  }
  return { claimed: jobs.length, completed, failed };
}

let retryTimer: NodeJS.Timeout | undefined;

export function startVoiceRecallRetryWorker(): void {
  if (retryTimer) return;
  try {
    retryDueVoiceRecallJobs();
  } catch (error) {
    console.error('[VoiceRecall] initial retry drain failed:', error instanceof Error ? error.message : String(error));
  }
  retryTimer = setInterval(() => {
    try {
      retryDueVoiceRecallJobs();
    } catch (error) {
      console.error('[VoiceRecall] retry worker failed:', error instanceof Error ? error.message : String(error));
    }
  }, 60_000); // allow-hardcoded: reason="durable recall side-effect retry cadence"
  retryTimer.unref();
}

export function stopVoiceRecallRetryWorker(): void {
  if (!retryTimer) return;
  clearInterval(retryTimer);
  retryTimer = undefined;
}

export function voiceRecallRetryCount(): number {
  try {
    return pendingTaskRetryCount('voice_recall_index');
  } catch {
    return -1;
  }
}
