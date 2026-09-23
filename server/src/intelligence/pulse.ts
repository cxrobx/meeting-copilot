import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { claudeSuggest } from '../claude-cli.js';
import { MODEL_CONFIG } from '../model-config.js';
import { parseFirstJsonObject } from './first-json.js';
import { inCliLane } from './cli-lane.js';

/**
 * Meeting pulse — a big-picture read every few minutes.
 *
 * The coach reacts to single moments within seconds; the rolling summary says
 * what happened; the self-review arrives after the call. Nothing said how the
 * meeting is GOING, what should be escalated now, or what must be closed out
 * before everyone hangs up. This does, on the subscription CLI (Opus 5.5), so
 * its 20–40s latency is fine and it costs no metered spend.
 *
 * One card, updated in place. Near the end — five minutes before the calendar
 * end time, on wrap-up language, or on the Wrap-up button — it switches to a
 * close-out pass: the full list of what to settle before the call ends.
 *
 * Two more reads run only when asked, from the coach's buttons or the app's
 * global hotkeys: "How am I doing?" (a regular read whose one-liner is about
 * the user's own showing) and "Missed anything?" (a look back at what went by
 * unhandled). A press goes ahead of the timer: it skips the new-speech floor,
 * jumps the queue, cancels a timer read already running, and skips the
 * background CLI lane, because someone is waiting on it.
 */

export const PULSE_INTERVAL_MS = 5 * 60_000;
/** How long before the calendar end the close-out pass runs. */
export const CLOSE_OUT_LEAD_MS = 5 * 60_000;
/** A regular pulse waits for this much new speech; a close-out never does. */
const MIN_NEW_WORDS = 80;
/** ~60 minutes of dense talk; older content arrives via the agenda and goals. */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** "Last thing" ten minutes in is a topic, not a wrap-up. */
const WRAP_UP_MIN_ELAPSED_MS = 10 * 60_000;
const WRAP_UP_COOLDOWN_MS = 4 * 60_000;
const MAX_ESCALATIONS = 2;
const MAX_CLOSE_OUT = { pulse: 3, closeout: 5, missed: 3 } as const;
const MAX_MISSED = 5;
/** Asked reads waiting behind the running one; a fourth press is dropped. */
const MAX_PENDING = 3;

export type PulseStatus = 'on_track' | 'drifting' | 'stuck';
export type PulseMode = 'pulse' | 'closeout' | 'missed';
/**
 * `manual` is the Wrap-up button, `check-in` is "How am I doing?", `missed`
 * is "Missed anything?". The other three are the pulse's own timers.
 */
export type PulseTrigger = 'interval' | 'schedule' | 'wrap-up' | 'manual' | 'check-in' | 'missed';

/** A person asked for this read, so it answers them rather than a timer. */
export function isAskedTrigger(trigger: PulseTrigger): boolean {
  return trigger === 'manual' || trigger === 'check-in' || trigger === 'missed';
}

export interface PulseItem {
  text: string;
  why: string;
}

export interface MeetingPulseResult {
  id: string;
  mode: PulseMode;
  trigger: PulseTrigger;
  status: PulseStatus;
  read: string;
  escalations: PulseItem[];
  closeOut: PulseItem[];
  /** Only in a `missed` read: what went by without being handled. */
  missed: PulseItem[];
  minutesIn: number;
  /** Minutes to the calendar end, when the meeting came from an invite. */
  minutesLeft: number | null;
  createdAt: number;
  latencyMs: number;
}

// Phrases people say when a call is ending. Whole-phrase, case-insensitive; the
// elapsed-time floor and cooldown keep a stray "last thing" from firing it.
const WRAP_UP_RE = new RegExp([
  // "before we go" but not "before we go live / ahead / through it"
  String.raw`\bbefore we go\b(?!\s+(?:live|ahead|further|through|over|into|to|back|with|on)\b)`,
  String.raw`\bbefore we (?:wrap|hop off|jump off|drop|let you go|end|finish|run out of time)\b`,
  String.raw`\b(?:we're|we are) (?:almost |nearly |right |getting )?(?:at|close to|near|short on|low on|out of|running (?:low on|out of)) time\b`,
  String.raw`\b(?:coming up on|almost at|right at) (?:the )?(?:hour|time|top of the hour)\b`,
  String.raw`\b(?:let's|let us|we should|we can|we'll|want to|going to|gonna) wrap(?: (?:it|this|things))? up\b`,
  String.raw`\bto wrap (?:it |this |things )?up\b`,
  String.raw`\b(?:last|final) (?:couple|few) (?:of )?minutes\b`,
  String.raw`\b(?:one|a|my) (?:last|final) (?:thing|question|point)\b`,
  // "I have to run." / "I've got to jump off" — not "I need to run the numbers"
  String.raw`\bi(?:'ve)? (?:have|got|need) to (?:drop off|jump off|hop off|drop|jump|run|hop)\s*(?:$|[.,!?]|soon\b|now\b|in a\b)`,
  String.raw`\b(?:anything else|any (?:other|last|final) questions?) before\b`,
].join('|'), 'i');

