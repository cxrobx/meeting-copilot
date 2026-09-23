import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoiseGate, frameRms } from '../transcription/gate.js';
import { StreamingTranscriber } from '../transcription/streaming.js';
import type { StreamSocket } from '../transcription/grok-stream.js';
import type { TranscriptSegment } from '../transcription/types.js';

/** 100 ms of a 220 Hz tone at `amp` (0–1), as 16 kHz PCM16. */
function tone(amp: number): Buffer {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * amp * 32767), i * 2);
  return b;
}
const SILENCE = Buffer.alloc(3200);
const SPEECH = tone(0.2);
const ONSET = tone(0.003); // a soft "h"/"s" onset: under the 0.004 floor, never opens the gate alone

afterEach(() => vi.restoreAllMocks());

describe('NoiseGate', () => {
  it('stays shut on silence and soft noise', () => {
    const g = new NoiseGate();
    for (let i = 0; i < 50; i++) expect(g.process({ pcm: i % 2 ? SILENCE : ONSET, at: i * 100 }).send).toEqual([]);
    expect(g.isOpen).toBe(false);
  });

  it('sends the 500 ms before the opening frame, oldest first (the first word is not clipped)', () => {
    const g = new NoiseGate();
    for (let i = 0; i < 20; i++) g.process({ pcm: SILENCE, at: i * 100 });
    for (let i = 20; i < 23; i++) g.process({ pcm: ONSET, at: i * 100 }); // soft onset, below threshold
    const r = g.process({ pcm: SPEECH, at: 2_300 });
    expect(r.send.map((f) => f.at)).toEqual([1_800, 1_900, 2_000, 2_100, 2_200, 2_300]);
    expect(r.send.slice(2, 5).every((f) => f.pcm === ONSET)).toBe(true);
    expect(g.isOpen).toBe(true);
  });

  it('holds through a pause shorter than 1.5 s, then closes once and says so', () => {
    const g = new NoiseGate();
    g.process({ pcm: SPEECH, at: 0 });
    for (let i = 1; i <= 14; i++) {
      const r = g.process({ pcm: SILENCE, at: i * 100 });
      expect(r).toMatchObject({ closed: false });
      expect(r.send).toHaveLength(1); // the pause itself is sent: Grok needs it to end the sentence
    }
    expect(g.process({ pcm: SPEECH, at: 1_500 }).closed).toBe(false); // resumed inside the hold
    let closedAt = -1;
    for (let i = 16; i < 40; i++) if (g.process({ pcm: SILENCE, at: i * 100 }).closed) { closedAt = i; break; }
    expect(closedAt).toBe(30); // 15 silent frames after the last loud one
    expect(g.isOpen).toBe(false);
  });

  it('adapts to a steady noise floor instead of opening on it', () => {
    const g = new NoiseGate();
    const hum = tone(0.01); // room hum well above the absolute floor
    // The first seconds of hum may open it; once the floor has adapted it stays shut.
    for (let i = 0; i < 600; i++) g.process({ pcm: hum, at: i * 100 });
    for (let i = 0; i < 100; i++) expect(g.process({ pcm: hum, at: 60_000 + i * 100 }).send).toEqual([]);
    expect(frameRms(SPEECH)).toBeGreaterThan(frameRms(hum) * 4);
    expect(g.process({ pcm: SPEECH, at: 70_000 }).send.length).toBeGreaterThan(0);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Buffer | string> = [];
  send(data: Buffer | string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  server(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

function setup() {
  const now = { t: 1_000_000 };
  const sockets: FakeSocket[] = [];
  const st = new StreamingTranscriber<string>({
    apiKey: 'k', now: () => now.t, backoffMs: [60_000],
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as StreamSocket; },
  });
  const events: Array<{ segment: TranscriptSegment; final: boolean }> = [];
  st.on('segment', (e) => events.push(e));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  /** Push `n` frames of `pcm` on `source`, advancing the clock 100 ms each. */
  const feed = (source: 'mic' | 'meeting', pcm: Buffer, n: number) => {
    for (let i = 0; i < n; i++) { st.pushFrame(source, pcm, now.t); now.t += 100; }
  };
  return { st, sockets, events, now, feed };
}

const audio = (s: FakeSocket) => s.sent.filter((x): x is Buffer => Buffer.isBuffer(x));
const json = (s: FakeSocket) => s.sent.filter((x): x is string => typeof x === 'string');

describe('StreamingTranscriber with the gate', () => {
  it('sends only speech (plus pre-roll and hold), and finalizes when the gate closes', () => {
    const { st, sockets, feed } = setup();
    st.start('');
    const m = sockets[1]!;
    m.server({ type: 'transcript.created' });
    feed('meeting', SILENCE, 100); // 10 s of silence: nothing sent, nothing billed
    expect(audio(m)).toHaveLength(0);
    feed('meeting', SPEECH, 20);
    feed('meeting', SILENCE, 30);
    // 5 pre-roll + 20 speech + 15 hold frames
    expect(audio(m)).toHaveLength(40);
    expect(json(m)).toContain(JSON.stringify({ type: 'finalize' }));
    expect(st.sentSeconds.meeting).toBeCloseTo(4, 5);
  });

  it("maps Grok's gap-free timeline back to the wall clock", () => {
    const { st, sockets, events, now, feed } = setup();
    st.start('');
    const m = sockets[1]!;
    m.server({ type: 'transcript.created' });
    const t0 = now.t;
    feed('meeting', SPEECH, 10); // sent offsets 0–1.0 s  = wall t0 .. t0+1 s
    feed('meeting', SILENCE, 200); // 1.5 s hold sent (offset 1.0–2.5), then 18.5 s gated
    const second = now.t;
    feed('meeting', SPEECH, 10);
    // Grok says the second utterance starts at offset 2.5 s (after 1 s speech + 1.5 s hold)...
    m.server({ type: 'transcript.partial', text: 'second', is_final: true, speech_final: true, start: 2.5, duration: 1 });
    const seg = events.at(-1)!.segment;
    // ...which is 20.5 s later on the wall clock than a naive offset would say. Pre-roll was silence at
    // second-500 ms, so offset 2.5 maps to the first pre-roll frame.
    expect(Date.parse(seg.captureStartedAt!)).toBe(second - 500);
    expect(Date.parse(seg.captureStartedAt!)).toBeGreaterThan(t0 + 20_000);
  });

  it('while the stream is healthy it owns gated stretches too: no local re-transcription, no duplicates', () => {
    const { st, sockets, now, feed } = setup();
    st.start('');
    sockets[1]!.server({ type: 'transcript.created' });
    feed('meeting', ONSET, 40); // quiet enough that the gate stays shut
    expect(st.claimChunk('meeting', now.t, 'quiet')).toBe(true); // held, not sent to Parakeet
    feed('meeting', SPEECH, 40);
    expect(st.claimChunk('meeting', now.t, 'speech')).toBe(true);
  });

  it('speech while the stream is down reconnects at once and sends the buffered start in order', () => {
    const { st, sockets, feed } = setup();
    st.start('');
    const first = sockets[1]!;
    first.server({ type: 'transcript.created' });
    first.emit('close', 1006); // dropped during silence; the retry waits a 60 s backoff
    feed('meeting', SILENCE, 10);
    expect(sockets).toHaveLength(2);
    feed('meeting', SPEECH, 3); // speech: reconnect now, don't wait out the backoff
    expect(sockets).toHaveLength(3);
    const next = sockets[2]!;
    feed('meeting', SPEECH, 2); // still connecting: queued
    expect(audio(next)).toHaveLength(0);
    next.server({ type: 'transcript.created' });
    // 5 pre-roll + 5 speech, flushed in capture order
    expect(audio(next)).toHaveLength(10);
    expect(audio(next).slice(0, 5).every((b) => b.equals(SILENCE))).toBe(true);
    expect(audio(next).slice(5).every((b) => b.equals(SPEECH))).toBe(true);
  });
});
