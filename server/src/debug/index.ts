import type { Request, Response } from 'express';
import type { TranscriptionService } from '../transcription/index.js';
import type { IntelligenceEngine } from '../intelligence/index.js';
import type { WorkerRegistry } from '../workers/registry.js';
import type { TranscriptSegment, TranscriptionProviderInfo } from '../transcription/types.js';
import { getLlmBudgetSnapshot } from '../api/budget.js';

export interface DebugMetrics {
  audio: {
    chunksReceived: number;
    bytesPerSec: number;
    deviceChanges: number;
  };
  transcription: {
    chunksProcessed: number;
    avgLatencyMs: number;
    errorRate: number;
    queueDepth: number;
    activeCount: number;
    provider: TranscriptionProviderInfo;
    queueLatencyP50Ms: number | null;
    queueLatencyP95Ms: number | null;
    providerLatencyP50Ms: number | null;
    providerLatencyP95Ms: number | null;
    endToEndLatencyP50Ms: number | null;
    endToEndLatencyP95Ms: number | null;
    hallucinationsFiltered: number;
    prewarmDurationMs: number | null;
  };
  intelligence: {
    evalsRun: number;
    haikuHitRate: number;
    sonnetCallRate: number;
    avgSuggestionLatencyMs: number;
    budget: ReturnType<typeof getLlmBudgetSnapshot>;
    realtime: {
      agenda: Record<string, number>;
      coach: Record<string, number>;
    } | null;
  };
  workers: {
    byState: Record<string, number>;
    avgCompletionTimeMs: Record<string, number>;
    failureRate: number;
  };
  session: {
    uptimeMs: number;
    stateTransitions: number;
    totalTranscriptWords: number;
    firstChunkLatencyMs: number | null;
    e2eLatencyP50Ms: number | null;
    e2eLatencyP95Ms: number | null;
    transcriptSegmentsBroadcast: number;
  };
}

/** True end-to-end latency: when the Swift app finished capturing audio
 *  to when this server broadcast the resulting transcript. Falls back
 *  to transcriptionLatencyMs if the Swift side hasn't upgraded yet. */
function measureE2eLatencyMs(segment: TranscriptSegment): number {
  if (segment.captureEndedAt) {
    const capturedAt = Date.parse(segment.captureEndedAt);
    if (!Number.isNaN(capturedAt)) {
      return Math.max(0, Date.now() - capturedAt);
    }
  }
  return segment.transcriptionLatencyMs ?? 0;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? null;
}

export class DebugHandler {
  private audioChunksReceived = 0;
  private audioBytesReceived = 0;
  private audioStartTime: number | null = null;
  private deviceChanges = 0;
  private stateTransitions = 0;
  private totalTranscriptWords = 0;
  private sessionStartTime: number | null = null;
  private firstChunkLatencyMs: number | null = null;
  private e2eLatencySamples: number[] = [];
  private transcriptSegmentsBroadcast = 0;
  private realtimeMetricsProvider: (() => {
    agenda: Record<string, number>;
    coach: Record<string, number>;
  }) | null = null;

  constructor(
    private transcription: TranscriptionService,
    private intelligence: IntelligenceEngine,
    private registry: WorkerRegistry,
  ) {}

  setRealtimeMetricsProvider(provider: () => {
    agenda: Record<string, number>;
    coach: Record<string, number>;
  }): void {
    this.realtimeMetricsProvider = provider;
  }

  recordAudioChunk(bytes: number): void {
    this.audioChunksReceived++;
    this.audioBytesReceived += bytes;
    if (!this.audioStartTime) {
      this.audioStartTime = Date.now();
    }
  }

  recordDeviceChange(): void {
    this.deviceChanges++;
  }

  recordStateTransition(): void {
    this.stateTransitions++;
  }

  recordTranscriptWords(wordCount: number): void {
    this.totalTranscriptWords += wordCount;
  }

  setSessionStartTime(time: number): void {
    this.sessionStartTime = time;
  }

  /**
   * Reset counters that are per-session. Called on session.start so `/debug`
   * shows only the current run, not the cumulative since process start.
   * Intentionally keeps process-lifetime state (audioStartTime, deviceChanges,
   * prewarmDurationMs) — those describe the server, not the session.
   */
  resetSessionMetrics(): void {
    this.totalTranscriptWords = 0;
    this.firstChunkLatencyMs = null;
    this.e2eLatencySamples = [];
    this.transcriptSegmentsBroadcast = 0;
    this.audioChunksReceived = 0;
    this.audioBytesReceived = 0;
    this.audioStartTime = null;
  }

