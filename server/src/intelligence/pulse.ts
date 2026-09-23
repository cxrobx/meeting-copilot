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
const MAX_CLOSE_OUT = { pulse: 3, closeout: 5 } as const;

export type PulseStatus = 'on_track' | 'drifting' | 'stuck';
export type PulseMode = 'pulse' | 'closeout';
export type PulseTrigger = 'interval' | 'schedule' | 'wrap-up' | 'manual';

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
  "closeOut": [{ "text": "...", "why": "..." }]
}

status: on_track = moving toward what the user wants; drifting = time going to side topics or the user's goals slipping; stuck = circling, blocked, or tension going unaddressed.

read: never generic ("the meeting is going well"). Name the thing that makes it on track, drifting or stuck.

escalations (0–2): only things that cost the user if left alone for the next few minutes. A direct question to the user still unanswered; a commitment made without an owner, date or scope; an objection or risk raised and not addressed; one of the user's goals slipping. Empty is a good answer; do not fill it.

closeOut: what must be settled before the call ends. Open questions, the next step with an owner and a date, agenda items not yet covered, decisions left hanging, an ask the user came to make. In a regular pulse list at most 3, and only ones already clear. In a close-out pass give the complete list, at most 5, most important first.

Every item's text is something the user can say or do now, 18 words or fewer ("Ask Dana who owns the pilot readout, and by when"). why is 12 words or fewer. Do not repeat a coach card already shown unless it is still unresolved. Do not invent facts; quote no more than 12 words verbatim.`;

export interface PulseContext {
  title: string;
  attendees: string;
  transcript: string;
  goals: string;
  agenda: string;
  coachShown: string[];
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
};

export function buildPulsePrompt(c: PulseContext): string {
  const parts: string[] = [];
  parts.push(`Meeting: ${c.title || 'Untitled'}${c.attendees ? `\nAttendees: ${c.attendees}` : ''}`);
  const timing = c.minutesLeft === null
    ? `${c.minutesIn} minutes in; scheduled end unknown.`
    : `${c.minutesIn} minutes in; about ${Math.max(0, c.minutesLeft)} minutes left on the calendar.`;
  parts.push(`Timing: ${timing}`);
  parts.push(c.mode === 'closeout'
    ? `This is a CLOSE-OUT pass (${TRIGGER_WORDS[c.trigger]}). Give the complete closeOut list.`
    : `This is a regular pulse (${TRIGGER_WORDS[c.trigger]}).`);
  if (c.goals.trim()) parts.push(`The user's private goals for this meeting:\n${c.goals.trim()}`);
  if (c.agenda.trim()) parts.push(`Agenda, with the tracker's current state:\n${c.agenda.trim()}`);
  if (c.coachShown.length) parts.push(`Coach cards already shown to the user:\n${c.coachShown.map((h) => `- ${h}`).join('\n')}`);
  if (c.previous) {
    const ago = Math.max(0, c.minutesIn - c.previous.minutesIn);
    const items = [...c.previous.escalations, ...c.previous.closeOut].map((i) => `- ${i.text}`).join('\n');
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
export function parsePulse(raw: string, mode: PulseMode): Pick<MeetingPulseResult, 'status' | 'read' | 'escalations' | 'closeOut'> | null {
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
  };
}

type PulseAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

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
}

export class MeetingPulse extends EventEmitter {
  private readonly ask: PulseAsk;
  private readonly now: () => number;
  private options: PulseStartOptions | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closeOutTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private inFlight = false;
  private pending: { mode: PulseMode; trigger: PulseTrigger } | null = null;
  private generation = 0;
  private lastWords = 0;
  private lastWrapUpAt = 0;
  private endsAt: number | null = null;
  private previous: MeetingPulseResult | null = null;

  constructor(deps: MeetingPulseDeps = {}) {
    super();
    this.ask = deps.ask ?? ((prompt, system, signal) => inCliLane(() =>
      claudeSuggest(prompt, system, signal, undefined, { model: MODEL_CONFIG.pulse, cold: true })));
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

  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.closeOutTimer) clearTimeout(this.closeOutTimer);
    this.timer = null;
    this.closeOutTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
    this.pending = null;
    this.options = null;
    this.endsAt = null;
  }

  private inCloseOutWindow(): boolean {
    return this.endsAt !== null && this.now() >= this.endsAt - CLOSE_OUT_LEAD_MS;
  }

  private request(mode: PulseMode, trigger: PulseTrigger): void {
    if (!this.options) return;
    // Near the calendar end every regular read becomes a close-out, so the
    // list stays current through the last minutes.
    if (mode === 'pulse' && this.inCloseOutWindow()) {
      mode = 'closeout';
      trigger = 'schedule';
    }
    if (this.inFlight) {
      // Keep the most useful request for when this one lands: a close-out
      // outranks a regular read.
      if (!this.pending || mode === 'closeout') this.pending = { mode, trigger };
      return;
    }
    void this.run(mode, trigger);
  }

  private async run(mode: PulseMode, trigger: PulseTrigger): Promise<void> {
    const options = this.options;
    if (!options) return;
    const words = options.wordCountProvider();
    if (mode === 'pulse' && words - this.lastWords < MIN_NEW_WORDS) {
      this.emit('skipped', { reason: `growth: +${words - this.lastWords}/${MIN_NEW_WORDS}` });
      return;
    }
    const transcript = options.transcriptProvider();
    if (!transcript.trim()) return;

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
      previous: this.previous,
      minutesIn,
      minutesLeft,
      mode,
      trigger,
    });

    this.inFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    this.emit('running', { mode, trigger });
    try {
      const raw = await this.ask(prompt, PULSE_SYSTEM, abort.signal);
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
      this.emit('failed', { mode, trigger, reason: error instanceof Error ? error.message : String(error), latencyMs: this.now() - now });
    } finally {
      if (gen === this.generation) {
        this.inFlight = false;
        if (this.abort === abort) this.abort = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.request(next.mode, next.trigger);
      }
    }
  }
}
