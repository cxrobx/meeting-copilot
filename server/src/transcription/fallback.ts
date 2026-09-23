import type { TranscribeOptions, TranscriptionProvider, TranscriptionProviderInfo } from './types.js';

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * FallbackProvider — a cloud primary with the local backend behind it.
 *
 * A live meeting cannot lose transcription because a metered API hiccupped,
 * so a failed primary chunk is re-run on the local backend. After a failure
 * the primary is skipped for `cooldownMs`, so an outage costs one timeout,
 * not a 30 s stall on every chunk.
 */
export class FallbackProvider implements TranscriptionProvider {
  private skipPrimaryUntil = 0;

  constructor(
    private readonly primary: TranscriptionProvider,
    private readonly secondary: TranscriptionProvider,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (await this.primary.isAvailable()) return true;
    return this.secondary.isAvailable();
  }

  getInfo(): TranscriptionProviderInfo {
    return { ...this.primary.getInfo(), fallback: this.secondary.getInfo().mode };
  }

  async transcribe(
    wavBuffer: Buffer,
    options?: TranscribeOptions,
  ): Promise<{ text: string; mode?: TranscriptionProviderInfo['mode'] }> {
    if (this.now() >= this.skipPrimaryUntil) {
      try {
        const result = await this.primary.transcribe(wavBuffer, options);
        return { ...result, mode: this.primary.getInfo().mode };
      } catch (error) {
        this.skipPrimaryUntil = this.now() + this.cooldownMs;
        console.warn(
          `[Transcription] ${this.primary.getInfo().mode} failed — using ${this.secondary.getInfo().mode} for ${Math.round(this.cooldownMs / 1000)}s:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const result = await this.secondary.transcribe(wavBuffer, options);
    return { ...result, mode: this.secondary.getInfo().mode };
  }
}