  /**
   * Record a successfully-broadcast transcript segment for e2e / first-chunk
   * latency tracking. Call AFTER hallucination filtering, so silence chunks
   * don't pollute the percentiles.
   */
  recordTranscriptSegment(segment: TranscriptSegment): void {
    this.transcriptSegmentsBroadcast++;
    const e2e = measureE2eLatencyMs(segment);
    this.e2eLatencySamples.push(e2e);
    // Cap memory — keep only the last 500 samples.
    if (this.e2eLatencySamples.length > 500) {
      this.e2eLatencySamples.shift();
    }
    if (this.firstChunkLatencyMs === null && this.sessionStartTime !== null) {
      this.firstChunkLatencyMs = Date.now() - this.sessionStartTime;
    }
  }

  /** Snapshot copied into the session.stop event log for offline analysis. */
  getSessionSnapshot(): Record<string, unknown> {
    const m = this.getMetrics();
    return {
      transcription: m.transcription,
      session: m.session,
      audio: m.audio,
    };
  }

  getMetrics(): DebugMetrics {
    const audioElapsedSec = this.audioStartTime
      ? (Date.now() - this.audioStartTime) / 1000
      : 1;

    return {
      audio: {
        chunksReceived: this.audioChunksReceived,
        bytesPerSec:
          audioElapsedSec > 0
            ? this.audioBytesReceived / audioElapsedSec
            : 0,
        deviceChanges: this.deviceChanges,
      },
      transcription: {
        chunksProcessed: this.transcription.chunksProcessed,
        avgLatencyMs: this.transcription.avgLatencyMs,
        errorRate: this.transcription.errorRate,
        queueDepth: this.transcription.queueDepth,
        activeCount: this.transcription.activeTranscriptions,
        provider: this.transcription.providerInfo,
        queueLatencyP50Ms: percentile([...this.transcription.queueLatencySamples].sort((a, b) => a - b), 0.5),
        queueLatencyP95Ms: percentile([...this.transcription.queueLatencySamples].sort((a, b) => a - b), 0.95),
        providerLatencyP50Ms: percentile([...this.transcription.providerLatencySamples].sort((a, b) => a - b), 0.5),
        providerLatencyP95Ms: percentile([...this.transcription.providerLatencySamples].sort((a, b) => a - b), 0.95),
        endToEndLatencyP50Ms: percentile([...this.transcription.endToEndLatencySamples].sort((a, b) => a - b), 0.5),
        endToEndLatencyP95Ms: percentile([...this.transcription.endToEndLatencySamples].sort((a, b) => a - b), 0.95),
        hallucinationsFiltered: this.transcription.hallucinationsFiltered,
        prewarmDurationMs: this.transcription.prewarmDurationMs,
      },
      intelligence: {
        evalsRun: this.intelligence.evalsRun,
        haikuHitRate: this.intelligence.haikuHitRate,
        sonnetCallRate: this.intelligence.sonnetCallRate,
        avgSuggestionLatencyMs: this.intelligence.avgSuggestionLatencyMs,
        budget: getLlmBudgetSnapshot(),
        realtime: this.realtimeMetricsProvider?.() ?? null,
      },
      workers: {
        byState: this.registry.byState,
        avgCompletionTimeMs: this.registry.avgCompletionTimeMs,
        failureRate: this.registry.failureRate,
      },
      session: {
        uptimeMs: this.sessionStartTime
          ? Date.now() - this.sessionStartTime
          : 0,
        stateTransitions: this.stateTransitions,
        totalTranscriptWords: this.totalTranscriptWords,
        firstChunkLatencyMs: this.firstChunkLatencyMs,
        e2eLatencyP50Ms: percentile(
          [...this.e2eLatencySamples].sort((a, b) => a - b),
          0.5,
        ),
        e2eLatencyP95Ms: percentile(
          [...this.e2eLatencySamples].sort((a, b) => a - b),
          0.95,
        ),
        transcriptSegmentsBroadcast: this.transcriptSegmentsBroadcast,
      },
    };
  }

  handler() {
    return (_req: Request, res: Response) => {
      res.json(this.getMetrics());
    };
  }
}
