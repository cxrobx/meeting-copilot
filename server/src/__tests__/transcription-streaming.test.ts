import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamingTranscriber } from '../transcription/streaming.js';
import { keytermsFromPrompt, streamUrl, type StreamSocket } from '../transcription/grok-stream.js';
import type { TranscriptSegment } from '../transcription/types.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Buffer | string> = [];
  constructor(readonly url: string) { super(); }
  send(data: Buffer | string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  server(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  partial(text: string, opts: { final?: boolean; speech?: boolean; start?: number; duration?: number } = {}) {
    this.server({
      type: 'transcript.partial', text,
      is_final: opts.final ?? false, speech_final: opts.speech ?? false,
      start: opts.start ?? 0, duration: opts.duration ?? 1,
    });
  }
}

function setup(now = { t: 1_000_000 }, gate: false | object = false) {
  const sockets: FakeSocket[] = [];
  const st = new StreamingTranscriber<string>({
    apiKey: 'k',
    gate: gate as false,
    now: () => now.t,
    backoffMs: [10_000],
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as unknown as StreamSocket;
    },
  });
  const events: Array<{ segment: TranscriptSegment; final: boolean }> = [];
  st.on('segment', (e) => events.push(e));
  const replays: Array<{ source: string; chunks: string[] }> = [];
  st.on('replay', (e) => replays.push(e));
  return { st, sockets, events, replays, now };
}

afterEach(() => vi.restoreAllMocks());

describe('keyterms', () => {
  it('turns the session prompt into Grok key terms', () => {
    expect(keytermsFromPrompt('Meeting attendees: Marcus, Rory. Topics: ACME deck; Atlas IQ.')).toEqual(['Marcus', 'Rory', 'ACME deck', 'Atlas IQ']);
    const url = new URL(streamUrl(['ACME', 'Atlas IQ']));
    expect(url.searchParams.getAll('keyterm')).toEqual(['ACME', 'Atlas IQ']);
    expect(url.searchParams.get('interim_results')).toBe('true');
  });
});

