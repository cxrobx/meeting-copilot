import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type { TranscriptSegment, TranscriptionProvider, TranscriptionProviderInfo } from './types.js';
import { WhisperProvider } from './whisper.js';
import { DeepgramProvider } from './deepgram.js';
import { GrokProvider } from './grok.js';
import { FallbackProvider } from './fallback.js';
import { StreamingTranscriber } from './streaming.js';
import { CHUNK_DURATION_SECONDS } from '../audio/chunkConfig.js';
import { paidApiDisabled } from '../api/killswitch.js';

interface QueueItem {
  chunkId: string;
  queuedAt: number;
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
 * The local backend the launcher started. start.sh / ProcessSupervisor pin
 * TRANSCRIPTION_PROVIDER to whatever they actually launched, so if Parakeet
 * had to fall back to whisper (no `uv` / sidecar failed) this resolves to
 * whisper and stays correct.
 */
function createLocalProvider(selection: string): TranscriptionProvider {
  // Parakeet (NVIDIA Parakeet-TDT via parakeet-mlx) runs through a local
  // sidecar that speaks the SAME /inference contract as whisper-server, so we
  // reuse WhisperProvider pointed at the sidecar's port. Fully local + free,
  // so the paid-API kill switch does not affect it.
  if (selection === 'parakeet') {
    const url =
      process.env.PARAKEET_URL ??
      `http://127.0.0.1:${process.env.PARAKEET_PORT ?? '8077'}`;
    console.log(`[Transcription] Local backend: Parakeet sidecar at ${url}`);
    return new WhisperProvider(url, {
      mode: 'parakeet',
      model: process.env.PARAKEET_MODEL ?? 'mlx-community/parakeet-tdt-0.6b-v3',
      supportsPrompt: false,
    });
  }
  return new WhisperProvider();
}

type CloudChoice = 'grok' | 'deepgram';

/**
 * Which cloud provider (if any) should sit in front of the local backend.
 * An explicit TRANSCRIPTION_PROVIDER=grok|deepgram wins (legacy form);
 * otherwise COPILOT_CLOUD_TRANSCRIPTION decides, defaulting to Grok.
 * `off` / `none` / `local` keeps transcription fully local.
 */
function cloudChoice(selection: string): CloudChoice | null {
  if (selection === 'grok' || selection === 'deepgram') return selection;
  const configured = (process.env.COPILOT_CLOUD_TRANSCRIPTION ?? 'grok').trim().toLowerCase();
  return configured === 'grok' || configured === 'deepgram' ? configured : null;
}

/**
 * Creates the TranscriptionProvider from environment config.
 *
 * DEFAULT (2026-09-22): Grok Voice Transcribe 2.0 in front of the local
 * backend, which takes over per chunk if Grok fails. Grok is only used when
 * ALL of these hold — otherwise transcription is purely local:
 *   - COPILOT_ALLOW_CLOUD_AUDIO=true (explicit consent before audio leaves the Mac)
 *   - COPILOT_DISABLE_PAID_API is not set (the kill switch covers metered STT)
 *   - XAI_API_KEY is set (DEEPGRAM_API_KEY for deepgram)
 * Pick the cloud with COPILOT_CLOUD_TRANSCRIPTION=grok|deepgram|off.
 */
export interface TranscriptionPlan {
  /** Transcribes the app's VAD chunks (the whole transcript when not streaming). */
  provider: TranscriptionProvider;
  /** Live Grok streaming; when set, `provider` is only its local fallback. */
  streaming: StreamingTranscriber<StreamChunk> | null;
}

/** A VAD chunk held by the streamer, replayed locally if its stream fails. */
export interface StreamChunk {
  wavBuffer: Buffer;
  source: 'mic' | 'meeting';
  meta: TranscribeChunkMeta;
}

export function resolveTranscription(): TranscriptionPlan {
  const selection = (process.env.TRANSCRIPTION_PROVIDER ?? 'parakeet').toLowerCase();
  const local = createLocalProvider(selection);
  const cloud = cloudChoice(selection);
  if (!cloud) return { provider: local, streaming: null };

  const localMode = local.getInfo().mode;
  if (paidApiDisabled()) {
    console.warn(`[Transcription] COPILOT_DISABLE_PAID_API set — skipping ${cloud}, using ${localMode} (no metered STT billing).`);
    return { provider: local, streaming: null };
  }
  if (process.env.COPILOT_ALLOW_CLOUD_AUDIO !== 'true') {
    console.warn(`[Transcription] Cloud audio is not consented; using ${localMode}. Set COPILOT_ALLOW_CLOUD_AUDIO=true explicitly to enable ${cloud}.`);
    return { provider: local, streaming: null };
  }
  const keyVar = cloud === 'grok' ? 'XAI_API_KEY' : 'DEEPGRAM_API_KEY';
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    console.warn(`[Transcription] ${keyVar} is not set; using ${localMode}.`);
    return { provider: local, streaming: null };
  }
  // Grok streams by default: text trails speech by ~1 s instead of a whole
  // VAD utterance (up to 6 s) plus a batch round trip. COPILOT_GROK_STREAMING=0
  // goes back to per-chunk batch Grok.
  if (cloud === 'grok' && process.env.COPILOT_GROK_STREAMING !== '0') {
    console.log(`[Transcription] Streaming grok live, with ${localMode} covering any outage.`);
    return {
      provider: local,
      streaming: new StreamingTranscriber<StreamChunk>({ apiKey, model: process.env.GROK_STT_MODEL }),
    };
  }
  const primary = cloud === 'grok' ? new GrokProvider() : new DeepgramProvider();
  console.log(`[Transcription] Using ${cloud} with ${localMode} as per-chunk fallback.`);
  return { provider: new FallbackProvider(primary, local), streaming: null };
}