export function detectWrapUp(text: string): boolean {
  return WRAP_UP_RE.test(text);
}

export const PULSE_SYSTEM = `You sit in on the user's live meeting as a trusted adviser, reading the transcript every few minutes. A separate coach already handles single moments within seconds; you do not. Your job is the big picture: how the meeting is going, what needs escalating now, and what must be settled before the call ends.

Speaker labels: [You] is the user. [Meeting] is everyone else on the call, possibly several people, and speech-to-text errors are common.

Return ONLY a JSON object:
{
  "status": "on_track" | "drifting" | "stuck",
  "read": "one plain sentence on how it is going and why, specific to THIS meeting",
  "escalations": [{ "text": "...", "why": "..." }],
  "closeOut": [{ "text": "...", "why": "..." }],
  "missed": [{ "text": "...", "why": "..." }]
}

status: on_track = moving toward what the user wants; drifting = time going to side topics or the user's goals slipping; stuck = circling, blocked, or tension going unaddressed.

read: never generic ("the meeting is going well"). Name the thing that makes it on track, drifting or stuck.

escalations (0–2): only things that cost the user if left alone for the next few minutes. A direct question to the user still unanswered; a commitment made without an owner, date or scope; an objection or risk raised and not addressed; one of the user's goals slipping. Empty is a good answer; do not fill it.

closeOut: what must be settled before the call ends. Open questions, the next step with an owner and a date, agenda items not yet covered, decisions left hanging, an ask the user came to make. In a regular pulse list at most 3, and only ones already clear. In a close-out pass give the complete list, at most 5, most important first.

missed: only in a MISSED-ANYTHING pass; otherwise []. What has already gone by without being handled: a question put to the user that got no real answer, a point someone raised that was dropped, a request or offer the user did not respond to, a commitment made without an owner or date, an agenda item or one of the user's goals not touched yet. Only things in this transcript, most important first, at most 5. An empty list is a real answer when nothing slipped.

Every item's text is something the user can say or do now, 18 words or fewer ("Ask Dana who owns the pilot readout, and by when"). why is 12 words or fewer. Do not repeat a coach card already shown unless it is still unresolved. Do not invent facts; quote no more than 12 words verbatim.`;

export interface PulseContext {
  title: string;
  attendees: string;
  transcript: string;
  goals: string;
  agenda: string;
  coachShown: string[];
  /** e.g. "the user has spoken 62% of the words so far"; empty when unknown. */
  talkShare?: string;
  previous: MeetingPulseResult | null;
  minutesIn: number;
  minutesLeft: number | null;
  mode: PulseMode;
  trigger: PulseTrigger;
}

const TRIGGER_WORDS: Record<PulseTrigger, string> = {
  interval: 'the regular five-minute read',
  schedule: 'five minutes before the calendar end time',
  'wrap-up': 'someone said something that sounds like the call is wrapping up',
  manual: 'the user asked for a wrap-up check',
  'check-in': 'the user asked "How am I doing?"',
  missed: 'the user asked "Did I miss anything?"',
};

