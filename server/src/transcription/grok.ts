import type { TranscribeOptions, TranscriptionProvider, TranscriptionProviderInfo } from './types.js';

const API_BASE = 'https://api.x.ai/v1';
const STT_PATH = '/stt';
const DEFAULT_MODEL = 'grok-voice-transcribe-2.0';
const AVAILABILITY_TIMEOUT_MS = 5_000;
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
// xAI caps key-term biasing at 100 terms of 50 chars each.
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;

interface GrokSttResponse {
  text?: string;
}

/**
 * GrokProvider — transcribes WAV buffers via xAI's batch STT REST endpoint.
 *
 * Grok Voice Transcribe 2.0 is the cloud default since 2026-09-22: 2.3%
 * AA-WER vs Nova-3's 5.2% on Artificial Analysis's non-streaming board, at
 * $0.10/hr of audio. Requires XAI_API_KEY. Plain fetch, no SDK.
 */
export class GrokProvider implements TranscriptionProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey ?? process.env.XAI_API_KEY ?? '';
    this.model = model ?? process.env.GROK_STT_MODEL ?? DEFAULT_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): TranscriptionProviderInfo {
    return {
      mode: 'grok',
      model: this.model,
      endpoint: `${API_BASE}${STT_PATH}`,
      supportsPrompt: true,
      supportsKeyterms: true,
      supportsPartials: false,
      streaming: false,
      supportsDiarization: false,
      audioStorage: 'remote-ephemeral',
    };
  }

  async transcribe(
    wavBuffer: Buffer,
    options?: TranscribeOptions,
  ): Promise<{ text: string }> {
    if (!this.apiKey) {
      throw new Error('XAI_API_KEY is not set');
    }

    const form = new FormData();
    form.append('model', this.model);
    form.append('language', 'en');
    form.append('format', 'true');
    // Same split as Deepgram: the session prompt (agenda + attendees) becomes
    // key terms, the closest equivalent to whisper's initial_prompt.
    for (const term of (options?.prompt ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_KEYTERMS)) {
      form.append('keyterm', term.slice(0, MAX_KEYTERM_CHARS));
    }
    // xAI requires the file to be the LAST multipart field.
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${STT_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Grok STT request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Grok STT returned ${response.status}${body ? `: ${body.slice(0, 400)}` : ''}`);
    }

    const payload = (await response.json()) as GrokSttResponse;
    return { text: (payload.text ?? '').trim() };
  }
}
