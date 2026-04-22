import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type { TranscriptSegment, TranscriptionProvider } from './types.js';
import { WhisperProvider } from './whisper.js';
import { DeepgramProvider } from './deepgram.js';
import { CHUNK_DURATION_SECONDS } from '../audio/chunkConfig.js';

interface QueueItem {
  wavBuffer: Buffer;
  source: 'mic' | 'meeting';
  audioDurationSec: number;
  captureStartedAt?: string;
  captureEndedAt?: string;
  sequence?: number;
  resolve: (segment: TranscriptSegment) => void;
  reject: (error: Error) => void;
}

const MAX_PROMPT_CHARS = 1500; // ~300 tokens, whisper ctx is 448.

// Whisper hallucinates common phrases on silent/noise-only audio. When the
// ENTIRE chunk transcribes to one of these (or a bracketed sound description),
// drop it rather than spamming the UI and shared transcript.
const HALLUCINATION_PHRASES = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'bye',
  'bye.',
  'goodbye',
  'okay',
  'ok',
  'mhm',
  'hmm',
  'uh',
  'um',
  'ah',
  'oh',
  'yeah',
  '.',
  '..',
  '...',
  '. .',
  ', ,',
]);

export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Whole-text bracketed/parenthesized sound description: "[Silence]",
  // "[ typing sounds ]", "(bell dings)", "[Music]", etc.
  if (/^[\[\(].*[\]\)]$/.test(trimmed)) return true;

  // Normalize: lowercase, strip surrounding punctuation + collapse whitespace.
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .trim();

  // If nothing remains after stripping punctuation (e.g. "...", ".", ". ."),
  // it's whisper's silence-filler punctuation — drop it.
  if (!normalized) return true;

  return HALLUCINATION_PHRASES.has(normalized);
}

/**
 * Creates the appropriate TranscriptionProvider based on environment config.
 *
 * Set `TRANSCRIPTION_PROVIDER=deepgram` to use Deepgram (requires DEEPGRAM_API_KEY).
 * Defaults to whisper-server.
 */
function createProvider(): TranscriptionProvider {
  const selection = process.env.TRANSCRIPTION_PROVIDER?.toLowerCase();
  if (selection === 'deepgram') {
    return new DeepgramProvider();
  }
  return new WhisperProvider();
}

export interface TranscribeChunkMeta {
  audioDurationSec?: number;
  captureStartedAt?: string;
  captureEndedAt?: string;
  sequence?: number;
}

export class TranscriptionService extends EventEmitter {
  private provider: TranscriptionProvider;
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private readonly maxConcurrent = 2;
  private sessionPrompt = '';

  // Metrics
  public chunksProcessed = 0;
  public totalLatencyMs = 0;
  public errorCount = 0;
  public hallucinationsFiltered = 0;
  public prewarmDurationMs: number | null = null;

  constructor(provider?: TranscriptionProvider) {
    super();
    this.provider = provider ?? createProvider();
  }

  async isProviderAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /**
   * Set a whisper `initial_prompt` for all subsequent transcriptions in this
   * session. Seeded from agenda + attendees to improve proper-noun accuracy.
   * Cleared on session.stop.
   */
  setSessionPrompt(prompt: string): void {
    this.sessionPrompt = (prompt ?? '').slice(0, MAX_PROMPT_CHARS);
  }

  clearSessionPrompt(): void {
    this.sessionPrompt = '';
  }

  get sessionPromptText(): string {
    return this.sessionPrompt;
  }