export function buildPulsePrompt(c: PulseContext): string {
  const parts: string[] = [];
  parts.push(`Meeting: ${c.title || 'Untitled'}${c.attendees ? `\nAttendees: ${c.attendees}` : ''}`);
  const timing = c.minutesLeft === null
    ? `${c.minutesIn} minutes in; scheduled end unknown.`
    : `${c.minutesIn} minutes in; about ${Math.max(0, c.minutesLeft)} minutes left on the calendar.`;
  parts.push(`Timing: ${timing}`);
  if (c.mode === 'closeout') {
    parts.push(`This is a CLOSE-OUT pass (${TRIGGER_WORDS[c.trigger]}). Give the complete closeOut list.`);
  } else if (c.mode === 'missed') {
    parts.push(`This is a MISSED-ANYTHING pass (${TRIGGER_WORDS[c.trigger]}). Give the complete missed list; keep escalations and closeOut to what is not already in it.`);
  } else {
    parts.push(`This is a regular pulse (${TRIGGER_WORDS[c.trigger]}).`);
  }
  if (c.trigger === 'check-in') {
    parts.push('Make read about the user\'s own showing: whether their answers are landing, whether they are getting what they came for, and their share of the talking. status still describes the meeting as a whole.');
  }
  if (c.talkShare) parts.push(`Speaking balance: ${c.talkShare}.`);
  if (c.goals.trim()) parts.push(`The user's private goals for this meeting:\n${c.goals.trim()}`);
  if (c.agenda.trim()) parts.push(`Agenda, with the tracker's current state:\n${c.agenda.trim()}`);
  if (c.coachShown.length) parts.push(`Coach cards already shown to the user:\n${c.coachShown.map((h) => `- ${h}`).join('\n')}`);
  if (c.previous) {
    const ago = Math.max(0, c.minutesIn - c.previous.minutesIn);
    const items = [...c.previous.escalations, ...c.previous.closeOut, ...(c.previous.missed ?? [])].map((i) => `- ${i.text}`).join('\n');
    parts.push(`Your previous read (${ago} min ago): ${c.previous.status} — ${c.previous.read}${items ? `\nItems you raised then (keep the ones still open, drop the settled ones):\n${items}` : ''}`);
  }
  const clipped = c.transcript.length > MAX_TRANSCRIPT_CHARS;
  const transcript = clipped ? c.transcript.slice(-MAX_TRANSCRIPT_CHARS) : c.transcript;
  parts.push(`Transcript${clipped ? ' (most recent part; the start is cut)' : ''}:\n<transcript>\n${transcript}\n</transcript>`);
  return parts.join('\n\n');
}

function items(value: unknown, max: number): PulseItem[] {
  if (!Array.isArray(value)) return [];
  const out: PulseItem[] = [];
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry : typeof entry?.text === 'string' ? entry.text : '';
    if (!text.trim()) continue;
    out.push({ text: text.trim().slice(0, 200), why: typeof entry?.why === 'string' ? entry.why.trim().slice(0, 120) : '' });
    if (out.length >= max) break;
  }
  return out;
}

/** The model's answer, clamped to the card's shape; null when there is none. */
export function parsePulse(raw: string, mode: PulseMode): Pick<MeetingPulseResult, 'status' | 'read' | 'escalations' | 'closeOut' | 'missed'> | null {
  const parsed = parseFirstJsonObject<Record<string, unknown>>(
    raw,
    (o) => typeof o.read === 'string' && (o.read as string).trim().length > 0,
  );
  if (!parsed) return null;
  const status = parsed.status === 'drifting' || parsed.status === 'stuck' ? parsed.status : 'on_track';
  return {
    status,
    read: String(parsed.read).trim().slice(0, 300),
    escalations: items(parsed.escalations, MAX_ESCALATIONS),
    closeOut: items(parsed.closeOut, MAX_CLOSE_OUT[mode]),
    missed: mode === 'missed' ? items(parsed.missed, MAX_MISSED) : [],
  };
}

const PULSE_STATUS_WORDS = { on_track: 'On track', drifting: 'Drifting', stuck: 'Stuck' } as const;

/** Notification text for a pulse read someone asked for. */
export function askAnswerText(p: MeetingPulseResult): { title: string; body: string } | null {
  const first = (items: Array<{ text: string }>, empty: string) =>
    items.slice(0, 2).map((i) => i.text).join(' \u00b7 ') || empty;
  switch (p.trigger) {
    case 'check-in':
      return { title: `How am I doing? \u00b7 ${PULSE_STATUS_WORDS[p.status]}`, body: p.read };
    case 'missed':
      return { title: 'You may have missed', body: first(p.missed, 'Nothing slipped by so far.') };
    case 'manual':
      return { title: 'Before this call ends', body: first([...p.escalations, ...p.closeOut], 'Nothing left to settle.') };
    default:
      return null;
  }
}

