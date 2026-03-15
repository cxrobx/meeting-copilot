import type { Request, Response } from 'express';
import type { TranscriptionService } from '../transcription/index.js';
import type { IntelligenceEngine } from '../intelligence/index.js';
import type { WorkerRegistry } from '../workers/registry.js';

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
  };
  intelligence: {
    evalsRun: number;
    haikuHitRate: number;
    sonnetCallRate: number;
    avgSuggestionLatencyMs: number;
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
  };
}

export class DebugHandler {
  private audioChunksReceived = 0;
  private audioBytesReceived = 0;
  private audioStartTime: number | null = null;
  private deviceChanges = 0;
  private stateTransitions = 0;
  private totalTranscriptWords = 0;
  private sessionStartTime: number | null = null;

  constructor(
    private transcription: TranscriptionService,
    private intelligence: IntelligenceEngine,
    private registry: WorkerRegistry,
  ) {}

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
      },
      intelligence: {
        evalsRun: this.intelligence.evalsRun,
        haikuHitRate: this.intelligence.haikuHitRate,
        sonnetCallRate: this.intelligence.sonnetCallRate,
        avgSuggestionLatencyMs: this.intelligence.avgSuggestionLatencyMs,
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
      },
    };
  }

  handler() {
    return (_req: Request, res: Response) => {
      res.json(this.getMetrics());
    };
  }
}
