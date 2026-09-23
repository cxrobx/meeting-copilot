import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_OUT_LEAD_MS,
  MeetingPulse,
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