/** `asked`: a person is waiting, so the call skips the background CLI lane. */
type PulseAsk = (prompt: string, systemPrompt: string, signal: AbortSignal, opts: { asked: boolean }) => Promise<string>;

export interface MeetingPulseDeps {
  ask?: PulseAsk;
  now?: () => number;
}

export interface PulseStartOptions {
  title?: string;
  attendees?: string;
  startedAt: number;
  transcriptProvider: () => string;
  wordCountProvider: () => number;
  goalsProvider?: () => string;
  agendaProvider?: () => string;
  coachProvider?: () => string[];
  talkShareProvider?: () => string;
}

interface PulseRequest {
  mode: PulseMode;
  trigger: PulseTrigger;
}

function sameRequest(a: PulseRequest, b: PulseRequest): boolean {
  return a.mode === b.mode && a.trigger === b.trigger;
}

export class MeetingPulse extends EventEmitter {
  private readonly ask: PulseAsk;
  private readonly now: () => number;
  private options: PulseStartOptions | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closeOutTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private inFlight = false;
  private current: PulseRequest | null = null;
  /** Aborted because a person asked while it ran; not a failure. */
  private superseded: AbortController | null = null;
  private pending: PulseRequest[] = [];
  private generation = 0;
  private lastWords = 0;
  private lastWrapUpAt = 0;
  private endsAt: number | null = null;
  private previous: MeetingPulseResult | null = null;

  constructor(deps: MeetingPulseDeps = {}) {
    super();
    this.ask = deps.ask ?? ((prompt, system, signal, { asked }) => {
      const call = () => claudeSuggest(prompt, system, signal, undefined, { model: MODEL_CONFIG.pulse, cold: true });
      return asked ? call() : inCliLane(call);
    });
    this.now = deps.now ?? Date.now;
  }

  isRunning(): boolean {
    return this.options !== null;
  }

  latest(): MeetingPulseResult | null {
    return this.previous;
  }

