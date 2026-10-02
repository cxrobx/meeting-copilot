import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_OUT_LEAD_MS,
  MeetingPulse,
  askAnswerText,
  PULSE_INTERVAL_MS,
  buildPulsePrompt,
  detectWrapUp,
  parsePulse,
  type MeetingPulseResult,
} from '../intelligence/pulse.js';

const ANSWER = JSON.stringify({
  status: 'drifting',
  read: 'Winslow is asking the questions; yours about Juniper have not come up.',
  escalations: [{ text: 'Ask what his two clients are buying.', why: 'Half the call is gone.' }],
  closeOut: [{ text: 'Propose a follow-up with an owner and date.', why: 'No next step yet.' }],
});

describe('detectWrapUp', () => {
  it.each([
    'Before we go, can I ask one thing?',
    "I know we're almost at time.",
    "We're running out of time here.",
    'We are short on time.',
    "Let's wrap this up.",
    'Just to wrap things up',
    'In the last few minutes, could we talk pricing?',
    'One last thing.',
    'My final question is about the pilot.',
    'I have to jump.',
    "I've got to run, sorry.",
    'Anything else before we hop off?',
    "We're coming up on the hour.",
  ])('hears %j', (text) => expect(detectWrapUp(text)).toBe(true));

  it.each([
    'The last thing we shipped was the CRM.',
    'Before we go live, we need sign-off.',
    'I need to run the numbers first.',
    'We wrapped up the project last month.',
    'Our final question for the board is budget.',
    'What time works for you next week?',
  ])('ignores %j', (text) => expect(detectWrapUp(text)).toBe(false));
});

describe('parsePulse', () => {
  it('reads the model answer into the card shape', () => {
    const p = parsePulse(ANSWER, 'pulse');
    expect(p?.status).toBe('drifting');
    expect(p?.escalations).toHaveLength(1);
    expect(p?.closeOut[0]!.why).toBe('No next step yet.');
  });

  it('survives text after the JSON (gotcha #21)', () => {
    expect(parsePulse(`${ANSWER} (Remember output contract)`, 'pulse')?.status).toBe('drifting');
  });

  it('caps the lists: 2 escalations, 3 close-outs in a pulse, 5 in a close-out', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `item ${i}`, why: '' }));
    const raw = JSON.stringify({ status: 'stuck', read: 'x', escalations: many(4), closeOut: many(8) });
    expect(parsePulse(raw, 'pulse')?.escalations).toHaveLength(2);
    expect(parsePulse(raw, 'pulse')?.closeOut).toHaveLength(3);
    expect(parsePulse(raw, 'closeout')?.closeOut).toHaveLength(5);
  });

  it('reads the missed list only in a missed pass, capped at 5', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `missed ${i}`, why: '' }));
    const raw = JSON.stringify({ status: 'on_track', read: 'x', escalations: [], closeOut: [], missed: many(7) });
    expect(parsePulse(raw, 'missed')?.missed).toHaveLength(5);
    expect(parsePulse(raw, 'pulse')?.missed).toEqual([]);
  });

  it('falls back to on_track for an unknown status, and to null with no read', () => {
    expect(parsePulse(JSON.stringify({ status: 'great', read: 'fine' }), 'pulse')?.status).toBe('on_track');
    expect(parsePulse(JSON.stringify({ status: 'stuck', read: '' }), 'pulse')).toBeNull();
    expect(parsePulse('not json', 'pulse')).toBeNull();
  });
});

describe('buildPulsePrompt', () => {
  const base = {
    title: 'Intro call', attendees: 'Winslow', transcript: '[You] hi\n[Meeting] hello',
    goals: 'Get one intro', agenda: '[pending] Referrals', coachShown: ['Qualify your capacity'],
    previous: null, minutesIn: 20, minutesLeft: 10, mode: 'pulse' as const, trigger: 'interval' as const,
  };

  it('carries goals, agenda, coach cards and timing', () => {
    const p = buildPulsePrompt(base);
    expect(p).toContain('Get one intro');
    expect(p).toContain('[pending] Referrals');
    expect(p).toContain('- Qualify your capacity');
    expect(p).toContain('about 10 minutes left');
  });

  it('asks for the complete list in a close-out pass', () => {
    expect(buildPulsePrompt({ ...base, mode: 'closeout', trigger: 'manual' })).toContain('CLOSE-OUT pass');
  });

  it('hands the previous read back so items stay stable', () => {
    const previous = { minutesIn: 15, status: 'drifting', read: 'earlier read', escalations: [{ text: 'Ask X', why: '' }], closeOut: [] } as unknown as MeetingPulseResult;
    const p = buildPulsePrompt({ ...base, previous });
    expect(p).toContain('previous read (5 min ago)');
    expect(p).toContain('- Ask X');
  });

  it('asks a check-in about the user, with their share of the talking', () => {
    const p = buildPulsePrompt({ ...base, trigger: 'check-in', talkShare: 'the user has spoken 71% of the words so far' });
    expect(p).toContain('How am I doing?');
    expect(p).toContain("user's own showing");
    expect(p).toContain('Speaking balance: the user has spoken 71%');
  });

  it('asks for the complete missed list in a missed pass', () => {
    const p = buildPulsePrompt({ ...base, mode: 'missed', trigger: 'missed' });
    expect(p).toContain('MISSED-ANYTHING pass');
    expect(p).not.toContain("user's own showing");
  });

  it('keeps the most recent transcript when it is long', () => {
    const p = buildPulsePrompt({ ...base, transcript: 'x'.repeat(70_000) + 'THE END' });
    expect(p).toContain('the start is cut');
    expect(p).toContain('THE END');
  });
});