describe('StreamingTranscriber', () => {
  it('replaces the open line with each partial and finalizes on speech_final', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    const meeting = sockets[1]!;
    meeting.server({ type: 'transcript.created' });
    st.pushFrame('meeting', Buffer.alloc(3200));
    expect(meeting.sent).toHaveLength(1);

    meeting.partial('Marcus');
    meeting.partial('Marcus, let us review');
    meeting.partial('Marcus, let us review the deck.', { final: true, speech: true, duration: 2.5 });

    expect(events.map((e) => [e.segment.text, e.final])).toEqual([
      ['Marcus', false],
      ['Marcus, let us review', false],
      ['Marcus, let us review the deck.', true],
    ]);
    const ids = new Set(events.map((e) => e.segment.id));
    expect(ids.size).toBe(1); // one line, replaced in place
    expect(events[2]!.segment).toMatchObject({ source: 'meeting', provider: 'grok', audioDurationSec: 2.5 });

    meeting.partial('Next thing', { start: 3 });
    expect(events.at(-1)!.segment.id).not.toBe(events[0]!.segment.id);
  });

  it('appends locked chunks and does not repeat locked text', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    const mic = sockets[0]!;
    mic.server({ type: 'transcript.created' });
    mic.partial('First part', { final: true });
    mic.partial('First part and more'); // cumulative repeat of the locked text
    mic.partial('and more.', { final: true, speech: true });
    expect(events.at(-1)).toMatchObject({ final: true, segment: { text: 'First part and more.' } });
    expect(events.map((e) => e.segment.text)).toContain('First part and more');
  });

  it('a restated utterance with shifted punctuation replaces the locked text instead of doubling it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    const m = sockets[1]!;
    m.server({ type: 'transcript.created' });
    // Real Grok sequence from the 2026-09-21 replay: the final restates the line with a comma moved.
    m.partial('she had a lot of great things to say about like, it seems like you built something', { final: true });
    m.partial('she had a lot of great things to say about, like, it seems like you built something cool.', { final: true, speech: true });
    expect(events.at(-1)).toMatchObject({
      final: true,
      segment: { text: 'she had a lot of great things to say about, like, it seems like you built something cool.' },
    });
  });

  it('a long line closed on a locked chunk is not reopened by the speech_final repeat', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    const m = sockets[1]!;
    m.server({ type: 'transcript.created' });
    st.pushFrame('meeting', Buffer.alloc(3200));
    const long = `${'word '.repeat(85).trim()}.`;
    m.partial(long, { final: true, start: 0, duration: 30 });
    m.partial(long, { final: true, speech: true, start: 0, duration: 30 });
    const finals = events.filter((e) => e.final);
    expect(finals).toHaveLength(1);
    m.partial('A new sentence', { start: 31, duration: 1 });
    expect(events.at(-1)!.segment.text).toBe('A new sentence');
  });

  it('after the word cap closes a line, the rest of the utterance continues without repeating it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    const m = sockets[0]!;
    m.server({ type: 'transcript.created' });
    st.pushFrame('mic', Buffer.alloc(3200)); // starts the audio timeline
    const first = `${'one '.repeat(84)}end.`; // 85 words, closes at the cap
    m.partial(first, { final: true, start: 0, duration: 30 });
    // Real Grok: later events restate the whole utterance (formatting may shift).
    m.partial(`${first.replace('end.', 'end,')} and then more words`, { start: 0, duration: 33 });
    m.partial(`${first} And then more words.`, { final: true, speech: true, start: 0, duration: 34 });
    const finals = events.filter((e) => e.final).map((e) => e.segment.text);
    expect(finals).toEqual([first, 'And then more words.']);
  });

  it('holds chunks while healthy and releases only what the stream did not cover when it fails', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { st, sockets, events, replays, now } = setup();
    st.start('');
    const meeting = sockets[1]!;
    meeting.server({ type: 'transcript.created' });
    const t0 = now.t;
    for (let i = 0; i < 60; i++) { st.pushFrame('meeting', Buffer.alloc(3200), t0 + i * 100); now.t = t0 + (i + 1) * 100; }

    expect(st.claimChunk('meeting', t0 + 2_000, 'chunk-A')).toBe(true);
    meeting.partial('covered words', { start: 0, duration: 3 }); // covers through t0 + 3 s
    expect(st.claimChunk('meeting', t0 + 5_500, 'chunk-B')).toBe(true);

    meeting.emit('error', new Error('socket reset'));

    expect(events.at(-1)).toMatchObject({ final: true, segment: { text: 'covered words' } });
    expect(replays).toEqual([{ source: 'meeting', chunks: ['chunk-B'] }]);
    // While down: a chunk the stream already covered is dropped, a new one is not.
    expect(st.isHealthy('meeting')).toBe(false);
    expect(st.claimChunk('meeting', t0 + 2_500, 'old')).toBe(true);
    expect(st.claimChunk('meeting', t0 + 9_000, 'new')).toBe(false);
  });

  it('is not healthy until the app actually sends frames (older app builds)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { st, sockets } = setup();
    st.start('');
    sockets[0]!.server({ type: 'transcript.created' });
    expect(st.isHealthy('mic')).toBe(false);
    expect(st.claimChunk('mic', Date.now(), 'c')).toBe(false);
  });

  it('reconnects after a failure and finalizes open lines on stop', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { st, sockets, events } = setup();
    st.start('');
    sockets[0]!.emit('close', 1006);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(3); // mic reconnected

    const mic = sockets[2]!;
    mic.server({ type: 'transcript.created' });
    mic.partial('half a sentence');
    const stopped = st.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(mic.sent).toContain(JSON.stringify({ type: 'audio.done' }));
    expect(events.at(-1)).toMatchObject({ final: true, segment: { text: 'half a sentence' } });
    vi.useRealTimers();
  });
});
