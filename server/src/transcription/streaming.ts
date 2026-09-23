/**
 * Live streaming transcription (Grok) for both audio sources.
 *
 * The app sends every source twice: 100 ms PCM frames for this streamer, and
 * the VAD utterance chunks it always sent. While a source's stream is healthy,
 * its chunks are held briefly and not transcribed. If the stream fails, the
 * open line is closed with what Grok had, the held chunks that reach past it
 * are handed back (`replay`) for the local backend, and the stream reconnects
 * with backoff. So a network blip costs at most a re-transcribed tail, never
 * lost speech.
 *
 * Emits the same `{ segment, final }` events as TranscriptStitcher, so the
 * existing broadcast / persist path handles both. Grok's partials are the whole
 * utterance so far, so each one REPLACES the open line's text; they are not
 * appended like the stitcher's chunk fragments.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { GrokStream, keytermsFromPrompt, streamUrl, type GrokStreamEvent, type SocketFactory } from './grok-stream.js';
import type { TranscriptSegment, TranscriptionProviderInfo } from './types.js';

type Source = 'mic' | 'meeting';
const SOURCES: Source[] = ['mic', 'meeting'];

/** A source counts as streaming only while the app is actually sending frames. */
const FRAME_STALE_MS = 3_000;
const DEFAULT_REPLAY_WINDOW_MS = 20_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Close a long monologue at a locked sentence end, so one line doesn't grow forever. */
const MAX_OPEN_WORDS = 80;

export interface StreamingOptions {
  apiKey: string;
  model?: string;
  socketFactory?: SocketFactory;
  now?: () => number;
  backoffMs?: number[];
  replayWindowMs?: number;
}

interface Utterance {
  id: string;
  locked: string;
  current: string;
  firstSeenAt: number;
  audioStart: number | null; // wall ms
  audioEnd: number | null; // wall ms
}

interface HeldChunk<T> {
  endMs: number;
  chunk: T;
}