  start(options: PulseStartOptions): void {
    this.stop();
    this.options = options;
    this.lastWords = 0;
    this.lastWrapUpAt = 0;
    this.previous = null;
    this.timer = setInterval(() => this.request('pulse', 'interval'), PULSE_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** The calendar end time, when the meeting came from an invite. */
  setEndsAt(endsAt: number | null): void {
    this.endsAt = endsAt && Number.isFinite(endsAt) ? endsAt : null;
    if (this.closeOutTimer) clearTimeout(this.closeOutTimer);
    this.closeOutTimer = null;
    if (!this.options || this.endsAt === null) return;
    const delay = this.endsAt - CLOSE_OUT_LEAD_MS - this.now();
    if (delay <= 0) return; // already inside the window: interval ticks run as close-outs
    this.closeOutTimer = setTimeout(() => this.request('closeout', 'schedule'), delay);
    if (typeof this.closeOutTimer.unref === 'function') this.closeOutTimer.unref();
  }

  /** Feed each final transcript turn; wrap-up language triggers a close-out. */
  noteSegment(text: string): void {
    if (!this.options || !detectWrapUp(text)) return;
    const now = this.now();
    if (now - this.options.startedAt < WRAP_UP_MIN_ELAPSED_MS) return;
    if (now - this.lastWrapUpAt < WRAP_UP_COOLDOWN_MS) return;
    this.lastWrapUpAt = now;
    this.request('closeout', 'wrap-up');
  }

  /** The Wrap-up button. */
  requestCloseOut(): void {
    this.request('closeout', 'manual');
  }

  /** "How am I doing?" */
  requestCheckIn(): void {
    this.request('pulse', 'check-in');
  }

  /** "Missed anything?" */
  requestMissed(): void {
    this.request('missed', 'missed');
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.closeOutTimer) clearTimeout(this.closeOutTimer);
    this.timer = null;
    this.closeOutTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
    this.current = null;
    this.superseded = null;
    this.pending = [];
    this.options = null;
    this.endsAt = null;
  }

  private inCloseOutWindow(): boolean {
    return this.endsAt !== null && this.now() >= this.endsAt - CLOSE_OUT_LEAD_MS;
  }

  private request(mode: PulseMode, trigger: PulseTrigger): void {
    if (!this.options) return;
    // Near the calendar end every timer read becomes a close-out, so the list
    // stays current through the last minutes. A question someone asked stays
    // the question they asked.
    if (trigger === 'interval' && this.inCloseOutWindow()) {
      mode = 'closeout';
      trigger = 'schedule';
    }
    const req: PulseRequest = { mode, trigger };
    if (!this.inFlight) {
      void this.run(mode, trigger);
      return;
    }
    // The same question already running or waiting: one answer covers both
    // presses (the app's hotkey and a page-level key can both fire).
    if ((this.current && sameRequest(this.current, req)) || this.pending.some((p) => sameRequest(p, req))) return;

    if (isAskedTrigger(trigger)) {
      // A person asked. A timer read in progress gives way: the next tick is
      // five minutes off, and the asked read covers the same ground.
      if (this.current?.trigger === 'interval' && this.abort) {
        this.superseded = this.abort;
        this.abort.abort();
      }
      const firstAuto = this.pending.findIndex((p) => !isAskedTrigger(p.trigger));
      if (firstAuto === -1) this.pending.push(req);
      else this.pending.splice(firstAuto, 0, req);
      if (this.pending.length > MAX_PENDING) this.pending.length = MAX_PENDING;
      return;
    }
    // At most one timer read waits, and a close-out outranks a regular one.
    const autoIdx = this.pending.findIndex((p) => !isAskedTrigger(p.trigger));
    if (autoIdx === -1) {
      if (this.pending.length < MAX_PENDING) this.pending.push(req);
    } else if (mode === 'closeout') {
      this.pending[autoIdx] = req;
    }
  }

  private async run(mode: PulseMode, trigger: PulseTrigger): Promise<void> {
    const options = this.options;
    if (!options) return;
    const asked = isAskedTrigger(trigger);
    const words = options.wordCountProvider();
    if (mode === 'pulse' && !asked && words - this.lastWords < MIN_NEW_WORDS) {
      this.emit('skipped', { reason: `growth: +${words - this.lastWords}/${MIN_NEW_WORDS}` });
      this.runNext();
      return;
    }
    const transcript = options.transcriptProvider();
    if (!transcript.trim()) {
      // Someone is waiting on this one: say why nothing is coming.
      if (asked) this.emit('failed', { mode, trigger, reason: 'Nothing has been said yet', latencyMs: 0 });
      this.runNext();
      return;
    }

    const gen = this.generation;
    const now = this.now();
    const minutesIn = Math.max(0, Math.round((now - options.startedAt) / 60_000));
    const minutesLeft = this.endsAt === null ? null : Math.round((this.endsAt - now) / 60_000);
    const prompt = buildPulsePrompt({
      title: options.title ?? '',
      attendees: options.attendees ?? '',
      transcript,
      goals: options.goalsProvider?.() ?? '',
      agenda: options.agendaProvider?.() ?? '',
      coachShown: options.coachProvider?.() ?? [],
      talkShare: options.talkShareProvider?.() ?? '',
      previous: this.previous,
      minutesIn,
      minutesLeft,
      mode,
      trigger,
    });

    this.inFlight = true;
    this.current = { mode, trigger };
    const abort = new AbortController();
    this.abort = abort;
    this.emit('running', { mode, trigger });
    try {
      const raw = await this.ask(prompt, PULSE_SYSTEM, abort.signal, { asked });
      if (gen !== this.generation) return;
      const parsed = parsePulse(raw, mode);
      if (!parsed) {
        this.emit('failed', { mode, trigger, reason: 'unparseable', latencyMs: this.now() - now });
        return;
      }
      this.lastWords = words;
      const result: MeetingPulseResult = {
        id: randomUUID(),
        mode,
        trigger,
        ...parsed,
        minutesIn,
        minutesLeft,
        createdAt: this.now(),
        latencyMs: this.now() - now,
      };
      this.previous = result;
      this.emit('pulse', result);
    } catch (error) {
      if (gen !== this.generation) return;
      if (this.superseded === abort) {
        this.emit('skipped', { reason: 'superseded by an asked read' });
        return;
      }
      this.emit('failed', { mode, trigger, reason: error instanceof Error ? error.message : String(error), latencyMs: this.now() - now });
    } finally {
      if (gen === this.generation) {
        this.inFlight = false;
        this.current = null;
        if (this.abort === abort) this.abort = null;
        if (this.superseded === abort) this.superseded = null;
        this.runNext();
      }
    }
  }

  private runNext(): void {
    const next = this.pending.shift();
    if (next) this.request(next.mode, next.trigger);
  }
}
