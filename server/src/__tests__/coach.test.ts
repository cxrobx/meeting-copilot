import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoachMonitor,
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

  it('drops advice that arrives after the four-second moment deadline', async () => {
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

    await vi.advanceTimersByTimeAsync(4_100);
    pending.resolve(result({ incidentType: 'pressure' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(suggestions).toHaveLength(0);
    expect(monitor.getMetrics().staleResults).toBe(1);
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