/** The chunk provider alone (kept for callers that never stream). */
export function createProvider(): TranscriptionProvider {
  return resolveTranscription().provider;
}

export interface TranscribeChunkMeta {
  chunkId?: string;
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
  public queueLatencySamples: number[] = [];
  public providerLatencySamples: number[] = [];
  public endToEndLatencySamples: number[] = [];

  constructor(provider?: TranscriptionProvider) {
    super();
    this.provider = provider ?? createProvider();
  }

  async isProviderAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /** Set when a live stream is the primary transcriber (chunks are its fallback). */
  streamingInfo: TranscriptionProviderInfo | null = null;

  get providerInfo(): TranscriptionProviderInfo {
    if (this.streamingInfo) {
      return { ...this.streamingInfo, fallback: this.provider.getInfo().mode };
    }
    return this.provider.getInfo();
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
    const samples = Math.round(16_000 * 0.1);
    const pcm = Buffer.alloc(samples * 2);
    const wav = wrapPcmAsWav(pcm);
    let lastError: unknown;
    // The Swift supervisor starts Node and the ASR sidecar concurrently.
    // Wait for model readiness instead of treating the initial connection
    // refusal as a permanent loss of prewarming.
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        if (!await this.provider.isAvailable()) throw new Error('provider not ready');
        const start = Date.now();
        await this.provider.transcribe(wav);
        this.prewarmDurationMs = Date.now() - start;
        console.log(`[Transcription] Pre-warm complete in ${this.prewarmDurationMs}ms (attempt ${attempt})`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 30) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }
    console.warn('[Transcription] Pre-warm failed after 30 attempts:',
      lastError instanceof Error ? lastError.message : String(lastError));
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
    this.queueLatencySamples = [];
    this.providerLatencySamples = [];
    this.endToEndLatencySamples = [];
  }

  transcribeChunk(
    wavBuffer: Buffer,
    source: 'mic' | 'meeting',
    meta?: TranscribeChunkMeta,
  ): Promise<TranscriptSegment> {
    return new Promise<TranscriptSegment>((resolve, reject) => {
      this.queue.push({
        chunkId: meta?.chunkId ?? uuidv4(),
        queuedAt: Date.now(),
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

  get activeTranscriptions(): number {
    return this.activeCount;
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
    const providerStart = Date.now();
    const queueLatency = providerStart - item.queuedAt;
    const startTime = Date.now();
    try {
      const result = await this.provider.transcribe(item.wavBuffer, {
        prompt: this.sessionPrompt || undefined,
      });
      const latency = Date.now() - startTime;
      const endToEndLatency = Date.now() - item.queuedAt;

      this.chunksProcessed++;
      this.totalLatencyMs += latency;
      this.recordLatency(this.queueLatencySamples, queueLatency);
      this.recordLatency(this.providerLatencySamples, latency);
      this.recordLatency(this.endToEndLatencySamples, endToEndLatency);

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
          chunkId: item.chunkId,
          text: '',
          source: item.source,
          label: item.source === 'mic' ? '[You]' : '[Meeting]',
          timestamp: Date.now(),
          audioDurationSec: 0,
          transcriptionLatencyMs: latency,
          queueLatencyMs: queueLatency,
          endToEndLatencyMs: endToEndLatency,
          provider: result.mode ?? this.provider.getInfo().mode,
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
        chunkId: item.chunkId,
        text,
        source: item.source,
        label: item.source === 'mic' ? '[You]' : '[Meeting]',
        timestamp: Date.now(),
        audioDurationSec: item.audioDurationSec,
        transcriptionLatencyMs: latency,
        queueLatencyMs: queueLatency,
        endToEndLatencyMs: endToEndLatency,
        provider: result.mode ?? this.provider.getInfo().mode,
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

  private recordLatency(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > 500) samples.shift();
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
export { GrokProvider } from './grok.js';
export { FallbackProvider } from './fallback.js';
export { StreamingTranscriber } from './streaming.js';
export { WhisperProvider } from './whisper.js';
export type { TranscriptSegment, TranscriptionProvider };
