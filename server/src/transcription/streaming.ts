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
import { NoiseGate, type GateFrame, type GateOptions } from './gate.js';

type Source = 'mic' | 'meeting';
const SOURCES: Source[] = ['mic', 'meeting'];

/** A source counts as streaming only while the app is actually sending frames. */
const FRAME_STALE_MS = 3_000;
const DEFAULT_REPLAY_WINDOW_MS = 20_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Close a long monologue at a locked sentence end, so one line doesn't grow forever. */
const MAX_OPEN_WORDS = 80;
/** Frames waiting for a (re)connecting stream: 10 s, oldest dropped past that. */
const MAX_PENDING_FRAMES = 100;
/** Slack when checking that the gate sent a chunk's whole time span. */
const SENT_TOLERANCE_MS = 250;
const BYTES_PER_SEC = 32_000; // 16 kHz mono PCM16

export interface StreamingOptions {
  apiKey: string;
  model?: string;
  socketFactory?: SocketFactory;
  now?: () => number;
  backoffMs?: number[];
  replayWindowMs?: number;
  /** Noise gate settings, or false to send every frame (COPILOT_STT_GATE=0). */
  gate?: GateOptions | false;
}

interface Utterance {
  id: string;
  locked: string;
  current: string;
  /** `current` restates the locked text, so it is the whole line on its own. */
  currentIsFull: boolean;
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
  /**
   * Text of lines closed early (word cap) while Grok's utterance goes on. Grok
   * keeps restating the utterance from its start, so this prefix is stripped
   * from its later events until the utterance really ends (speech_final).
   */
  carried: string;
  held: HeldChunk<T>[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  failures: number;
  gate: NoiseGate | null;
  /** Gated frames waiting for the stream to become ready, sent in order then. */
  pending: GateFrame[];
  pendingFinalize: boolean;
  /**
   * Grok's timestamps count only audio it received, so gated gaps vanish from
   * its timeline. Each run of contiguous frames starts a segment mapping
   * "seconds sent on this connection" back to wall-clock time.
   */
  timeline: Array<{ offset: number; wall: number }>;
  sentSec: number;
  /** All seconds sent this session, across reconnects. */
  billedSec: number;
  lastSentEnd: number | null;
  /** Wall-clock ranges actually sent to a ready stream (merged). */
  sentRanges: Array<[number, number]>;
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return /^[,.;:!?)\]]/.test(right) ? left + right : `${left} ${right}`;
}

const normWords = (t: string) => t.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Grok's later events repeat the whole utterance, but its formatting can shift
 * between them ("about like," → "about, like,"), so an exact prefix test misses
 * the repeat and the line doubles. Compare words instead: when `text` restates
 * `locked`, it is the fresher full utterance and replaces it.
 */
/** Drop the first `n` normalized words from `text`, keeping its original formatting. */
export function dropLeadingWords(text: string, n: number): string {
  if (n <= 0) return text;
  const tokens = text.split(/\s+/).filter(Boolean);
  let seen = 0;
  let i = 0;
  while (i < tokens.length && seen < n) {
    seen += normWords(tokens[i]!).length;
    i++;
  }
  return tokens.slice(i).join(' ').replace(/^[,.;:!?]+\s*/, '');
}

export function restatesLocked(locked: string, text: string): boolean {
  const l = normWords(locked);
  const t = normWords(text);
  if (l.length === 0 || t.length < l.length) return false;
  let same = 0;
  for (let i = 0; i < l.length; i++) if (l[i] === t[i]) same++;
  return same / l.length >= 0.8;
}

