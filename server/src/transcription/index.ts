import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import type { TranscriptSegment, TranscriptionProvider } from './types.js';
import { WhisperProvider } from './whisper.js';
import { DeepgramProvider } from './deepgram.js';

interface QueueItem {
  wavBuffer: Buffer;
  source: 'mic' | 'meeting';
  resolve: (segment: TranscriptSegment) => void;
  reject: (error: Error) => void;
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

export class TranscriptionService extends EventEmitter {
  private provider: TranscriptionProvider;
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private readonly maxConcurrent = 2;

  // Metrics
  public chunksProcessed = 0;
  public totalLatencyMs = 0;
  public errorCount = 0;

  constructor(provider?: TranscriptionProvider) {
    super();
    this.provider = provider ?? createProvider();
  }

  async isProviderAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  transcribeChunk(
    wavBuffer: Buffer,
    source: 'mic' | 'meeting',
  ): Promise<TranscriptSegment> {
    return new Promise<TranscriptSegment>((resolve, reject) => {
      this.queue.push({ wavBuffer, source, resolve, reject });
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
      const result = await this.provider.transcribe(item.wavBuffer);
      const latency = Date.now() - startTime;

      this.chunksProcessed++;
      this.totalLatencyMs += latency;

      const text = result.text.trim();
      if (!text) {
        // Empty transcription - still resolve but with empty text
        const segment: TranscriptSegment = {
          id: uuidv4(),
          text: '',
          source: item.source,
          label: item.source === 'mic' ? '[You]' : '[Meeting]',
          timestamp: Date.now(),
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
        duration: latency,
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

export { DeepgramProvider } from './deepgram.js';
export { WhisperProvider } from './whisper.js';
export type { TranscriptSegment, TranscriptionProvider };
