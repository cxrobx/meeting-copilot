import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_DEADLINE_MS,
  CoachMonitor,
  TYPE_COOLDOWN_MS,
  coachAskPartialReader,
  detectMoment,
  type CoachAskPartial,
  type CoachSuggestion,
} from '../intelligence/coach.js';
import { COACH_ASK_SYSTEM } from '../intelligence/prompts/coach.v1.js';

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

describe('CoachMonitor.askNow (Suggest)', () => {
  const transcript = '[Meeting] What would the pilot cost us?\n[You] It depends on the scope, honestly.';
  const options = {
    transcriptProvider: () => transcript,
    wordCountProvider: () => 20,
    goalsProvider: () => 'Get a pilot date',
  };

  it('answers with the live coach off, past the gate and the floors, and pins the card', async () => {
    const triage = vi.fn().mockResolvedValue(result({ priority: 2, confidence: 0.3, incidentType: 'none' }));
    const gate = vi.fn();
    const monitor = new CoachMonitor({ triage, gate });
    const shown: CoachSuggestion[] = [];
    monitor.on('suggestion', (s: CoachSuggestion) => shown.push(s));

    const card = await monitor.askNow('', options);
    expect(gate).not.toHaveBeenCalled();
    expect(triage.mock.calls[0]![1]).toBe(COACH_ASK_SYSTEM);
    expect(triage.mock.calls[0]![0]).toContain('Get a pilot date');
    expect(triage.mock.calls[0]![3]).toMatchObject({ totalTimeoutMs: ASK_DEADLINE_MS });
    expect(card).toMatchObject({ asked: true, phrasing: expect.stringContaining('capacity') });
    expect(card!.expiresAt - card!.createdAt).toBeGreaterThanOrEqual(5 * 60_000);
    expect(shown).toEqual([card]);
  });

  it('carries the prompt box text as the focus', async () => {
    const triage = vi.fn().mockResolvedValue(result());
    const monitor = new CoachMonitor({ triage });
    await monitor.askNow('how do I answer the pricing push', options);
    expect(triage.mock.calls[0]![0]).toContain('Their focus: "how do I answer the pricing push"');
  });

  it('resolves null when the model has nothing', async () => {
    const triage = vi.fn().mockResolvedValue(result({ hasSuggestion: false, phrasing: '' }));
    const monitor = new CoachMonitor({ triage });
    await expect(monitor.askNow('', options)).resolves.toBeNull();
  });

  it('shares one call between two presses', async () => {
    const pending = defer<string>();
    const triage = vi.fn().mockReturnValue(pending.promise);
    const monitor = new CoachMonitor({ triage });
    const a = monitor.askNow('', options);
    const b = monitor.askNow('', options);
    pending.resolve(result());
    expect(await a).toBe(await b);
    expect(triage).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing has been said', async () => {
    const monitor = new CoachMonitor({ triage: vi.fn() });
    await expect(monitor.askNow('', { ...options, transcriptProvider: () => '' }))
      .rejects.toThrow('Nothing has been said yet');
  });

  it('reports its own deadline as a timeout, not as the meeting ending', async () => {
    const monitor = new CoachMonitor({ triage: vi.fn().mockRejectedValue(new Error('Aborted')) });
    await expect(monitor.askNow('', options)).rejects.toThrow(`No answer within ${ASK_DEADLINE_MS / 1000}s`);
  });

  it('drops the answer when the meeting ends under it', async () => {
    const pending = defer<string>();
    const monitor = new CoachMonitor({ triage: vi.fn().mockReturnValue(pending.promise) });
    const shown = vi.fn();
    monitor.on('suggestion', shown);
    const ask = monitor.askNow('', options);
    monitor.cancelAsk();
    pending.resolve(result());
    await expect(ask).rejects.toThrow('Aborted');
    expect(shown).not.toHaveBeenCalled();
  });
});


// Feed a JSON answer in small chunks, as a streaming model writes it.
function chunks(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('coachAskPartialReader (Suggest streaming)', () => {
  it('reports the phrasing as it grows, ending with the complete sentence', () => {
    const seen: CoachAskPartial[] = [];
    let clock = 0;
    const read = coachAskPartialReader((p) => seen.push(p), () => (clock += 100));
    for (const c of chunks(result())) read(c);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toEqual({
      headline: 'Reset the answer',
      phrasing: 'Let me answer that more directly: the constraint is capacity, not willingness.',
    });
    for (const p of seen) expect(seen.at(-1)!.phrasing.startsWith(p.phrasing)).toBe(true);
  });

  it('reports nothing when the model has no suggestion', () => {
    const seen: CoachAskPartial[] = [];
    const read = coachAskPartialReader((p) => seen.push(p), () => 0);
    for (const c of chunks(result({ hasSuggestion: false, phrasing: 'Not worth saying.' }))) read(c);
    expect(seen).toEqual([]);
  });

  it('coalesces fast deltas but always reports the finished phrasing', () => {
    const seen: CoachAskPartial[] = [];
    const read = coachAskPartialReader((p) => seen.push(p), () => 0); // every delta in the same instant
    for (const c of chunks(result(), 3)) read(c);
    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen.at(-1)!.phrasing).toBe('Let me answer that more directly: the constraint is capacity, not willingness.');
  });

  it('ignores text the model writes after the object (gotcha #21)', () => {
    const seen: CoachAskPartial[] = [];
    const read = coachAskPartialReader((p) => seen.push(p), () => 0);
    for (const c of chunks(`${result()}"} {"hasSuggestion":true,"phrasing":"garbage`)) read(c);
    expect(seen.at(-1)!.phrasing).toBe('Let me answer that more directly: the constraint is capacity, not willingness.');
  });
});

describe('CoachMonitor.askNow streaming', () => {
  const options = {
    transcriptProvider: () => '[Meeting] What would the pilot cost us?\n[You] It depends on the scope, honestly.',
    wordCountProvider: () => 20,
    goalsProvider: () => 'Get a pilot date',
  };

  it('emits ask.partial while the answer streams, then the full card', async () => {
    const events: string[] = [];
    const triage = vi.fn(async (_p: string, _s: string, _sig?: AbortSignal, _t?: unknown, onTextDelta?: (d: string) => void) => {
      const text = result();
      for (const c of chunks(text, 20)) onTextDelta?.(c);
      return text;
    });
    const monitor = new CoachMonitor({ triage });
    monitor.on('ask.partial', () => events.push('partial'));
    monitor.on('suggestion', () => events.push('suggestion'));
    await monitor.askNow('', options);
    expect(typeof triage.mock.calls[0]![4]).toBe('function');
    expect(events[0]).toBe('partial');
    expect(events.at(-1)).toBe('suggestion');
  });

  it('passes no stream reader to the unasked live coach', async () => {
    vi.useFakeTimers();
    try {
      const triage = vi.fn().mockResolvedValue(result({ incidentType: 'pressure' }));
      const monitor = new CoachMonitor({ triage });
      const shown: CoachSuggestion[] = [];
      monitor.on('suggestion', (x: CoachSuggestion) => shown.push(x));
      monitor.start({ transcriptProvider: () => '', wordCountProvider: () => 100, agendaStatusProvider: () => null });
      monitor.noteSegment('We need you to commit right now.', 'meeting', { final: true, segmentId: 'stream-1' });
      await vi.advanceTimersByTimeAsync(300);
      monitor.stop();
      expect(triage).toHaveBeenCalled();
      expect(shown).toHaveLength(1);
      for (const call of triage.mock.calls as unknown[][]) expect(call[4]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