function lineText(u: { locked: string; current: string; currentIsFull: boolean }): string {
  return u.currentIsFull ? u.current : joinText(u.locked, u.current);
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
      state.pending = [];
      state.gate?.reset();
    }
  }

  isHealthy(source: Source): boolean {
    const state = this.state(source);
    return this.active
      && state.stream?.ready === true
      && this.now() - state.lastFrameAt <= FRAME_STALE_MS;
  }

  /**
   * One PCM16 frame from the app. It goes through the noise gate; what the gate
   * lets out is sent (or queued while the stream connects). `at` is when the
   * frame's audio began; it defaults to one frame before arrival.
   */
  pushFrame(source: Source, pcm: Buffer, at?: number): void {
    if (!this.active) return;
    const state = this.state(source);
    const now = this.now();
    state.lastFrameAt = now;
    const frame: GateFrame = { pcm, at: at ?? now - (pcm.length / BYTES_PER_SEC) * 1000 };
    const result = state.gate ? state.gate.process(frame) : { send: [frame], closed: false };
    for (const f of result.send) this.enqueue(source, f);
    if (result.closed) {
      if (state.stream?.ready && state.pending.length === 0) state.stream.finalize();
      else state.pendingFinalize = true;
    }
  }

  /** Seconds of audio actually sent to Grok (what xAI bills), per source. */
  get sentSeconds(): Record<Source, number> {
    return { mic: this.state('mic').billedSec, meeting: this.state('meeting').billedSec } as Record<Source, number>;
  }

  private enqueue(source: Source, frame: GateFrame): void {
    const state = this.state(source);
    if (state.stream?.ready && state.pending.length === 0) {
      this.sendNow(source, frame);
      return;
    }
    state.pending.push(frame);
    if (state.pending.length > MAX_PENDING_FRAMES) state.pending.shift();
    // Speech while the stream is down between retries: reconnect now rather
    // than wait out the backoff. The queued frames go out once it is ready.
    if (!state.stream) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      this.connect(source);
    }
  }

  private sendNow(source: Source, frame: GateFrame): void {
    const state = this.state(source);
    if (!state.stream?.sendFrame(frame.pcm)) return;
    const durMs = (frame.pcm.length / BYTES_PER_SEC) * 1000;
    if (state.lastSentEnd === null || Math.abs(frame.at - state.lastSentEnd) > 50) {
      state.timeline.push({ offset: state.sentSec, wall: frame.at });
    }
    state.sentSec += durMs / 1000;
    state.billedSec += durMs / 1000;
    state.lastSentEnd = frame.at + durMs;
    const last = state.sentRanges.at(-1);
    if (last && frame.at - last[1] <= 50) last[1] = frame.at + durMs;
    else state.sentRanges.push([frame.at, frame.at + durMs]);
  }

  private flushPending(source: Source): void {
    const state = this.state(source);
    const queued = state.pending;
    state.pending = [];
    for (const f of queued) this.sendNow(source, f);
    if (state.pendingFinalize) {
      state.pendingFinalize = false;
      state.stream?.finalize();
    }
  }

  /** Map a Grok offset (seconds sent on this connection) to wall-clock ms. */
  private wallAt(state: SourceState<TChunk>, offsetSec: number): number {
    let seg = state.timeline[0];
    if (!seg) return this.now();
    for (const s of state.timeline) {
      if (s.offset <= offsetSec + 1e-6) seg = s;
      else break;
    }
    return seg.wall + (offsetSec - seg.offset) * 1000;
  }

  /**
   * Decide whether a VAD chunk still needs the local backend. Returns true when
   * the stream covers it (the chunk is held for replay); false means transcribe
   * it locally now.
   */
  claimChunk(source: Source, captureStartedAtMs: number, captureEndedAtMs: number, chunk: TChunk): boolean {
    const state = this.state(source);
    const cutoff = this.now() - this.replayWindowMs;
    state.sentRanges = state.sentRanges.filter((r) => r[1] >= cutoff);
    // Only skip a chunk the gate actually SENT in full. Speech the gate never
    // opened for (too quiet) falls through to the local backend: late, not lost.
    const sent = state.sentRanges.some(
      ([a, b]) => a <= captureStartedAtMs + SENT_TOLERANCE_MS && b >= captureEndedAtMs - SENT_TOLERANCE_MS,
    );
    if (this.isHealthy(source) && sent) {
      state.held = state.held.filter((h) => h.endMs >= cutoff);
      state.held.push({ endMs: captureEndedAtMs, chunk });
      return true;
    }
    // The stream already produced text past this chunk's end: a duplicate.
    return captureEndedAtMs <= state.coveredUntil;
  }

  private freshState(): SourceState<TChunk> {
    return {
      stream: null, lastFrameAt: 0, utterance: null, coveredUntil: 0, held: [], reconnectTimer: null,
      failures: 0, closedThrough: 0, carried: '',
      gate: this.opts.gate === false ? null : new NoiseGate(this.opts.gate ?? {}),
      pending: [], pendingFinalize: false, timeline: [], sentSec: 0, billedSec: 0, lastSentEnd: null, sentRanges: [],
    };
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
    state.timeline = [];
    state.sentSec = 0;
    state.lastSentEnd = null;
    stream.on('ready', () => {
      if (state.stream !== stream) return;
      state.failures = 0;
      console.log(`[Streaming] ${source} stream ready`);
      this.flushPending(source);
    });
    stream.on('partial', (event: GrokStreamEvent) => {
      if (state.stream === stream) this.onPartial(source, event);
    });
    stream.once('closed', (error?: Error) => {
      if (state.stream === stream) this.onClosed(source, error);
    });
    stream.connect();
  }

  private onPartial(source: Source, event: GrokStreamEvent): void {
    const state = this.state(source);
    const audioStart = this.wallAt(state, event.start);
    const audioEnd = this.wallAt(state, event.start + event.duration);
    if (event.text) state.coveredUntil = Math.max(state.coveredUntil, audioEnd);

    // Strip what an early-closed line already carried from this utterance.
    let eventText = event.text;
    if (state.carried) {
      if (restatesLocked(state.carried, eventText)) {
        eventText = dropLeadingWords(eventText, normWords(state.carried).length);
      }
      if (event.speechFinal) state.carried = '';
      if (!eventText) {
        if (event.speechFinal) this.closeUtterance(source);
        return;
      }
    }

    let u = state.utterance;
    if (!u) {
      eventText = eventText.replace(/^[,.;:!?]+\s*/, ''); // a new line never starts with punctuation
      if (!eventText) return;
      // An event that ends where the last closed line ended only repeats it.
      if (audioEnd <= state.closedThrough + 50) return;
      u = { id: randomUUID(), locked: '', current: '', currentIsFull: false, firstSeenAt: this.now(), audioStart, audioEnd };
      state.utterance = u;
    }
    u.audioEnd = audioEnd;

    // Partials are cumulative within an utterance. An event that restates the
    // locked text is the whole utterance again: it replaces, never appends.
    const text = eventText;
    const restates = u.locked !== '' && restatesLocked(u.locked, text);
    if (event.isFinal) {
      u.locked = restates ? text : joinText(u.locked, text);
      u.current = '';
      u.currentIsFull = false;
    } else {
      u.current = text;
      u.currentIsFull = restates;
    }

    const full = lineText(u);
    const longAndDone = event.isFinal && wordCount(full) >= MAX_OPEN_WORDS && /[.?!]["')\]]?$/.test(full);
    if (event.speechFinal || longAndDone) {
      if (longAndDone && !event.speechFinal) state.carried = joinText(state.carried, full);
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
    const text = lineText(u);
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
