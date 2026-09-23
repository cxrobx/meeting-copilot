import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const STREAM_URL = 'wss://api.x.ai/v1/stt';
const DEFAULT_MODEL = 'grok-voice-transcribe-2.0';
// xAI caps key-term biasing at 100 terms of 50 chars each.
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
// Silence (ms) before Grok calls an utterance final. xAI's default is 400;
// 300 matches the app's VAD silence and closes a line ~0.1 s sooner.
const ENDPOINTING_MS = 300;

/** One `transcript.partial` event, reduced to what the transcript needs. */
export interface GrokStreamEvent {
  text: string;
  /** Text is locked (a chunk of the utterance is final). */
  isFinal: boolean;
  /** The speaker stopped: the utterance is complete. */
  speechFinal: boolean;
  /** Seconds from the start of this connection's audio. */
  start: number;
  duration: number;
}

/** Minimal socket surface, so tests can drive the stream without a network. */
export interface StreamSocket {
  readonly readyState: number;
  send(data: Buffer | string): void;
  close(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SocketFactory = (url: string, apiKey: string) => StreamSocket;

const defaultSocketFactory: SocketFactory = (url, apiKey) =>
  new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } }) as unknown as StreamSocket;

/** Split the session prompt (attendees + agenda) into Grok key terms. */
export function keytermsFromPrompt(prompt: string): string[] {
  return prompt
    .replace(/(Meeting attendees|Topics):/gi, ',')
    .split(/[,;\n]|\.(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .slice(0, MAX_KEYTERMS)
    .map((s) => s.slice(0, MAX_KEYTERM_CHARS));
}

export function streamUrl(keyterms: string[], model = DEFAULT_MODEL): string {
  const params = new URLSearchParams({
    model,
    sample_rate: '16000',
    encoding: 'pcm',
    interim_results: 'true',
    language: 'en',
    endpointing: String(ENDPOINTING_MS),
  });
  for (const term of keyterms) params.append('keyterm', term);
  return `${STREAM_URL}?${params.toString()}`;
}

/**
 * One live connection to Grok's streaming STT for one audio source.
 *
 * Emits `ready` once xAI sends `transcript.created`, `partial` for each
 * transcript event, and `closed` exactly once when the connection ends for any
 * reason (with the error, if there was one). Frames sent before `ready` are
 * dropped rather than queued: the caller's fallback covers that audio.
 */
export class GrokStream extends EventEmitter {
  private socket: StreamSocket | null = null;
  private isReady = false;
  private ended = false;
  /** Wall-clock ms when the first frame went out: offset 0 of Grok's timeline. */
  audioStartedAt: number | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly url: string,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get ready(): boolean {
    return this.isReady && !this.ended;
  }

  connect(): void {
    const socket = this.socketFactory(this.url, this.apiKey);
    this.socket = socket;
    socket.on('message', (data) => this.onMessage(data));
    socket.on('error', (err) => this.end(err));
    socket.on('close', (code) => this.end(code === 1000 ? undefined : new Error(`closed (${code})`)));
  }

  /** Forward 16 kHz mono PCM16. Returns false when the frame was not sent. */
  sendFrame(pcm: Buffer): boolean {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.audioStartedAt === null) this.audioStartedAt = this.now();
    this.socket.send(pcm);
    return true;
  }

  /** Ask Grok to finish, wait up to `timeoutMs` for the last events, then close. */
  async finish(timeoutMs = 1_500): Promise<void> {
    if (this.ended || !this.socket) return;
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.once('closed', () => { clearTimeout(timer); resolve(); });
    });
    if (this.isReady && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'audio.done' }));
    }
    await done;
    this.close();
  }

  close(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
    }
    this.end();
  }

  private onMessage(data: Buffer): void {
    let event: { type?: string; text?: string; is_final?: boolean; speech_final?: boolean; start?: number; duration?: number; message?: string };
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.type === 'transcript.created') {
      this.isReady = true;
      this.emit('ready');
    } else if (event.type === 'transcript.partial') {
      this.emit('partial', {
        text: (event.text ?? '').trim(),
        isFinal: event.is_final === true,
        speechFinal: event.speech_final === true,
        start: event.start ?? 0,
        duration: event.duration ?? 0,
      } satisfies GrokStreamEvent);
    } else if (event.type === 'transcript.done') {
      this.close();
    } else if (event.type === 'error') {
      this.end(new Error(event.message ?? 'Grok stream error'));
    }
  }

  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.isReady = false;
    this.emit('closed', error);
  }
}