interface SourceState<T> {
  stream: GrokStream | null;
  lastFrameAt: number;
  utterance: Utterance | null;
  /** Wall ms through which the stream has produced text (final or partial). */
  coveredUntil: number;
  /** Audio end of the last closed line; events that end by then repeat it. */
  closedThrough: number;
  held: HeldChunk<T>[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  failures: number;
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return /^[,.;:!?)\]]/.test(right) ? left + right : `${left} ${right}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class StreamingTranscriber<TChunk = unknown> extends EventEmitter {
  private readonly states = new Map<Source, SourceState<TChunk>>();
  private active = false;
  private url = '';
  private readonly now: () => number;
  private readonly backoffMs: number[];
  private readonly replayWindowMs: number;

  constructor(private readonly opts: StreamingOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.replayWindowMs = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    for (const source of SOURCES) this.states.set(source, this.freshState());
  }

  get info(): TranscriptionProviderInfo {
    return {
      mode: 'grok',
      model: this.opts.model ?? 'grok-voice-transcribe-2.0',
      endpoint: 'wss://api.x.ai/v1/stt',
      supportsPrompt: true,
      supportsKeyterms: true,
      supportsPartials: true,
      streaming: true,
      supportsDiarization: false,
      audioStorage: 'remote-ephemeral',
    };
  }

  /** Open one stream per source for a new session. */
  start(sessionPrompt: string): void {
    this.stopTimers();
    this.active = true;
    this.url = streamUrl(keytermsFromPrompt(sessionPrompt), this.opts.model);
    for (const source of SOURCES) {
      this.states.set(source, this.freshState());
      this.connect(source);
    }
  }

  /** Drain both streams and close every open line. */
  async stop(): Promise<void> {
    this.active = false;
    this.stopTimers();
    await Promise.all(SOURCES.map((source) => this.state(source).stream?.finish()));
    for (const source of SOURCES) {
      this.closeUtterance(source);
      const state = this.state(source);
      state.stream = null;
      state.held = [];
    }
  }

  isHealthy(source: Source): boolean {
    const state = this.state(source);
    return this.active
      && state.stream?.ready === true
      && this.now() - state.lastFrameAt <= FRAME_STALE_MS;
  }

  /** Forward one PCM16 frame. */
  pushFrame(source: Source, pcm: Buffer): void {
    if (!this.active) return;
    const state = this.state(source);
    state.lastFrameAt = this.now();
    state.stream?.sendFrame(pcm);
  }

  /**
   * Decide whether a VAD chunk still needs the local backend. Returns true when
   * the stream covers it (the chunk is held for replay); false means transcribe
   * it locally now.
   */
  claimChunk(source: Source, captureEndedAtMs: number, chunk: TChunk): boolean {
    const state = this.state(source);
    if (!this.isHealthy(source)) {
      // Unhealthy, but the stream already produced text past this chunk's end:
      // it is a duplicate of what the transcript already has.
      return captureEndedAtMs <= state.coveredUntil;
    }
    const cutoff = this.now() - this.replayWindowMs;
    state.held = state.held.filter((h) => h.endMs >= cutoff);
    state.held.push({ endMs: captureEndedAtMs, chunk });
    return true;
  }

  private freshState(): SourceState<TChunk> {
    return { stream: null, lastFrameAt: 0, utterance: null, coveredUntil: 0, held: [], reconnectTimer: null, failures: 0, closedThrough: 0 };
  }

  private state(source: Source): SourceState<TChunk> {
    return this.states.get(source)!;
  }

  private stopTimers(): void {
    for (const state of this.states.values()) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  private connect(source: Source): void {
    const state = this.state(source);
    const stream = new GrokStream(this.opts.apiKey, this.url, this.opts.socketFactory, this.now);
    state.stream = stream;
    stream.on('ready', () => {
      state.failures = 0;
      console.log(`[Streaming] ${source} stream ready`);
    });
    stream.on('partial', (event: GrokStreamEvent) => {
      if (state.stream === stream) this.onPartial(source, stream, event);
    });
    stream.once('closed', (error?: Error) => {
      if (state.stream === stream) this.onClosed(source, error);
    });
    stream.connect();
  }

  private onPartial(source: Source, stream: GrokStream, event: GrokStreamEvent): void {
    const state = this.state(source);
    const base = stream.audioStartedAt ?? this.now();
    const audioStart = base + event.start * 1000;
    const audioEnd = base + (event.start + event.duration) * 1000;
    if (event.text) state.coveredUntil = Math.max(state.coveredUntil, audioEnd);

    let u = state.utterance;
    if (!u) {
      if (!event.text) return;
      // Grok repeats a locked chunk's text in its speech_final event. If the
      // line was already closed (long-monologue guard), that repeat must not
      // open a duplicate line.
      if (audioEnd <= state.closedThrough + 50) return;
      u = { id: randomUUID(), locked: '', current: '', firstSeenAt: this.now(), audioStart, audioEnd };
      state.utterance = u;
    }
    u.audioEnd = audioEnd;

    // Partials are cumulative within an utterance. If one ever repeats text
    // that is already locked, keep only what is new.
    let text = event.text;
    if (u.locked && text.startsWith(u.locked)) text = text.slice(u.locked.length).trim();

    if (event.isFinal) {
      u.locked = joinText(u.locked, text);
      u.current = '';
    } else {
      u.current = text;
    }

    const full = joinText(u.locked, u.current);
    const longAndDone = event.isFinal && wordCount(full) >= MAX_OPEN_WORDS && /[.?!]["')\]]?$/.test(full);
    if (event.speechFinal || longAndDone) {
      this.closeUtterance(source);
    } else if (full) {
      this.emit('segment', { segment: this.toSegment(source, u), final: false });
    }
  }

  private onClosed(source: Source, error?: Error): void {
    const state = this.state(source);
    state.stream = null;
    if (!this.active) return;

    console.warn(`[Streaming] ${source} stream closed${error ? `: ${error.message}` : ''} — local backend covers it until it reconnects`);
    // Keep what Grok had, then hand back held chunks that reach past it.
    this.closeUtterance(source);
    const replay = state.held.filter((h) => h.endMs > state.coveredUntil).map((h) => h.chunk);
    state.held = [];
    if (replay.length > 0) this.emit('replay', { source, chunks: replay });

    const delay = this.backoffMs[Math.min(state.failures, this.backoffMs.length - 1)]!;
    state.failures += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (this.active) this.connect(source);
    }, delay);
    if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref();
  }

  private closeUtterance(source: Source): void {
    const state = this.state(source);
    const u = state.utterance;
    state.utterance = null;
    if (!u) return;
    if (u.audioEnd !== null) state.closedThrough = Math.max(state.closedThrough, u.audioEnd);
    const segment = this.toSegment(source, u);
    if (segment.text) this.emit('segment', { segment, final: true });
  }

  private toSegment(source: Source, u: Utterance): TranscriptSegment {
    const text = joinText(u.locked, u.current);
    const audioDurationSec = u.audioStart !== null && u.audioEnd !== null
      ? Math.max(0, (u.audioEnd - u.audioStart) / 1000)
      : 0;
    return {
      id: u.id,
      text,
      source,
      label: source === 'mic' ? '[You]' : '[Meeting]',
      timestamp: u.firstSeenAt,
      audioDurationSec,
      // Speech-to-text lag: how far the text trails the audio it covers.
      transcriptionLatencyMs: u.audioEnd !== null ? Math.max(0, this.now() - u.audioEnd) : 0,
      provider: 'grok',
      captureStartedAt: u.audioStart !== null ? new Date(u.audioStart).toISOString() : undefined,
      captureEndedAt: u.audioEnd !== null ? new Date(u.audioEnd).toISOString() : undefined,
      wordCount: wordCount(text),
      duration: audioDurationSec,
    };
  }
}