describe('MeetingPulse', () => {
  let words: number;
  let pulses: MeetingPulseResult[];
  let ask: ReturnType<typeof vi.fn>;
  let pulse: MeetingPulse;
  const t0 = new Date('2026-09-22T20:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    words = 0;
    pulses = [];
    ask = vi.fn(async () => ANSWER);
    pulse = new MeetingPulse({ ask, now: () => Date.now() });
    pulse.on('pulse', (p: MeetingPulseResult) => pulses.push(p));
    pulse.start({
      title: 'Intro call',
      startedAt: t0,
      transcriptProvider: () => '[You] hello there',
      wordCountProvider: () => words,
    });
  });

  afterEach(() => {
    pulse.stop();
    vi.useRealTimers();
  });

  it('reads the meeting every five minutes once there is new speech', async () => {
    words = 30;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(ask).not.toHaveBeenCalled(); // too little said yet

    words = 200;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({ mode: 'pulse', trigger: 'interval', status: 'drifting', minutesIn: 10 });

    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(pulses).toHaveLength(1); // nothing new since
  });

  it('runs a close-out now on the Wrap-up button, even with nothing new said', async () => {
    pulse.requestCloseOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses[0]).toMatchObject({ mode: 'closeout', trigger: 'manual' });
    expect(ask.mock.calls[0]![0]).toContain('CLOSE-OUT pass');
  });

  it('runs a close-out five minutes before the calendar end, and keeps them coming after', async () => {
    const endsAt = t0 + 30 * 60_000;
    pulse.setEndsAt(endsAt);
    await vi.advanceTimersByTimeAsync(endsAt - CLOSE_OUT_LEAD_MS - t0 - 1_000);
    expect(pulses.filter((p) => p.mode === 'closeout')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    const first = pulses.find((p) => p.mode === 'closeout');
    expect(first).toMatchObject({ trigger: 'schedule', minutesLeft: 5 });

    // A regular tick inside the window is a close-out too.
    words = 500;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(pulses[pulses.length - 1]!.mode).toBe('closeout');
  });

  it('hears wrap-up language, but not in the first ten minutes, and not twice in four', async () => {
    pulse.noteSegment("Let's wrap this up.");
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).not.toHaveBeenCalled();

    vi.setSystemTime(t0 + 20 * 60_000);
    pulse.noteSegment("Let's wrap this up.");
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses[pulses.length - 1]).toMatchObject({ mode: 'closeout', trigger: 'wrap-up' });

    pulse.noteSegment('One last thing.');
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('queues a close-out that arrives while a regular read is running', async () => {
    let release!: (v: string) => void;
    ask.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    words = 200;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    pulse.requestCloseOut();
    expect(ask).toHaveBeenCalledTimes(1);
    release(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses.map((p) => p.mode)).toEqual(['pulse', 'closeout']);
  });

  it('answers "How am I doing?" now, with nothing new said, outside the CLI lane', async () => {
    pulse.requestCheckIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses[0]).toMatchObject({ mode: 'pulse', trigger: 'check-in' });
    expect(ask.mock.calls[0]![0]).toContain('How am I doing?');
    expect(ask.mock.calls[0]![3]).toEqual({ asked: true });
  });

  it('keeps timer reads in the CLI lane', async () => {
    words = 200;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(ask.mock.calls[0]![3]).toEqual({ asked: false });
  });

  it('answers "Missed anything?" with the missed list', async () => {
    ask.mockResolvedValueOnce(JSON.stringify({
      status: 'on_track', read: 'Fine.', escalations: [], closeOut: [],
      missed: [{ text: 'Dana asked about Q3 pricing.', why: 'No answer given.' }],
    }));
    pulse.requestMissed();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses[0]).toMatchObject({ mode: 'missed', trigger: 'missed' });
    expect(pulses[0]!.missed[0]!.text).toBe('Dana asked about Q3 pricing.');
  });

  it('keeps a check-in a check-in inside the close-out window', async () => {
    pulse.setEndsAt(t0 + 4 * 60_000);
    pulse.requestCheckIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses[0]).toMatchObject({ mode: 'pulse', trigger: 'check-in' });
  });

  it('cancels a timer read in progress when someone asks, without calling it a failure', async () => {
    const failed = vi.fn();
    const skipped = vi.fn();
    pulse.on('failed', failed);
    pulse.on('skipped', skipped);
    ask.mockImplementationOnce((_p: string, _s: string, signal: AbortSignal) => new Promise<string>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    words = 200;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(ask).toHaveBeenCalledTimes(1);

    pulse.requestMissed();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith({ reason: 'superseded by an asked read' });
    expect(pulses.map((p) => p.trigger)).toEqual(['missed']);
  });

  it('lets a close-out in progress finish, then runs the asked reads in the order pressed', async () => {
    let release!: (v: string) => void;
    ask.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    vi.setSystemTime(t0 + 20 * 60_000);
    pulse.noteSegment("Let's wrap this up."); // auto close-out, running
    words = 500;
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS); // a timer read queues behind it
    pulse.requestMissed();
    pulse.requestCheckIn();
    pulse.requestCheckIn(); // pressed twice: one answer
    const skipped = vi.fn();
    pulse.on('skipped', skipped);
    release(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses.map((p) => p.trigger)).toEqual(['wrap-up', 'missed', 'check-in']);
    // The timer read waited its turn, then found the asked reads had already
    // covered everything said since.
    expect(skipped).toHaveBeenCalledWith({ reason: 'growth: +0/80' });
  });

  it('runs one read when the same question is pressed while it is running', async () => {
    let release!: (v: string) => void;
    ask.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    pulse.requestCheckIn();
    pulse.requestCheckIn();
    release(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('says why an asked read has nothing to read yet', async () => {
    const failed = vi.fn();
    pulse.on('failed', failed);
    pulse.start({ title: 'Empty', startedAt: t0, transcriptProvider: () => '', wordCountProvider: () => 0 });
    pulse.requestCheckIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'check-in', reason: 'Nothing has been said yet' }));
  });

  it('passes the previous read into the next prompt', async () => {
    pulse.requestCloseOut();
    await vi.advanceTimersByTimeAsync(0);
    pulse.requestCloseOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask.mock.calls[1]![0]).toContain('Your previous read');
  });

  it('drops a read that lands after stop()', async () => {
    let release!: (v: string) => void;
    ask.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    pulse.requestCloseOut();
    pulse.stop();
    release(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses).toHaveLength(0);
  });

  it('reports an unreadable answer instead of showing a blank card', async () => {
    const failed = vi.fn();
    pulse.on('failed', failed);
    ask.mockResolvedValueOnce('I could not produce JSON.');
    pulse.requestCloseOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses).toHaveLength(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unparseable' }));
  });
});

