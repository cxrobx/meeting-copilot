import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgendaTracker,
  parseAgenda,
  extractAgendaItemsFromNotes,
  normalizeExtractedItems,
  parseExtractResponse,
  type AgendaStatus,
} from '../intelligence/agenda.js';

type TriageFn = (prompt: string, systemPrompt: string, signal?: AbortSignal) => Promise<string>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function agendaResponse(
  items: Array<{ id: string; state: 'covered' | 'partial' | 'pending'; evidence?: string }>,
  missing: string[] = [],
): string {
  return JSON.stringify({ items, missing_warnings: missing });
}

describe('parseAgenda', () => {
  it('returns empty list for empty/whitespace input', () => {
    expect(parseAgenda('')).toEqual([]);
    expect(parseAgenda('   \n  \t  ')).toEqual([]);
  });

  it('splits on newlines by default', () => {
    const items = parseAgenda('Confirm hiring plan\nReview campaign results\nDecide launch date');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.text)).toEqual([
      'Confirm hiring plan',
      'Review campaign results',
      'Decide launch date',
    ]);
    expect(items.every((i) => i.state === 'pending')).toBe(true);
    expect(items.map((i) => i.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('strips bullet markers (-, *, •) and numbered prefixes', () => {
    const items = parseAgenda(`- First item\n* Second item\n• Third item\n1. Fourth\n2) Fifth`);
    expect(items.map((i) => i.text)).toEqual([
      'First item',
      'Second item',
      'Third item',
      'Fourth',
      'Fifth',
    ]);
  });

  it('falls back to comma/semicolon split for single-line input', () => {
    const items = parseAgenda('topic one, topic two; topic three');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.text)).toEqual(['topic one', 'topic two', 'topic three']);
  });

  it('returns a single item when a single line has no separators', () => {
    const items = parseAgenda('just one thing to cover');
    expect(items).toEqual([{ id: 'a1', text: 'just one thing to cover', state: 'pending' }]);
  });
});

