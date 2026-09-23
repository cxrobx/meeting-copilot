import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
      missed: [] as Array<{ text: string; why: string }>,
      minutesIn: 20, minutesLeft: 13, latencyMs: 22_000,
    };
    store.addPulse({ ...base, id: 'p2', mode: 'closeout', createdAt: 2_000, minutesLeft: null });
    store.addPulse({ ...base, id: 'p1', mode: 'pulse', createdAt: 1_000 });
    store.addPulse({
      ...base, id: 'p3', mode: 'missed', trigger: 'missed', createdAt: 3_000,
      missed: [{ text: 'Dana asked about Q3 pricing.', why: 'No answer given.' }],
    });

    expect(store.getPulses().map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(store.getPulses()[2]!.missed[0]!.text).toBe('Dana asked about Q3 pricing.');
    store.close();

    const stored = readStoredPulses(store.directory);
    expect(stored[1]).toMatchObject({ mode: 'closeout', minutesLeft: null });
    expect(stored[0]!.escalations[0]!.why).toBe('Half the call is gone.');
  });

  it('adds the missed column to a pulse table written before it existed', () => {
    const id = `test-pulse-old-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const probe = new SessionStore(id);
    const dir = probe.directory;
    probe.close();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // The pulse table as the 2026-09-22 build wrote it: no missed column.
    const old = new Database(join(dir, 'session.db'));
    old.exec(`CREATE TABLE pulse (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, mode TEXT NOT NULL, trigger TEXT NOT NULL,
      status TEXT NOT NULL, read TEXT NOT NULL, escalations TEXT NOT NULL DEFAULT '[]',
      closeOut TEXT NOT NULL DEFAULT '[]', minutesIn INTEGER NOT NULL, minutesLeft INTEGER,
      latencyMs INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)`);
    old.close();

    const store = new SessionStore(id);
    cleanups.push(() => { try { store.close(); } catch { /* closed */ } });
    store.createSession('Old schema');
    store.addPulse({
      id: 'p1', mode: 'missed', trigger: 'missed', status: 'on_track', read: 'Fine.',
      escalations: [], closeOut: [], missed: [{ text: 'A dropped point.', why: '' }],
      minutesIn: 5, minutesLeft: null, latencyMs: 1, createdAt: 1,
    });
    expect(store.getPulses()[0]!.missed).toHaveLength(1);
  });

  it('is empty for a session from before pulses existed', () => {
    expect(readStoredPulses('/nonexistent/session')).toEqual([]);
  });
});
