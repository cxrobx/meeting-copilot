import { describe, expect, it } from 'vitest';
import { TrackWatch, hasSignal } from '../capture/track-watch.js';

const voice = () => { const b = Buffer.alloc(3200); b.writeInt16LE(420, 100); return b; };
const zeros = () => Buffer.alloc(3200);

function setup() {
  const clock = { t: 1_000_000 };
  const w = new TrackWatch({ now: () => clock.t, stallMs: 10_000, zeroMs: 15_000 });
  w.start();
  /** Advance in 100 ms frames, sending the given tracks each step. */
  const run = (ms: number, send: { mic?: () => Buffer; meeting?: () => Buffer }) => {
    const changes = [];
    for (let i = 0; i < ms; i += 100) {
      clock.t += 100;
      if (send.mic) w.frame('mic', send.mic());
      if (send.meeting) w.frame('meeting', send.meeting());
      changes.push(...w.check());
    }
    return changes;
  };
  return { w, run };
}

describe('TrackWatch', () => {
  it('reads any non-zero sample as signal', () => {
    expect(hasSignal(zeros())).toBe(false);
    expect(hasSignal(voice())).toBe(true);
  });

  it('flags the mic when it stops while the meeting keeps streaming (2026-09-25)', () => {
    const { w, run } = setup();
    expect(run(28_000, { mic: voice, meeting: voice })).toEqual([]);
    const changes = run(10_000, { meeting: voice });
    expect(changes).toEqual([{ track: 'mic', state: 'stalled', sinceMs: 10_000 }]);
    expect(w.snapshot()).toEqual({ mic: 'stalled', meeting: 'ok' });
  });

  it('flags a mic that never sends a frame while the meeting streams', () => {
    const { run } = setup();
    expect(run(10_000, { meeting: voice }).map((c) => [c.track, c.state])).toEqual([['mic', 'stalled']]);
  });

  it('clears the flag when the mic comes back', () => {
    const { w, run } = setup();
    run(12_000, { meeting: voice });
    const changes = run(200, { mic: voice, meeting: voice });
    expect(changes).toEqual([{ track: 'mic', state: 'ok', sinceMs: 0 }]);
    expect(w.state('mic')).toBe('ok');
  });

  it('does not blame one track when both stop (the app or socket went away)', () => {
    const { run } = setup();
    run(5_000, { mic: voice, meeting: voice });
    expect(run(30_000, {})).toEqual([]);
  });

  it('flags a mic delivering only exact zeros, but not a quiet one', () => {
    const { run } = setup();
    const quiet = () => { const b = Buffer.alloc(3200); b.writeInt16LE(-3, 0); return b; };
    expect(run(20_000, { mic: quiet, meeting: zeros })).toEqual([]);
    const changes = run(15_000, { mic: zeros, meeting: zeros });
    expect(changes.map((c) => [c.track, c.state])).toEqual([['mic', 'silent']]);
  });

  it('never calls the meeting track silent: a quiet call reads exact zero', () => {
    const { run } = setup();
    expect(run(60_000, { mic: voice, meeting: zeros })).toEqual([]);
  });

  it('judges nothing when stopped', () => {
    const { w, run } = setup();
    w.stop();
    expect(run(20_000, { meeting: voice })).toEqual([]);
  });
});
