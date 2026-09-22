import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoachMonitor,
  TYPE_COOLDOWN_MS,
  detectMoment,
  type CoachSuggestion,
} from '../intelligence/coach.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function result(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hasSuggestion: true,
    kind: 'address',
    incidentType: 'bad_answer',
    priority: 5,
    confidence: 0.9,
    headline: 'Reset the answer',
    phrasing: 'Let me answer that more directly: the constraint is capacity, not willingness.',
    why: 'the prior answer did not resolve the concern',
    triggerQuote: 'I think we can probably do that',
    expiresInMs: 15_000,
    ...overrides,
  });
}

describe('detectMoment', () => {
  it('detects client pressure and objections', () => {
    expect(detectMoment('We need you to commit by Friday.', 'meeting')).toBe('moment:pressure');
    expect(detectMoment("That doesn't answer what I asked.", 'meeting')).toBe('moment:objection');
  });

  it('reviews a finalized mic answer after a meeting question', () => {
    expect(detectMoment(
      'I think we can probably make that work.',
      'mic',
      {
        final: true,
        previousSource: 'meeting',
        previousText: 'Can you commit to Friday?',
      },
    )).toBe('moment:answer-review');
  });

  it('detects an explicit mic commitment without waiting for a reaction', () => {
    expect(detectMoment('We will have that to you by Friday.', 'mic')).toBe('moment:overcommitment');
  });

  it('does not trigger on ordinary conversation', () => {
    expect(detectMoment('Thanks, that context is helpful.', 'meeting')).toBeNull();
    expect(detectMoment('Let me pull up the latest version.', 'mic')).toBeNull();
    expect(detectMoment('What permissions do I need to configure?', 'meeting')).toBeNull();
    expect(detectMoment('The tool has to confirm its own tests.', 'meeting')).toBeNull();
  });

  it('does not review a mic turn after a question that was not directed at the user', () => {
    expect(detectMoment(
      "I don't know.",
      'mic',
      {
        final: true,
        previousSource: 'meeting',
        previousText: "What is the overall feature we're building?",
      },
    )).toBeNull();
  });
});

