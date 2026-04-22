import type { TranscribeOptions, TranscriptionProvider } from './types.js';

const API_BASE = 'https://api.deepgram.com/v1';
const LISTEN_PATH = '/listen';
const AVAILABILITY_TIMEOUT_MS = 5_000;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
}

/**
 * DeepgramProvider — transcribes WAV buffers via the Deepgram REST API.
 *
 * Uses the nova-2 model with smart formatting. Requires DEEPGRAM_API_KEY.
 * No SDK dependency — uses plain fetch against the REST endpoint.
 */
export class DeepgramProvider implements TranscriptionProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.DEEPGRAM_API_KEY ?? '';
  }

  /**
   * Checks whether the provider can be used:
   * 1. API key must be set
   * 2. Deepgram API must respond to a lightweight request
   */
  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }

    try {
      // Hit the projects endpoint as a lightweight health check.
      // Any authenticated endpoint that returns quickly works here.
      const response = await fetch(`${API_BASE}/projects`, {
        method: 'GET',
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): { mode: 'deepgram'; model: 'nova-2' } {
    return { mode: 'deepgram', model: 'nova-2' };
  }

  async transcribe(
    wavBuffer: Buffer,
    _options?: TranscribeOptions,
  ): Promise<{ text: string }> {
    // Deepgram exposes its own `keywords` param rather than whisper's
    // initial_prompt; intentionally ignored for MVP.
    if (!this.apiKey) {
      throw new Error('DEEPGRAM_API_KEY is not set');
    }

    const params = new URLSearchParams({
      model: 'nova-2',
      smart_format: 'true',
      language: 'en',
    });

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${LISTEN_PATH}?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: wavBuffer,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Deepgram request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Deepgram returned ${response.status}${body ? `: ${body}` : ''}`,
      );
    }

    const payload = (await response.json()) as DeepgramResponse;
    const transcript =
      payload.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';

    return {
      text: transcript.trim(),
    };
  }
}
