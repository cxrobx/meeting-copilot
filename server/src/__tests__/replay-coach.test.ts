import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import { readStoredCoach } from '../present/replay-coach.js';
import { SESSION_ID_RE } from '../session/ids.js';

const card = (n: number, createdAt: number) => ({
  id: `card-${n}`,
  incidentType: 'overcommitment',
  kind: 'address',
  priority: 5,
  confidence: 0.9,
  headline: `Qualify your capacity ${n}`,
  phrasing: `Let me be precise about capacity ${n}.`,
  why: 'an open-ended commitment',
  triggerQuote: 'we can do whatever you need',
  createdAt,
});

describe('coach history storage', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function tempStore(): SessionStore {
    const store = new SessionStore(`test-coach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    store.createSession('Coach test');
    cleanups.push(() => {
      try { store.close(); } catch { /* closed */ }
      rmSync(store.directory, { recursive: true, force: true });
    });
    return store;
  }

  it('keeps every card with the words it suggested, in order', () => {
    const store = tempStore();
    store.addCoachSuggestion(card(2, 2_000));
    store.addCoachSuggestion(card(1, 1_000));
    store.addCoachSuggestion(card(1, 1_000)); // a resend is not a second card

    const rows = store.getCoachSuggestions();
    expect(rows.map((r) => r.id)).toEqual(['card-1', 'card-2']);
    expect(rows[0]!.phrasing).toBe('Let me be precise about capacity 1.');
  });

  it('reads a stored session back for replay', () => {
    const store = tempStore();
    store.addCoachSuggestion(card(1, 1_000));
    store.close();
    const cards = readStoredCoach(store.directory);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ headline: 'Qualify your capacity 1', phrasing: 'Let me be precise about capacity 1.' });
  });

  it('recovers headline, kind and time from the event log of an older session', () => {
    // Sessions before the table existed (the 09-21 call) only logged these.
    const dir = mkdtempSync(join(tmpdir(), 'coach-events-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'events.jsonl'), [
      JSON.stringify({ timestamp: 1_000, event: 'coach.suggestion', kind: 'address', incidentType: 'overcommitment', priority: 5, confidence: 0.97, headline: 'Set a clear capacity boundary' }),
      JSON.stringify({ timestamp: 1_500, event: 'coach.eval', skipped: 'gate' }),
      '{"torn line',
      JSON.stringify({ timestamp: 2_000, event: 'coach.suggestion', kind: 'ask', incidentType: 'question', priority: 5, confidence: 0.94, headline: 'Answer the business-model question' }),
    ].join('\n'));

    const cards = readStoredCoach(dir);
    expect(cards.map((c) => c.headline)).toEqual(['Set a clear capacity boundary', 'Answer the business-model question']);
    expect(cards[0]!.phrasing).toBe('');
    expect(cards[1]!.createdAt).toBe(2_000);
  });

  it('only accepts a session id shaped like a UUID', () => {
    expect(SESSION_ID_RE.test('ec13fd2d-12e5-42cb-8fc0-6f39b1ec46fa')).toBe(true);
    expect(SESSION_ID_RE.test('../../etc')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
  });
});