describe('AgendaTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function make(triage: TriageFn) {
    const tracker = new AgendaTracker({ triage });
    return tracker;
  }

  function startWith(
    tracker: AgendaTracker,
    opts: { agenda?: string; transcript?: string; words?: number } = {},
  ) {
    return tracker.start({
      agenda: opts.agenda ?? 'Confirm hiring plan\nReview campaign results',
      transcriptProvider: () => opts.transcript ?? 'x'.repeat(100),
      wordCountProvider: () => opts.words ?? 100,
    });
  }

  it('gates evaluations on the min-word thresholds', async () => {
    const triage = vi.fn<TriageFn>().mockResolvedValue(
      agendaResponse([
        { id: 'a1', state: 'pending' },
        { id: 'a2', state: 'pending' },
      ]),
    );
    const tracker = make(triage);

    let words = 0;
    let transcript = '';
    tracker.start({
      agenda: 'A\nB',
      transcriptProvider: () => transcript,
      wordCountProvider: () => words,
    });

    // Empty transcript — first-eval gate not met (<15 total)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triage).not.toHaveBeenCalled();

    // Total < first-eval threshold (15) — still skipped
    words = 10;
    transcript = 'short bit of content';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triage).not.toHaveBeenCalled();

    // Total crosses first-eval threshold — should run once
    words = 25;
    transcript = 'this is now a long enough transcript to actually evaluate against the agenda items';
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(triage).toHaveBeenCalledTimes(1);

    // Modest additional growth (<MIN_NEW_WORDS_BEFORE_EVAL=5 since last eval
    // at 25) — skipped again
    words = 27;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(triage).toHaveBeenCalledTimes(1);

    // Clear the growth threshold — runs once more
    words = 60;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(triage).toHaveBeenCalledTimes(2);
  });

  it('evaluateNow waits for an in-flight eval before starting a new one', async () => {
    const first = defer<string>();
    const second = defer<string>();
    const triage = vi.fn<TriageFn>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const tracker = make(triage);
    let words = 100;
    tracker.start({
      agenda: 'A\nB',
      transcriptProvider: () => 'transcript text long enough for evaluation',
      wordCountProvider: () => words,
    });

    // Kick off the scheduled eval (grow words so the gating lets it run).
    words = 200;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triage).toHaveBeenCalledTimes(1);

    // evaluateNow is called while the first eval is mid-flight.
    const forced = tracker.evaluateNow();

    // Let the first settle.
    first.resolve(agendaResponse([
      { id: 'a1', state: 'covered', evidence: 'first eval' },
      { id: 'a2', state: 'pending' },
    ]));
    await Promise.resolve();
    await Promise.resolve();

    // A second triage call should now be in-flight (forced eval ran).
    expect(triage).toHaveBeenCalledTimes(2);
    second.resolve(agendaResponse([
      { id: 'a1', state: 'covered', evidence: 'first eval' },
      { id: 'a2', state: 'covered', evidence: 'second eval picked it up' },
    ]));
    await forced;

    const status = tracker.getStatus();
    expect(status.items.find((i) => i.id === 'a2')?.state).toBe('covered');
  });

  it('discards a stale in-flight result after stop() so it cannot bleed into a new session', async () => {
    const first = defer<string>();
    const triage = vi.fn<TriageFn>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve(agendaResponse([
        { id: 'a1', state: 'pending' },
      ])));

    const tracker = make(triage);
    const events: AgendaStatus[] = [];
    tracker.on('status', (s: AgendaStatus) => events.push(s));

    let words = 100;
    tracker.start({
      agenda: 'Original item one\nOriginal item two',
      transcriptProvider: () => 'plenty of transcript text for the evaluator',
      wordCountProvider: () => words,
    });
    words = 300;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(triage).toHaveBeenCalledTimes(1);

    // Stop (e.g. meeting ended) and immediately start a fresh session.
    tracker.stop();
    startWith(tracker, { agenda: 'Fresh topic only' });

    // Resolve the old eval — it references ids a1/a2 that belong to the prior
    // session. It must NOT mutate the new session's state.
    first.resolve(agendaResponse([
      { id: 'a1', state: 'covered', evidence: 'stale result' },
      { id: 'a2', state: 'covered', evidence: 'stale result' },
    ]));
    await Promise.resolve();
    await Promise.resolve();

    const status = tracker.getStatus();
    expect(status.items).toHaveLength(1);
    expect(status.items[0]!.text).toBe('Fresh topic only');
    expect(status.items[0]!.state).toBe('pending');
    // No status events should have been emitted from the stale result.
    expect(events).toHaveLength(0);
  });

  it('clears item evidence when a prior covered/partial item transitions back to pending', async () => {
    const triage = vi.fn<TriageFn>()
      .mockResolvedValueOnce(agendaResponse([
        { id: 'a1', state: 'covered', evidence: 'they confirmed' },
      ]))
      .mockResolvedValueOnce(agendaResponse([
        { id: 'a1', state: 'pending' },
      ]));

    const tracker = make(triage);
    let words = 100;
    tracker.start({
      agenda: 'Confirm hiring plan',
      transcriptProvider: () => 'long enough transcript content here',
      wordCountProvider: () => words,
    });

    words = 200;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(tracker.getStatus().items[0]).toMatchObject({
      state: 'covered',
      evidence: 'they confirmed',
    });

    words = 400;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    const after = tracker.getStatus().items[0]!;
    expect(after.state).toBe('pending');
    expect(after.evidence).toBeUndefined();
  });

  it('aborts the in-flight triage call on stop() without emitting an error', async () => {
    let capturedSignal: AbortSignal | undefined;
    const triage = vi.fn<TriageFn>().mockImplementation((_p, _s, signal) => {
      capturedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    });

    const tracker = make(triage);
    const errors: string[] = [];
    tracker.on('error', (e: string) => errors.push(e));

    let words = 100;
    tracker.start({
      agenda: 'A',
      transcriptProvider: () => 'plenty of content for triage',
      wordCountProvider: () => words,
    });
    words = 300;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(capturedSignal?.aborted).toBe(false);
    tracker.stop();
    expect(capturedSignal?.aborted).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(0);
  });

  it('uses the immediate delta lane for an agenda-matching finalized turn', async () => {
    const triage = vi.fn<TriageFn>().mockResolvedValue(agendaResponse([
      { id: 'a1', state: 'partial', evidence: 'The pricing is the main concern' },
      { id: 'a2', state: 'pending' },
    ]));
    const tracker = make(triage);
    tracker.start({
      agenda: 'Review budget\nConfirm launch date',
      transcriptProvider: () => '[Meeting] HISTORICAL TRANSCRIPT SHOULD NOT BE IN THE DELTA',
      wordCountProvider: () => 9,
    });

    tracker.noteSegment('The pricing is the main concern.', 'meeting');
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage.mock.calls[0]![0]).toContain('New transcript turns only');
    expect(triage.mock.calls[0]![0]).not.toContain('HISTORICAL TRANSCRIPT');
    expect(tracker.getStatus().items[0]).toMatchObject({
      state: 'partial',
      evidence: 'The pricing is the main concern',
    });
  });

  it('requires full reconciliation before a pending item becomes covered', async () => {
    const triage = vi.fn<TriageFn>().mockResolvedValue(agendaResponse([
      { id: 'a1', state: 'covered', evidence: 'Budget is approved' },
    ]));
    const tracker = make(triage);
    tracker.start({
      agenda: 'Approve budget',
      transcriptProvider: () => '',
      wordCountProvider: () => 20,
    });

    tracker.noteSegment('The budget is approved.', 'meeting');
    await vi.advanceTimersByTimeAsync(300);

    expect(tracker.getStatus().items[0]).toMatchObject({
      state: 'partial',
      evidence: 'Budget is approved',
    });
  });

  it('does not let a delta erase earlier covered evidence', async () => {
    const triage = vi.fn<TriageFn>()
      .mockResolvedValueOnce(agendaResponse([
        { id: 'a1', state: 'covered', evidence: 'Budget is approved' },
        { id: 'a2', state: 'pending' },
      ]))
      .mockResolvedValueOnce(agendaResponse([
        { id: 'a1', state: 'pending' },
        { id: 'a2', state: 'partial', evidence: 'Timeline starts next week' },
      ]));
    const tracker = make(triage);
    tracker.start({
      agenda: 'Approve budget\nReview timeline',
      transcriptProvider: () => '[Meeting] The budget is approved.',
      wordCountProvider: () => 20,
    });

    await tracker.evaluateNow();
    tracker.noteSegment('The timeline starts next week.', 'meeting');
    await vi.advanceTimersByTimeAsync(300);

    expect(tracker.getStatus().items[0]).toMatchObject({
      state: 'covered',
      evidence: 'Budget is approved',
    });
    expect(tracker.getStatus().items[1]).toMatchObject({ state: 'partial' });
  });
});