  /**
   * Pre-warm the whisper model — runs one throwaway inference on 100ms of
   * silence to force Metal JIT compilation. Called once at server startup so
   * the user's first real chunk doesn't pay the cold-start cost.
   */
  async prewarm(): Promise<void> {
    const start = Date.now();
    try {
      const samples = Math.round(16_000 * 0.1);
      const pcm = Buffer.alloc(samples * 2); // 16-bit mono silence
      const wav = wrapPcmAsWav(pcm);
      await this.provider.transcribe(wav);
      this.prewarmDurationMs = Date.now() - start;
      console.log(`[Transcription] Pre-warm complete in ${this.prewarmDurationMs}ms`);
    } catch (err) {
      console.warn(
        '[Transcription] Pre-warm failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Wait for in-flight chunks to finish transcribing. Called on
   * `audio.flush` and again on `session.stop`. Without this, session.stop
   * can commit + reset SessionStore while a trailing utterance is still
   * being transcribed, causing that segment to be dropped (or worse,
   * written into the NEXT session's store).
   *
   * Bounded by a 2.5s timeout — if whisper is genuinely stuck we don't
   * want to hang the session-stop handshake indefinitely. 2.5s is well
   * above p95 decode latency for a 6s chunk with VAD (~500ms-1s).
   */
  async flushPending(timeoutMs = 2_500): Promise<void> {
    const started = Date.now();
    while (this.queue.length > 0 || this.activeCount > 0) {
      if (Date.now() - started > timeoutMs) {
        console.warn(
          `[Transcription] flushPending timed out after ${timeoutMs}ms (queue=${this.queue.length} active=${this.activeCount})`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Reset per-run counters. Called on session.start so /debug reflects only
   * the current session, not lifetime. (Prewarm timing is process-lifetime
   * and intentionally NOT reset.)
   */
  resetSessionMetrics(): void {
    this.chunksProcessed = 0;
    this.totalLatencyMs = 0;
    this.errorCount = 0;
    this.hallucinationsFiltered = 0;
  }

  transcribeChunk(
    wavBuffer: Buffer,
    source: 'mic' | 'meeting',
    meta?: TranscribeChunkMeta,
  ): Promise<TranscriptSegment> {
    return new Promise<TranscriptSegment>((resolve, reject) => {
      this.queue.push({
        wavBuffer,
        source,
        audioDurationSec: meta?.audioDurationSec ?? CHUNK_DURATION_SECONDS,
        captureStartedAt: meta?.captureStartedAt,
        captureEndedAt: meta?.captureEndedAt,
        sequence: meta?.sequence,
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get avgLatencyMs(): number {
    return this.chunksProcessed > 0
      ? this.totalLatencyMs / this.chunksProcessed
      : 0;
  }

  get errorRate(): number {
    const total = this.chunksProcessed + this.errorCount;
    return total > 0 ? this.errorCount / total : 0;
  }

  private processQueue(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.activeCount++;
      this.processItem(item).finally(() => {
        this.activeCount--;
        this.processQueue();
      });
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    const startTime = Date.now();
    try {
      const result = await this.provider.transcribe(item.wavBuffer, {
        prompt: this.sessionPrompt || undefined,
      });
      const latency = Date.now() - startTime;

      this.chunksProcessed++;
      this.totalLatencyMs += latency;

      const text = result.text.trim();
      const promptContinuation =
        this.sessionPrompt.length > 0 &&
        text.length > 0 &&
        this.sessionPrompt.toLowerCase().startsWith(text.toLowerCase().slice(0, 60));

      if (!text || isLikelyHallucination(text) || promptContinuation) {
        // Empty / silence-hallucinated / prompt-continued transcription —
        // resolve with empty text so upstream skips storage/broadcast (see
        // index.ts audio_chunk handler: only non-empty segments are persisted).
        if (text) this.hallucinationsFiltered++;
        const segment: TranscriptSegment = {
          id: uuidv4(),
          text: '',
          source: item.source,
          label: item.source === 'mic' ? '[You]' : '[Meeting]',
          timestamp: Date.now(),
          audioDurationSec: 0,
          transcriptionLatencyMs: latency,
          captureStartedAt: item.captureStartedAt,
          captureEndedAt: item.captureEndedAt,
          sequence: item.sequence,
          duration: 0,
          wordCount: 0,
        };
        item.resolve(segment);
        return;
      }

      const segment: TranscriptSegment = {
        id: uuidv4(),
        text,
        source: item.source,
        label: item.source === 'mic' ? '[You]' : '[Meeting]',
        timestamp: Date.now(),
        audioDurationSec: item.audioDurationSec,
        transcriptionLatencyMs: latency,
        captureStartedAt: item.captureStartedAt,
        captureEndedAt: item.captureEndedAt,
        sequence: item.sequence,
        // `duration` is deprecated but aliased to audioDurationSec during
        // v2 rollout so legacy consumers keep working.
        duration: item.audioDurationSec,
        wordCount: text.split(/\s+/).filter(Boolean).length,
      };

      this.emit('transcript', segment);
      item.resolve(segment);
    } catch (error) {
      this.errorCount++;
      const err =
        error instanceof Error ? error : new Error(String(error));
      this.emit('transcription.error', err);
      item.reject(err);
    }
  }
}

/**
 * Wrap raw 16kHz mono 16-bit PCM bytes as a WAV buffer. Used by `prewarm()`
 * to feed whisper-server synthetic silence at startup.
 */
function wrapPcmAsWav(pcm: Buffer): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export { DeepgramProvider } from './deepgram.js';
export { WhisperProvider } from './whisper.js';
export type { TranscriptSegment, TranscriptionProvider };
