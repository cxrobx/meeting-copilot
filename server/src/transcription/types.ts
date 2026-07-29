export interface TranscriptSegment {
  id: string;
  /** Stable client-generated id for tracing capture → decode → broadcast. */
  chunkId?: string;
  text: string;
  source: 'mic' | 'meeting';
  label: string; // '[You]' or '[Meeting]'
  timestamp: number; // epoch-ms (when the segment was FINALIZED server-side)
  /** Actual audio length in seconds covered by this segment. */
  audioDurationSec: number;
  /** Whisper / provider processing latency in milliseconds. */
  transcriptionLatencyMs: number;
  /** Time spent waiting for a provider slot. */
  queueLatencyMs?: number;
  /** Total latency from chunk enqueue through provider completion. */
  endToEndLatencyMs?: number;
  provider?: string;
  /** When the Swift app started capturing this chunk's audio (ISO-8601). */
  captureStartedAt?: string;
  /** When the Swift app finished capturing this chunk's audio (ISO-8601). */
  captureEndedAt?: string;
  /** Monotonically-increasing sequence per source for out-of-order detection. */
  sequence?: number;
  wordCount: number;
  /**
   * @deprecated use `audioDurationSec` for audio length or
   * `transcriptionLatencyMs` for processing time. Kept during v2 rollout so
   * older consumers (Swift decoder, shared-transcript readers) don't break
   * mid-deploy. Set to `audioDurationSec`.
   */
  duration: number;
}

export interface TranscribeOptions {
  /** Whisper `initial_prompt` — primes decoder with expected vocabulary. */
  prompt?: string;
}

export interface TranscriptionProvider {
  transcribe(
    wavBuffer: Buffer,
    options?: TranscribeOptions,
  ): Promise<{ text: string }>;
  isAvailable(): Promise<boolean>;
  getInfo(): TranscriptionProviderInfo;
}

export interface TranscriptionProviderInfo {
  mode: 'whisper-server' | 'parakeet' | 'deepgram';
  model?: string;
  endpoint?: string;
  supportsPrompt: boolean;
  supportsKeyterms: boolean;
  supportsPartials: boolean;
  streaming: boolean;
  supportsDiarization: boolean;
  audioStorage: 'memory-only' | 'remote-ephemeral';
}