describe('parseExtractResponse', () => {
  it('parses a bare JSON object', () => {
    const raw = JSON.stringify({ items: ['one', 'two', 'three'] });
    expect(parseExtractResponse(raw)).toEqual(['one', 'two', 'three']);
  });

  it('parses a ```json fenced response', () => {
    const raw = '```json\n{ "items": ["alpha", "beta"] }\n```';
    expect(parseExtractResponse(raw)).toEqual(['alpha', 'beta']);
  });

  it('parses a plain ``` fenced response', () => {
    const raw = '```\n{"items":["gamma"]}\n```';
    expect(parseExtractResponse(raw)).toEqual(['gamma']);
  });

  it('parses JSON wrapped in explanatory prose', () => {
    const raw = 'Sure — here are the items:\n{ "items": ["a", "b"] }\nLet me know if you need more.';
    expect(parseExtractResponse(raw)).toEqual(['a', 'b']);
  });

  it('returns null for malformed JSON', () => {
    expect(parseExtractResponse('not valid')).toBeNull();
    expect(parseExtractResponse('{ "items": [broken }')).toBeNull();
  });

  it('returns null when items field is missing or wrong type', () => {
    expect(parseExtractResponse('{ "foo": "bar" }')).toBeNull();
    expect(parseExtractResponse('{ "items": "not an array" }')).toBeNull();
  });

  it('drops non-string entries and overly long entries', () => {
    const longItem = 'x'.repeat(200);
    const raw = JSON.stringify({ items: ['good', 42, null, longItem, 'also good'] });
    expect(parseExtractResponse(raw)).toEqual(['good', 'also good']);
  });
});

