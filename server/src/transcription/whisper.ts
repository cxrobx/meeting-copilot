import type { TranscriptionProvider } from './types.js';

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

  constructor(serverUrl: string = DEFAULT_SERVER_URL) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
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

  getInfo(): { mode: 'whisper-server'; endpoint: string } {
    return { mode: 'whisper-server', endpoint: `${this.serverUrl}${INFERENCE_PATH}` };
  }

  async transcribe(wavBuffer: Buffer): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([wavBuffer], { type: 'audio/wav' }),
      'chunk.wav',
    );

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
