import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { SessionStore } from '../session/store.js';
import { readStoredPulses } from '../present/replay-pulse.js';

describe('pulse storage', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('keeps each pulse with its lists and reads it back for replay', () => {
    const store = new SessionStore(`test-pulse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    cleanups.push(() => {
      try { store.close(); } catch { /* closed */ }
      rmSync(store.directory, { recursive: true, force: true });
    });
    store.createSession('Pulse test');
    const base = {
      trigger: 'interval', status: 'drifting' as const, read: 'Your questions have not come up.',
      escalations: [{ text: 'Ask what they are buying.', why: 'Half the call is gone.' }],
      closeOut: [{ text: 'Propose a follow-up.', why: 'No next step.' }],
      minutesIn: 20, minutesLeft: 13, latencyMs: 22_000,
    };
    store.addPulse({ ...base, id: 'p2', mode: 'closeout', createdAt: 2_000, minutesLeft: null });
    store.addPulse({ ...base, id: 'p1', mode: 'pulse', createdAt: 1_000 });

    expect(store.getPulses().map((p) => p.id)).toEqual(['p1', 'p2']);
    store.close();

    const stored = readStoredPulses(store.directory);
    expect(stored[1]).toMatchObject({ mode: 'closeout', minutesLeft: null });
    expect(stored[0]!.escalations[0]!.why).toBe('Half the call is gone.');
  });

  it('is empty for a session from before pulses existed', () => {
    expect(readStoredPulses('/nonexistent/session')).toEqual([]);
  });
});