describe('normalizeExtractedItems', () => {
  it('strips bullet and number prefixes', () => {
    const result = normalizeExtractedItems([
      '- Confirm hiring plan',
      '* Review results',
      '1. First question',
      '2) Second question',
    ]);
    expect(result).toEqual([
      'Confirm hiring plan',
      'Review results',
      'First question',
      'Second question',
    ]);
  });

  it('strips trailing punctuation and collapses whitespace', () => {
    const result = normalizeExtractedItems([
      'Ask about the audit?',
      'Confirm  the  date.',
      'Discuss   plans,',
    ]);
    expect(result).toEqual([
      'Ask about the audit',
      'Confirm the date',
      'Discuss plans',
    ]);
  });

  it('dedupes case-insensitively, first occurrence wins', () => {
    const result = normalizeExtractedItems([
      'Confirm the plan',
      'confirm the PLAN',
      'CONFIRM the plan',
      'Something else',
    ]);
    expect(result).toEqual(['Confirm the plan', 'Something else']);
  });

  it('caps at 20 items', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item ${i + 1}`);
    const result = normalizeExtractedItems(items);
    expect(result).toHaveLength(20);
    expect(result[0]).toBe('item 1');
    expect(result[19]).toBe('item 20');
  });

  it('skips empty and non-string entries', () => {
    // @ts-expect-error — deliberately pass junk to exercise the guard
    const result = normalizeExtractedItems(['keep', '', '  ', null, undefined, 42, 'also']);
    expect(result).toEqual(['keep', 'also']);
  });
});

describe('extractAgendaItemsFromNotes', () => {
  it('returns [] for empty or whitespace-only input without calling the model', async () => {
    const chat = vi.fn();
    expect(await extractAgendaItemsFromNotes('', { chat })).toEqual([]);
    expect(await extractAgendaItemsFromNotes('   \n\t ', { chat })).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('extracts, normalizes, dedupes, and caps items from a successful response', async () => {
    const chat = vi.fn().mockResolvedValueOnce(JSON.stringify({
      items: [
        '- Confirm Q1 hiring plan',
        'Review campaign results.',
        'CONFIRM Q1 hiring plan',  // dup (normalized) — dropped
        'Decide on launch date?',
      ],
    }));

    const out = await extractAgendaItemsFromNotes('some notes', { chat });
    expect(out).toEqual([
      'Confirm Q1 hiring plan',
      'Review campaign results',
      'Decide on launch date',
    ]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first response is malformed, then returns parsed items', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce('I cannot parse this.')
      .mockResolvedValueOnce(JSON.stringify({ items: ['ask about schema', 'confirm audit date'] }));

    const out = await extractAgendaItemsFromNotes('some notes', { chat });
    expect(out).toEqual(['ask about schema', 'confirm audit date']);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('returns [] when both the first call and the retry fail to parse', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce('garbage')
      .mockResolvedValueOnce('still garbage');

    const out = await extractAgendaItemsFromNotes('some notes', { chat });
    expect(out).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('throws when the chat call fails (non-abort error)', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(extractAgendaItemsFromNotes('notes', { chat })).rejects.toThrow(/Extraction failed/);
  });

  it('propagates Aborted as-is so callers can distinguish cancellation', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('Aborted'));
    await expect(extractAgendaItemsFromNotes('notes', { chat })).rejects.toThrow('Aborted');
  });

  it('passes through an AbortSignal to the chat call', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ items: ['a', 'b'] }));
    const controller = new AbortController();
    await extractAgendaItemsFromNotes('notes', { chat, signal: controller.signal });
    expect(chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
