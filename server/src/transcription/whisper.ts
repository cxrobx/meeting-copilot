import type { TranscribeOptions, TranscriptionProvider, TranscriptionProviderInfo } from './types.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8078';
const INFERENCE_PATH = '/inference';
const AVAILABILITY_TIMEOUT_MS = 1_000;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

/**
 * WhisperProvider — transcribes by streaming WAV buffers to whisper-server.
 *
 * This keeps raw audio in memory and avoids writing temporary chunk files.
 */
export class WhisperProvider implements TranscriptionProvider {
  private serverUrl: string;
  private info: TranscriptionProviderInfo;

  constructor(
    serverUrl: string = DEFAULT_SERVER_URL,
    info: Partial<TranscriptionProviderInfo> = {},
  ) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.info = {
      mode: info.mode ?? 'whisper-server',
      model: info.model,
      endpoint: `${this.serverUrl}${INFERENCE_PATH}`,
      supportsPrompt: info.supportsPrompt ?? true,
      supportsKeyterms: info.supportsKeyterms ?? false,
      supportsPartials: false,
      streaming: false,
      supportsDiarization: false,
      audioStorage: 'memory-only',
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.serverUrl, {
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): TranscriptionProviderInfo {
    return this.info;
  }

  async transcribe(
    wavBuffer: Buffer,
    options?: TranscribeOptions,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([wavBuffer], { type: 'audio/wav' }),
      'chunk.wav',
    );
    if (options?.prompt && this.info.supportsPrompt) {
      // whisper-server's /inference endpoint accepts `prompt` as a form
      // field. Matches the CLI's --prompt flag. Capped at ~1500 chars
      // upstream to stay within whisper's 448-token context budget.
      form.set('prompt', options.prompt);
    }

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}${INFERENCE_PATH}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `whisper-server request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `whisper-server returned ${response.status}${body ? `: ${body}` : ''}`,
      );
    }

    const payload = (await response.json()) as { text?: string };
    return {
      text: payload.text?.trim() ?? '',
    };
  }
}