describe('CoachMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(monitor: CoachMonitor): void {
    monitor.start({
      transcriptProvider: () => '',
      wordCountProvider: () => 100,
      agendaStatusProvider: () => null,
    });
  }

  it('emits recovery advice for the user answer that follows a question', async () => {
    const triage = vi.fn().mockResolvedValue(result());
    const monitor = new CoachMonitor({ triage });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (suggestion: CoachSuggestion) => suggestions.push(suggestion));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'pressure-1',
    });
    monitor.noteSegment('I think we can probably make that work.', 'mic', {
      final: true,
      segmentId: 'a1',
    });

    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    expect(triage).toHaveBeenCalledTimes(1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      incidentType: 'bad_answer',
      confidence: 0.9,
    });
    expect(suggestions[0]!.expiresAt).toBeGreaterThan(suggestions[0]!.createdAt);
  });

  it('does not review an unfinished mic partial as a complete answer', async () => {
    const triage = vi.fn().mockResolvedValue(result());
    const monitor = new CoachMonitor({ triage });
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'pressure-1',
    });
    // Let the question eval settle, then isolate the mic-partial behavior.
    await vi.advanceTimersByTimeAsync(300);
    triage.mockClear();
    monitor.noteSegment('I think we can', 'mic', {
      final: false,
      segmentId: 'a1',
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(triage).not.toHaveBeenCalled();
  });

  it('drops advice that arrives after the six-second moment deadline', async () => {
    const pending = defer<string>();
    const monitor = new CoachMonitor({ triage: () => pending.promise });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (suggestion: CoachSuggestion) => suggestions.push(suggestion));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'pressure-1',
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(monitor.evalsRun).toBe(1);

    await vi.advanceTimersByTimeAsync(6_100);
    pending.resolve(result({ incidentType: 'pressure' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(suggestions).toHaveLength(0);
    expect(monitor.getMetrics().staleResults).toBe(1);
  });

  it('still delivers advice that would have missed the old four-second deadline', async () => {
    const pending = defer<string>();
    const monitor = new CoachMonitor({ triage: () => pending.promise });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (suggestion: CoachSuggestion) => suggestions.push(suggestion));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'pressure-2',
    });
    await vi.advanceTimersByTimeAsync(300);

    // 13% of real coach evaluations (15 of 112 on 2026-09-14) died in this band.
    await vi.advanceTimersByTimeAsync(4_500);
    pending.resolve(result({ incidentType: 'pressure' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(suggestions).toHaveLength(1);
    expect(monitor.getMetrics().staleResults).toBe(0);
  });

  it('skips the generative call when the gate says the moment is quiet', async () => {
    const triage = vi.fn().mockResolvedValue(result());
    const monitor = new CoachMonitor({
      triage,
      gate: async () => ({ open: false, reason: 'quiet', worth: 0.1, asked: 0.05, pushback: 0.05, latencyMs: 12 }),
    });
    const evals: Array<Record<string, unknown>> = [];
    monitor.on('eval', (e: Record<string, unknown>) => evals.push(e));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'gated-1',
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(triage).not.toHaveBeenCalled();
    expect(monitor.gateSavedCalls).toBe(1);
    expect(evals.some((e) => e.skipped === 'gate')).toBe(true);
  });

  it('runs the generative call when the gate opens', async () => {
    const triage = vi.fn().mockResolvedValue(result({ incidentType: 'pressure' }));
    const monitor = new CoachMonitor({
      triage,
      gate: async () => ({ open: true, reason: 'signal', worth: 0.8, asked: 0.9, pushback: 0.2, latencyMs: 9 }),
    });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (s: CoachSuggestion) => suggestions.push(s));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'gated-2',
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(triage).toHaveBeenCalledTimes(1);
    expect(monitor.gateSavedCalls).toBe(0);
    expect(suggestions).toHaveLength(1);
  });

  it('surfaces a priority-4 card that the old floor would have withheld', async () => {
    const monitor = new CoachMonitor({
      triage: async () => result({ priority: 4, confidence: 0.58, incidentType: 'pressure' }),
    });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (s: CoachSuggestion) => suggestions.push(s));
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'p4-1',
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.priority).toBe(4);
  });

  it('runs the newest queued incident after an in-flight evaluation', async () => {
    const first = defer<string>();
    const triage = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(result({
        incidentType: 'objection',
        headline: 'Answer the objection',
        phrasing: 'You are right to flag that; here is the boundary we can commit to.',
      }));
    const monitor = new CoachMonitor({ triage });
    start(monitor);

    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'pressure-1',
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(triage).toHaveBeenCalledTimes(1);

    monitor.noteSegment("That doesn't answer what I asked.", 'meeting', {
      final: true,
      segmentId: 'o1',
    });
    first.resolve(result({ hasSuggestion: false, priority: 1, confidence: 0.2 }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(triage).toHaveBeenCalledTimes(2);
  });

  describe('one card per kind per minute', () => {
    // 09-21: three capacity cards at 21:13:11, :13 and :15, each replacing the
    // last after ~2s. Distinct headlines, so text dedup never caught them.
    function distinctPressureCards() {
      let n = 0;
      return vi.fn(async () => {
        n += 1;
        return result({ incidentType: 'pressure', headline: `Qualify the claim ${n}`, phrasing: `Boundary number ${n} is what we can commit to.` });
      });
    }

    it('holds back a second card of the same kind, without paying for it', async () => {
      const triage = distinctPressureCards();
      const monitor = new CoachMonitor({ triage });
      const suggestions: CoachSuggestion[] = [];
      monitor.on('suggestion', (s: CoachSuggestion) => suggestions.push(s));
      start(monitor);

      monitor.noteSegment('We need you to commit right now.', 'meeting', { final: true, segmentId: 'p1' });
      await vi.advanceTimersByTimeAsync(300);
      monitor.noteSegment('You have to commit today, this is non-negotiable.', 'meeting', { final: true, segmentId: 'p2' });
      await vi.advanceTimersByTimeAsync(300);

      expect(suggestions).toHaveLength(1);
      expect(triage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(TYPE_COOLDOWN_MS);
      monitor.noteSegment('We need an answer, commit by Friday.', 'meeting', { final: true, segmentId: 'p3' });
      await vi.advanceTimersByTimeAsync(300);
      expect(suggestions).toHaveLength(2);
    });

    it('still shows a different kind inside the minute', async () => {
      const triage = vi.fn()
        .mockResolvedValueOnce(result({ incidentType: 'pressure', headline: 'Hold the line' }))
        .mockResolvedValueOnce(result({ incidentType: 'objection', headline: 'Answer the objection', phrasing: 'Fair point; here is what changes.' }));
      const monitor = new CoachMonitor({ triage });
      const suggestions: CoachSuggestion[] = [];
      monitor.on('suggestion', (s: CoachSuggestion) => suggestions.push(s));
      start(monitor);

      monitor.noteSegment('We need you to commit right now.', 'meeting', { final: true, segmentId: 'p1' });
      await vi.advanceTimersByTimeAsync(300);
      monitor.noteSegment("That doesn't answer what I asked.", 'meeting', { final: true, segmentId: 'o1' });
      await vi.advanceTimersByTimeAsync(300);

      expect(suggestions.map((s) => s.incidentType)).toEqual(['pressure', 'objection']);
    });

    it('checks the kind the model named, not only the trigger', async () => {
      // An objection trigger whose answer comes back as another pressure card.
      const triage = distinctPressureCards();
      const monitor = new CoachMonitor({ triage });
      const suggestions: CoachSuggestion[] = [];
      monitor.on('suggestion', (s: CoachSuggestion) => suggestions.push(s));
      start(monitor);

      monitor.noteSegment('We need you to commit right now.', 'meeting', { final: true, segmentId: 'p1' });
      await vi.advanceTimersByTimeAsync(300);
      monitor.noteSegment("That doesn't answer what I asked.", 'meeting', { final: true, segmentId: 'o1' });
      await vi.advanceTimersByTimeAsync(300);

      expect(triage).toHaveBeenCalledTimes(2);
      expect(suggestions).toHaveLength(1);
    });
  });

  it('keeps silence for a low-confidence model result', async () => {
    const monitor = new CoachMonitor({
      triage: async () => result({ confidence: 0.4 }),
    });
    const suggestions: CoachSuggestion[] = [];
    monitor.on('suggestion', (suggestion: CoachSuggestion) => suggestions.push(suggestion));
    start(monitor);
    monitor.noteSegment('We need you to commit right now.', 'meeting', {
      final: true,
      segmentId: 'p1',
    });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    expect(suggestions).toHaveLength(0);
  });
});