describe('askAnswerText', () => {
  const base = {
    id: 'p', status: 'drifting' as const, read: 'You are answering; they are not buying yet.',
    escalations: [{ text: 'Ask what would make it a yes.', why: '' }],
    closeOut: [{ text: 'Set the follow-up date.', why: '' }],
    missed: [] as Array<{ text: string; why: string }>,
    minutesIn: 12, minutesLeft: null, createdAt: 0, latencyMs: 0,
  };

  it('titles a check-in with the status and gives the read', () => {
    expect(askAnswerText({ ...base, mode: 'pulse', trigger: 'check-in' } as MeetingPulseResult))
      .toEqual({ title: 'How am I doing? \u00b7 Drifting', body: base.read });
  });

  it('gives the first two missed items, or says nothing slipped', () => {
    const missed = [{ text: 'A', why: '' }, { text: 'B', why: '' }, { text: 'C', why: '' }];
    expect(askAnswerText({ ...base, mode: 'missed', trigger: 'missed', missed } as MeetingPulseResult)!.body).toBe('A \u00b7 B');
    expect(askAnswerText({ ...base, mode: 'missed', trigger: 'missed' } as MeetingPulseResult)!.body).toBe('Nothing slipped by so far.');
  });

  it('has nothing to say for a timer read', () => {
    expect(askAnswerText({ ...base, mode: 'pulse', trigger: 'interval' } as MeetingPulseResult)).toBeNull();
  });
});

describe('MeetingPulse while paused', () => {
  const t0 = new Date('2026-10-02T15:00:00Z').getTime();
  let paused: boolean;
  let pausedMs: number;
  let pulses: MeetingPulseResult[];
  let pulse: MeetingPulse;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    paused = false;
    pausedMs = 0;
    pulses = [];
    pulse = new MeetingPulse({ ask: vi.fn(async () => ANSWER), now: () => Date.now() });
    pulse.on('pulse', (p: MeetingPulseResult) => pulses.push(p));
    pulse.start({
      title: 'Paused call',
      startedAt: t0,
      transcriptProvider: () => '[You] hello there',
      wordCountProvider: () => 500,
      pauseProvider: () => ({ paused, pausedMs }),
    });
  });

  afterEach(() => {
    pulse.stop();
    vi.useRealTimers();
  });

  it('skips timer reads and the scheduled close-out, but answers a question asked', async () => {
    paused = true;
    pulse.setEndsAt(t0 + 6 * 60_000); // close-out due at minute 1
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(pulses).toHaveLength(0);

    pulse.requestCheckIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({ trigger: 'check-in' });
  });

  it('leaves paused time out of minutes in', async () => {
    pausedMs = 4 * 60_000;
    await vi.advanceTimersByTimeAsync(2 * PULSE_INTERVAL_MS);
    expect(pulses[0]).toMatchObject({ trigger: 'interval', minutesIn: 1 });
  });
});
