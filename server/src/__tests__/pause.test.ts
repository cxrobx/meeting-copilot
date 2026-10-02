import { describe, expect, it } from 'vitest';
import { PauseClock, pauseMarkerText } from '../session/pause.js';

describe('PauseClock', () => {
  it('counts paused time, the open pause included, and ends a pause once', () => {
    let t = 1_000;
    const clock = new PauseClock(() => t);
    expect(clock.snapshot()).toEqual({ paused: false, pausedAt: null, pausedMs: 0 });

    expect(clock.pause()).toBe(true);
    expect(clock.pause()).toBe(false); // a second press is not a second pause
    t += 30_000;
    expect(clock.snapshot()).toEqual({ paused: true, pausedAt: 1_000, pausedMs: 30_000 });

    expect(clock.resume()).toEqual({ startedAt: 1_000, endedAt: 31_000 });
    expect(clock.resume()).toBeNull();
    t += 60_000;
    clock.pause();
    t += 10_000;
    expect(clock.pausedMs()).toBe(40_000);
    clock.resume();
    t += 5_000;
    expect(clock.snapshot()).toEqual({ paused: false, pausedAt: null, pausedMs: 40_000 });

    clock.reset();
    expect(clock.snapshot()).toEqual({ paused: false, pausedAt: null, pausedMs: 0 });
  });
});

describe('pauseMarkerText', () => {
  it('says how long, from when to when, and that nothing was recorded', () => {
    const start = new Date(2026, 9, 2, 14, 2).getTime();
    const text = pauseMarkerText({ startedAt: start, endedAt: start + 17 * 60_000 }, 'en-US');
    expect(text).toBe('Paused 17 min (2:02 PM\u20132:19 PM). Nothing was recorded.');
  });

  it('never says 0 min', () => {
    expect(pauseMarkerText({ startedAt: 0, endedAt: 5_000 }, 'en-US')).toMatch(/^Paused under a minute \(/);
  });
});
