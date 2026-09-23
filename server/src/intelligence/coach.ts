import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MODEL_CONFIG } from '../model-config.js';
import { runLiveJson } from './live-json.js';
import { parseFirstJsonObject } from './first-json.js';
import {
  COACH_ASK_SYSTEM,
  COACH_SCHEMA,
  COACH_SYSTEM,
  buildCoachPrompt,
  type CoachIncidentType,
  type CoachSuggestionResult,
  type CoachKind,
} from './prompts/coach.v1.js';
import type { AgendaStatus } from './agenda.js';
import { jevMomentGate, type MomentGate } from './moment-gate.js';

const EVAL_INTERVAL_MS = 25_000;
const MIN_NEW_WORDS_BEFORE_EVAL = 25;
const WINDOW_TAIL_CHARS = 3_600;
const MAX_RECENT_TURNS = 10;
const MAX_TURN_CHARS = 900;
// An omitted card costs more than a shown one. Chris's call, 2026-09-19: "I'd
// rather the cards be noisy and I select the ones I need than they don't
// trigger enough and I have to manually type the card or miss it completely."
// A card he ignores costs a glance; a missed one costs him the moment in a live
// client meeting.
//
// This was priority 5 on the opposite reasoning ("a live interruption has a
// much higher cost than an omitted nice-to-have"), and it showed: across ten
// recorded sessions the coach computed 112 evaluations in one 40-minute meeting
// and surfaced 2 cards, withholding 85 of them below these floors.
const MIN_PRIORITY = 4;
const MIN_CONFIDENCE = 0.55;
const MAX_RECENT_SUGGESTIONS = 8;
const TRIGGER_DEBOUNCE_MS = 250;
// 13% of coach evaluations (15 of 112 in the 2026-09-14 session) were computed
// and then binned for crossing this line — pure latency casualties, advice that
// existed and was thrown away. The Jev gate now spends up to 800ms ahead of the
// generative call, so 4s would bin more still. 6s keeps advice inside the
// window where it is still about the moment.
export const ADVICE_DEADLINE_MS = 6_000;
const INCIDENT_COOLDOWN_MS = 12_000;
// One card per KIND of incident per minute. The 12s cooldown above is keyed on
// the utterance text, so each new sentence is a new incident: the 09-21 call
// got "Qualify your capacity", "Qualify the flexibility claim" and "Set a
// clear capacity boundary" at 21:13:11, :13 and :15 — each on screen ~2s
// before the next replaced it. The earlier card stays in the coach history,
// so holding the next one back costs little.
export const TYPE_COOLDOWN_MS = 60_000;
const RECENT_SUGGESTION_MS = 2 * 60_000;
// "Suggest" has someone waiting on it, so it gets the time a real answer
// takes, CLI fallback included, instead of the 6s freshness window. The
// direct API answers in ~3s; the subscription CLI took 19-24s for these
// prompts on 2026-09-22 (Haiku), so 25s failed there and 45s does not.
const ASK_PROVIDER_TIMEOUT_MS = 8_000;
export const ASK_DEADLINE_MS = 45_000;
// An asked card stays until dismissed; this only bounds a reconnect replay.
const ASKED_CARD_MS = 10 * 60_000;
const ASK_HINT = 'The user pressed Suggest and wants the single most useful thing to say, ask, or raise next.';

const MOMENT_HINTS: Record<string, string> = {
  'moment:question': 'A question appears to have been directed at the user. Check whether a concise answer or clarifying question is needed.',
  'moment:pressure': 'The other side appears to be applying pressure, challenging the user, or demanding a commitment.',
  'moment:objection': 'The other side appears to be objecting or signaling that the answer did not resolve their concern.',
  'moment:answer-review': 'The user just answered a question. Check only for a material miss, unsupported claim, evasion, or recoverable misunderstanding.',
  'moment:overcommitment': 'The user may have made a deadline, scope, price, or certainty commitment that needs qualification.',
  'moment:confusion': 'The exchange suggests confusion or misalignment that may need a quick reset.',
  'moment:decision': 'A decision appears to be happening now.',
  'moment:deferral': 'Something is being deferred. Check whether this threatens the user’s agenda or goals.',
  'moment:commitment': 'Work was mentioned without a clear owner, date, or boundary.',
  'agenda-warning': 'The agenda tracker flagged an item that may be missed.',
  interval: 'Periodic safety check. Intervene only for an unresolved, high-stakes moment still active in the latest turns.',
};

const QUESTION_START_RE = /\b(who|what|when|where|why|how|can|could|would|will|do|does|did|is|are|should|walk me through|help me understand|tell me)\b/i;
const PRESSURE_RE = /\b(need you|need an answer|you (?:must|have|need) to|we need you to|commit (?:today|now|by)|non[- ]negotiable|not acceptable|unacceptable|why (?:didn'?t|haven'?t|can'?t) you|hold you accountable|make this right|escalat(?:e|ing)|final offer)\b/i;
const OBJECTION_RE = /\b(that (?:doesn'?t|does not) (?:answer|work|address)|not what (?:i|we) asked|i (?:don'?t|do not) (?:buy|agree)|we (?:don'?t|do not) agree|too (?:expensive|slow|late|risky)|concerned|concern is|push(?:ing)? back|disagree|disappointed|still not clear|be direct)\b/i;
const CONFUSION_RE = /\b(i'?m confused|we'?re confused|not clear|misunderst(?:and|ood)|talking past each other|disconnect|doesn'?t make sense|contradict)\b/i;
const MIC_COMMITMENT_RE = /\b(i|we) (?:guarantee|promise|definitely|absolutely)\b|\b(?:no problem|consider it done|one hundred percent|100%)\b/i;
const MIC_DEADLINE_RE = /\b(i|we) (?:will|can|should be able to) .{0,80}\bby (?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|next week|end of (?:day|week|month|quarter))\b/i;
const DECISION_RE = /\b(let'?s go with|we'?ll go with|let'?s do|going with|decided|we agreed|agreed to|move forward with|finali[sz]e[ds]?|lock(?:ing)? (?:it |that )?in|ship it)\b/i;
const DEFERRAL_RE = /\b(revisit|defer|postpone|punt on|park (?:it|this|that)|table (?:it|this|that)|push (?:it|this|that|the \w+) (?:to|out|back)|circle back|next (?:quarter|sprint|month|year) instead|not this (?:quarter|sprint|month|year))\b/i;
const COMMITMENT_RE = /\b(someone should|somebody should|we should|we need to|needs? to (?:happen|own|get done)|who'?s going to|who will)\b/i;
const DIRECTED_QUESTION_RE = /\b(you|your|yours|y['’]?all|you all)\b/i;

export interface MomentContext {
  previousSource?: 'mic' | 'meeting';
  previousText?: string;
  final?: boolean;
}

/**
 * Cheap, permissive local gate. The model remains the precision layer; these
 * patterns decide only whether a turn is worth sending under the live budget.
 */
export function detectMoment(
  text: string,
  source: string,
  context: MomentContext = {},
): string | null {
  const value = (text ?? '').trim();
  if (!value) return null;

  if (source === 'mic') {
    if (MIC_DEADLINE_RE.test(value) || MIC_COMMITMENT_RE.test(value)) {
      return 'moment:overcommitment';
    }
    if (context.final !== false && context.previousSource === 'meeting') {
      const previous = context.previousText ?? '';
      if (
        DIRECTED_QUESTION_RE.test(previous)
        && (previous.includes('?') || QUESTION_START_RE.test(previous))
      ) {
        return 'moment:answer-review';
      }
    }
    return null;
  }

  if (OBJECTION_RE.test(value)) return 'moment:objection';
  if (PRESSURE_RE.test(value)) return 'moment:pressure';
  if (CONFUSION_RE.test(value)) return 'moment:confusion';
  // Ordinary questions do not need pre-answer coaching. High-stakes questions
  // are caught above as pressure/objections; a weak response is caught on the
  // finalized mic turn as answer-review. This saves both attention and calls.
  if (DECISION_RE.test(value)) return 'moment:decision';
  if (DEFERRAL_RE.test(value)) return 'moment:deferral';
  if (COMMITMENT_RE.test(value)) return 'moment:commitment';
  return null;
}

export interface CoachSuggestion {
  id: string;
  /** The user pressed Suggest; the card stays until they dismiss it. */
  asked?: boolean;
  incidentId: string;
  incidentType: CoachIncidentType;
  kind: CoachKind;
  priority: number;
  confidence: number;
  headline: string;
  phrasing: string;
  why: string;
  triggerQuote: string;
  createdAt: number;
  expiresAt: number;
  latencyMs: number;
}

interface CoachTurn {
  id: string;
  text: string;
  source: 'mic' | 'meeting';
  final: boolean;
  updatedAt: number;
}

interface PendingTrigger {
  reason: string;
  incidentId: string;
  incidentKey: string;
  source: 'mic' | 'meeting' | 'system';
  text: string;
  requestedAt: number;
}

type CoachTriage = (
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
  timeouts?: { providerTimeoutMs: number; totalTimeoutMs: number },
) => Promise<string>;

export interface CoachStartOptions {
  transcriptProvider: () => string;
  wordCountProvider: () => number;
  agendaStatusProvider?: () => AgendaStatus | null;
  goalsProvider?: () => string;
  speakerStatsProvider?: () => { micWords: number; meetingWords: number } | null;
  sessionTitle?: string;
  attendees?: string;
}

export interface CoachEvalDeps {
  triage?: CoachTriage;
  now?: () => number;
  /**
   * Cheap typed judgment run BEFORE the generative call, to decide whether the
   * moment justifies paying for it. Defaults to the Jev gate, which opens
   * itself whenever Jev is unavailable — so tests and offline runs behave
   * exactly as they did before this existed.
   */
  gate?: MomentGate;
}

function normalizeIncidentKey(reason: string, text: string): string {
  return `${reason}:${text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)}`;
}

function reasonIncidentType(reason: string): CoachIncidentType {
  switch (reason) {
    case 'moment:pressure': return 'pressure';
    case 'moment:objection': return 'objection';
    case 'moment:answer-review': return 'bad_answer';
    case 'moment:overcommitment': return 'overcommitment';
    case 'moment:confusion': return 'confusion';
    case 'moment:decision': return 'decision';
    case 'moment:commitment': return 'commitment';
    case 'moment:question': return 'question';
    case 'agenda-warning':
    case 'moment:deferral':
      return 'agenda_risk';
    default:
      return 'none';
  }
}

function parseCoachResponse(raw: string): CoachSuggestionResult | null {
  if (!raw) return null;
  // First complete object — gpt-6-luna appends text after it (first-json.ts).
  const parsed = parseFirstJsonObject<Partial<CoachSuggestionResult>>(
    raw,
    (o) => typeof o.hasSuggestion === 'boolean',
  );
  if (!parsed) return null;
  try {
    if (typeof parsed.hasSuggestion !== 'boolean') return null;
    const kind: CoachKind = parsed.kind === 'mention' || parsed.kind === 'ask'
      ? parsed.kind
      : 'address';
    const allowedIncidentTypes: CoachIncidentType[] = [
      'none',
      'pressure',
      'objection',
      'bad_answer',
      'overcommitment',
      'confusion',
      'contradiction',
      'agenda_risk',
      'decision',
      'commitment',
      'question',
    ];
    return {
      hasSuggestion: parsed.hasSuggestion,
      kind,
      incidentType: allowedIncidentTypes.includes(parsed.incidentType as CoachIncidentType)
        ? parsed.incidentType as CoachIncidentType
        : 'none',
      priority: Number.isFinite(parsed.priority) ? Number(parsed.priority) : 0,
      confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0,
      headline: typeof parsed.headline === 'string' ? parsed.headline.trim() : '',
      phrasing: typeof parsed.phrasing === 'string' ? parsed.phrasing.trim() : '',
      why: typeof parsed.why === 'string' ? parsed.why.trim() : '',
      triggerQuote: typeof parsed.triggerQuote === 'string' ? parsed.triggerQuote.trim() : '',
      expiresInMs: Number.isFinite(parsed.expiresInMs) ? Number(parsed.expiresInMs) : 15_000,
    };
  } catch {
    return null;
  }
}

/**
 * Event-driven recovery coach. It evaluates both sides of the conversation,
 * keeps only a handful of recent turns, and drops advice that misses the
 * moment instead of showing a technically-correct but stale interruption.
 */
export class CoachMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private triggerTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private currentEval: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private pendingTrigger: PendingTrigger | null = null;

  private transcriptProvider: () => string = () => '';
  private wordCountProvider: () => number = () => 0;
  private agendaStatusProvider: () => AgendaStatus | null = () => null;
  private goalsProvider: () => string = () => '';
  private speakerStatsProvider: () => { micWords: number; meetingWords: number } | null = () => null;
  private sessionTitle = '';
  private attendees = '';

  private lastEvalWordCount = 0;
  private turns: CoachTurn[] = [];
  private recentSuggestions: Array<{ text: string; at: number }> = [];
  private askInFlight: Promise<CoachSuggestion | null> | null = null;
  private askAbort: AbortController | null = null;
  private recentIncidents = new Map<string, number>();
  private lastShownByType = new Map<CoachIncidentType, number>();
  private totalLatencyMs = 0;
  private staleResults = 0;

  public evalsRun = 0;
  public suggestionsEmitted = 0;

  private readonly triage: CoachTriage;
  private readonly now: () => number;
  private readonly gate: MomentGate;

  public gateSkips = 0;
  public gateSavedCalls = 0;

  constructor(deps: CoachEvalDeps = {}) {
    super();
    this.now = deps.now ?? Date.now;
    this.gate = deps.gate ?? jevMomentGate;
    this.triage = deps.triage ?? (async (prompt, systemPrompt, signal, timeouts) => {
      const result = await runLiveJson({
        prompt,
        systemPrompt,
        schema: COACH_SCHEMA,
        openAiModel: MODEL_CONFIG.coach,
        label: 'live-coach',
        signal,
        // Real Terra smoke: 2.72s end-to-end on a 649-token coach prompt.
        // Keep the direct provider inside the 4s freshness SLA instead of
        // aborting a useful response at an unrealistically tight 1.8s.
        providerTimeoutMs: timeouts?.providerTimeoutMs ?? 3_500,
        totalTimeoutMs: timeouts?.totalTimeoutMs ?? ADVICE_DEADLINE_MS,
        maxOutputTokens: 240,
      });
      return result.text;
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getMetrics(): {
    evalsRun: number;
    suggestionsEmitted: number;
    staleResults: number;
    avgLatencyMs: number;
  } {
    return {
      evalsRun: this.evalsRun,
      suggestionsEmitted: this.suggestionsEmitted,
      staleResults: this.staleResults,
      avgLatencyMs: this.evalsRun > 0 ? Math.round(this.totalLatencyMs / this.evalsRun) : 0,
    };
  }

  start(options: CoachStartOptions): void {
    this.stop();
    this.configure(options);
    this.lastEvalWordCount = this.wordCountProvider();
    this.evalsRun = 0;
    this.suggestionsEmitted = 0;
    this.totalLatencyMs = 0;
    this.staleResults = 0;
    this.running = true;
    this.timer = setInterval(() => this.queueTrigger({
      reason: 'interval',
      source: 'system',
      text: '',
    }), EVAL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Called for both open transcript updates and finalized turns. Meeting-side
   * questions/pressure may trigger on a stable partial; mic answer review waits
   * for the cohesive final turn unless the user makes an explicit commitment.
   */
  noteSegment(
    text: string,
    source: 'mic' | 'meeting',
    options: { final?: boolean; segmentId?: string; timestamp?: number } = {},
  ): void {
    if (!this.running) return;
    const value = (text ?? '').trim();
    if (!value) return;
    const final = options.final ?? true;
    const segmentId = options.segmentId ?? randomUUID();
    const previous = [...this.turns].reverse().find((turn) => turn.id !== segmentId && turn.final);
    this.upsertTurn({
      id: segmentId,
      text: value.slice(0, MAX_TURN_CHARS),
      source,
      final,
      updatedAt: options.timestamp ?? this.now(),
    });

    const moment = detectMoment(value, source, {
      previousSource: previous?.source,
      previousText: previous?.text,
      final,
    });
    if (!moment) return;
    if (!final && source === 'mic' && moment !== 'moment:overcommitment') return;

    this.queueTrigger({
      reason: moment,
      source,
      text: value,
      incidentId: `${segmentId}:${moment}:${value.length}`,
    });
  }

  /**
   * "Suggest": one card now, on request. Works with the live coach off (it
   * reads from `options` then), skips the Jev gate, the per-type cooldown and
   * the priority/confidence floors, and gets a longer deadline, because the
   * user asked. Resolves to the card, or null when the model had nothing;
   * rejects on failure. A second press while one runs shares its answer.
   */
  askNow(focus: string, options?: CoachStartOptions): Promise<CoachSuggestion | null> {
    if (this.askInFlight) return this.askInFlight;
    if (!this.running && options) this.configure(options);
    const controller = new AbortController();
    this.askAbort = controller;
    const task = this.runAsked(focus.trim().slice(0, 300), controller.signal).finally(() => {
      if (this.askInFlight === task) this.askInFlight = null;
      if (this.askAbort === controller) this.askAbort = null;
    });
    this.askInFlight = task;
    return task;
  }

  /** Session end: an answer to a meeting that is over is not worth showing. */
  cancelAsk(): void {
    this.askAbort?.abort();
    this.askAbort = null;
    this.askInFlight = null;
  }

  /** External trigger, currently used by agenda risk warnings. */
  requestEval(reason: string): void {
    this.queueTrigger({ reason, source: 'system', text: '' });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.triggerTimer) {
      clearTimeout(this.triggerTimer);
      this.triggerTimer = null;
    }
    this.generation++;
    this.running = false;
    this.lastEvalWordCount = 0;
    this.turns = [];
    this.pendingTrigger = null;
    this.recentSuggestions = [];
    this.recentIncidents.clear();
    this.lastShownByType.clear();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private configure(options: CoachStartOptions): void {
    this.transcriptProvider = options.transcriptProvider;
    this.wordCountProvider = options.wordCountProvider;
    this.agendaStatusProvider = options.agendaStatusProvider ?? (() => null);
    this.goalsProvider = options.goalsProvider ?? (() => '');
    this.speakerStatsProvider = options.speakerStatsProvider ?? (() => null);
    this.sessionTitle = options.sessionTitle ?? '';
    this.attendees = options.attendees ?? '';
  }

  private upsertTurn(turn: CoachTurn): void {
    const existing = this.turns.findIndex((candidate) => candidate.id === turn.id);
    if (existing >= 0) this.turns[existing] = turn;
    else this.turns.push(turn);
    this.turns.sort((a, b) => a.updatedAt - b.updatedAt);
    if (this.turns.length > MAX_RECENT_TURNS) {
      this.turns.splice(0, this.turns.length - MAX_RECENT_TURNS);
    }
  }

  private queueTrigger(params: {
    reason: string;
    source: 'mic' | 'meeting' | 'system';
    text: string;
    incidentId?: string;
  }): void {
    if (!this.running) return;
    const now = this.now();
    const incidentKey = normalizeIncidentKey(params.reason, params.text);
    const recentUntil = this.recentIncidents.get(incidentKey) ?? 0;
    if (recentUntil > now && !this.currentEval) return;

    this.pendingTrigger = {
      reason: params.reason,
      incidentId: params.incidentId ?? `${params.reason}:${now}`,
      incidentKey,
      source: params.source,
      text: params.text.slice(0, MAX_TURN_CHARS),
      requestedAt: now,
    };
    if (this.currentEval) {
      this.emit('eval', { queued: 'latest', trigger: params.reason });
      return;
    }
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      const trigger = this.pendingTrigger;
      this.pendingTrigger = null;
      if (trigger) this.scheduleEval(trigger).catch(() => {/* surfaced via events */});
    }, params.reason === 'interval' ? 0 : TRIGGER_DEBOUNCE_MS);
    if (typeof this.triggerTimer.unref === 'function') this.triggerTimer.unref();
  }

  private async scheduleEval(trigger: PendingTrigger): Promise<void> {
    if (!this.running) return;
    if (this.currentEval) {
      this.pendingTrigger = trigger;
      return;
    }

    if (trigger.reason === 'interval') {
      const words = this.wordCountProvider();
      if (words - this.lastEvalWordCount < MIN_NEW_WORDS_BEFORE_EVAL) {
        this.emit('eval', {
          skipped: `growth: +${words - this.lastEvalWordCount}/${MIN_NEW_WORDS_BEFORE_EVAL}`,
          trigger: trigger.reason,
        });
        return;
      }
    }

    this.recentIncidents.set(trigger.incidentKey, this.now() + INCIDENT_COOLDOWN_MS);
    const gen = this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    const task = this.runEval(gen, trigger, controller.signal)
      .catch((error) => {
        if (gen !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Aborted') {
          this.staleResults++;
          this.emit('eval', { skipped: 'deadline', trigger: trigger.reason });
          return;
        }
        this.emit('error', message);
      })
      .finally(() => {
        if (this.currentEval === task) this.currentEval = null;
        if (this.abortController === controller) this.abortController = null;
        if (this.running && this.pendingTrigger) {
          const next = this.pendingTrigger;
          this.pendingTrigger = null;
          queueMicrotask(() => this.scheduleEval(next).catch(() => {/* surfaced via events */}));
        }
      });
    this.currentEval = task;
    await task;
  }

  private transcriptWindow(): string {
    if (this.turns.length > 0) {
      return this.turns
        .map((turn) => `${turn.source === 'mic' ? '[You]' : '[Meeting]'} ${turn.text}`)
        .join('\n')
        .slice(-WINDOW_TAIL_CHARS);
    }
    return this.transcriptProvider().slice(-WINDOW_TAIL_CHARS);
  }

  /** A card of this kind was shown under TYPE_COOLDOWN_MS ago. 'none' never cools. */
  private inTypeCooldown(type: CoachIncidentType, now: number): boolean {
    if (type === 'none') return false;
    const last = this.lastShownByType.get(type);
    return last !== undefined && now - last < TYPE_COOLDOWN_MS;
  }

  private buildPrompt(
    transcriptWindow: string,
    now: number,
    moment: { momentHint?: string; triggerSource: 'mic' | 'meeting' | 'system'; triggerText: string },
  ): string {
    const agendaStatus = this.agendaStatusProvider();
    const agendaSummary = agendaStatus && agendaStatus.items.length > 0
      ? agendaStatus.items.map((item) => `[${item.state}] ${item.text}`).join('\n')
        + (agendaStatus.missing.length > 0
          ? `\nPossibly missing: ${agendaStatus.missing.join('; ')}`
          : '')
      : '';

    const stats = this.speakerStatsProvider();
    let speakerBalance = '';
    if (stats && stats.micWords + stats.meetingWords > 100) {
      const share = Math.round((stats.micWords / (stats.micWords + stats.meetingWords)) * 100);
      speakerBalance = `the user has spoken ${share}% of the words so far`;
    }

    this.recentSuggestions = this.recentSuggestions.filter(
      (suggestion) => now - suggestion.at <= RECENT_SUGGESTION_MS,
    );
    return buildCoachPrompt({
      transcriptWindow,
      agendaSummary,
      meetingTitle: this.sessionTitle,
      attendees: this.attendees,
      recentSuggestions: this.recentSuggestions.map((suggestion) => suggestion.text),
      userGoals: this.goalsProvider(),
      speakerBalance,
      ...moment,
    });
  }

  private async runAsked(focus: string, signal: AbortSignal): Promise<CoachSuggestion | null> {
    const transcriptWindow = this.transcriptWindow();
    if (!transcriptWindow || transcriptWindow.trim().length < 20) {
      throw new Error('Nothing has been said yet');
    }
    const now = this.now();
    const prompt = this.buildPrompt(transcriptWindow, now, {
      momentHint: focus ? `${ASK_HINT} Their focus: "${focus}".` : ASK_HINT,
      triggerSource: 'system',
      triggerText: '',
    });

    const startedAt = this.now();
    this.evalsRun++;
    let raw: string;
    try {
      raw = await this.triage(prompt, COACH_ASK_SYSTEM, signal, {
        providerTimeoutMs: ASK_PROVIDER_TIMEOUT_MS,
        totalTimeoutMs: ASK_DEADLINE_MS,
      });
    } catch (error) {
      // Only cancelAsk() means "the meeting ended". The model call's own
      // deadline also surfaces as 'Aborted', and the user is waiting on it.
      if (signal.aborted) throw new Error('Aborted');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message === 'Aborted' ? `No answer within ${ASK_DEADLINE_MS / 1000}s` : message);
    }
    if (signal.aborted) throw new Error('Aborted');
    const latencyMs = this.now() - startedAt;
    this.totalLatencyMs += latencyMs;

    const result = parseCoachResponse(raw);
    if (!result) {
      this.emit('eval', { asked: true, skipped: 'parse-failed', latencyMs });
      throw new Error('The coach answer could not be read');
    }
    if (!result.hasSuggestion || !result.phrasing) {
      this.emit('eval', { asked: true, suggested: false, latencyMs });
      return null;
    }

    const createdAt = this.now();
    const incidentType = result.incidentType;
    this.lastShownByType.set(incidentType, createdAt);
    const suggestion: CoachSuggestion = {
      id: randomUUID(),
      asked: true,
      incidentId: `asked:${createdAt}`,
      incidentType,
      kind: result.kind,
      priority: Math.max(1, Math.min(5, Math.round(result.priority || 4))),
      confidence: Math.max(0, Math.min(1, result.confidence)),
      headline: result.headline.slice(0, 80),
      phrasing: result.phrasing.slice(0, 280),
      why: result.why.slice(0, 180),
      triggerQuote: result.triggerQuote.slice(0, 180),
      createdAt,
      expiresAt: createdAt + ASKED_CARD_MS,
      latencyMs,
    };
    this.recentSuggestions.push({ text: `${suggestion.headline} ${suggestion.phrasing}`, at: createdAt });
    if (this.recentSuggestions.length > MAX_RECENT_SUGGESTIONS) this.recentSuggestions.shift();
    this.suggestionsEmitted++;
    this.emit('suggestion', suggestion);
    this.emit('eval', { asked: true, completed: true, suggested: true, incidentType, latencyMs });
    return suggestion;
  }

  private async runEval(
    gen: number,
    trigger: PendingTrigger,
    signal: AbortSignal,
  ): Promise<void> {
    const transcriptWindow = this.transcriptWindow();
    if (!transcriptWindow || transcriptWindow.trim().length < 20) return;
    this.lastEvalWordCount = this.wordCountProvider();

    const now = this.now();
    const prompt = this.buildPrompt(transcriptWindow, now, {
      momentHint: MOMENT_HINTS[trigger.reason],
      triggerSource: trigger.source,
      triggerText: trigger.text,
    });

    // Checked before the gate so a held-back card costs neither call.
    const triggerType = reasonIncidentType(trigger.reason);
    if (this.inTypeCooldown(triggerType, now)) {
      this.emit('eval', { skipped: 'type-cooldown', incidentType: triggerType, trigger: trigger.reason });
      return;
    }

    // Cheap typed judgment before the expensive generative one. A closed gate
    // only ever saves a call — it fails open on error, timeout, or an
    // unavailable Jev, so coaching can never go silent because of it.
    const verdict = await this.gate(transcriptWindow, signal);
    if (gen !== this.generation) return;
    if (!verdict.open) {
      this.gateSkips++;
      this.gateSavedCalls++;
      this.emit('eval', {
        skipped: 'gate',
        gateReason: verdict.reason,
        worth: verdict.worth,
        asked: verdict.asked,
        pushback: verdict.pushback,
        gateLatencyMs: verdict.latencyMs,
        trigger: trigger.reason,
      });
      return;
    }

    const startedAt = this.now();
    this.evalsRun++;
    const raw = await this.triage(prompt, COACH_SYSTEM, signal);
    const latencyMs = this.now() - startedAt;
    this.totalLatencyMs += latencyMs;
    if (gen !== this.generation) return;

    if (this.now() - trigger.requestedAt > ADVICE_DEADLINE_MS) {
      this.staleResults++;
      this.emit('eval', { skipped: 'stale', trigger: trigger.reason, latencyMs });
      return;
    }

    const result = parseCoachResponse(raw);
    if (!result) {
      this.emit('eval', { skipped: 'parse-failed', trigger: trigger.reason, latencyMs });
      return;
    }
    const confidence = Math.max(0, Math.min(1, result.confidence));
    if (
      !result.hasSuggestion
      || result.priority < MIN_PRIORITY
      || confidence < MIN_CONFIDENCE
      || !result.phrasing
    ) {
      this.emit('eval', {
        suggested: false,
        priority: result.priority,
        confidence,
        trigger: trigger.reason,
        latencyMs,
      });
      return;
    }

    const normalized = `${result.headline} ${result.phrasing}`.toLowerCase().trim();
    if (this.recentSuggestions.some((suggestion) => {
      const prior = suggestion.text.toLowerCase();
      return prior.includes(normalized) || normalized.includes(prior);
    })) {
      this.emit('eval', {
        skipped: 'duplicate',
        headline: result.headline,
        trigger: trigger.reason,
        latencyMs,
      });
      return;
    }

    const createdAt = this.now();
    const expiresInMs = Math.max(8_000, Math.min(30_000, result.expiresInMs || 15_000));
    const incidentType = result.incidentType === 'none'
      ? reasonIncidentType(trigger.reason)
      : result.incidentType;
    // Again after the call: the model may name a different type than the
    // trigger did (an interval check that finds an overcommitment).
    if (this.inTypeCooldown(incidentType, createdAt)) {
      this.emit('eval', { skipped: 'type-cooldown', incidentType, trigger: trigger.reason, latencyMs });
      return;
    }
    this.lastShownByType.set(incidentType, createdAt);
    const suggestion: CoachSuggestion = {
      id: randomUUID(),
      incidentId: trigger.incidentId,
      incidentType,
      kind: result.kind,
      priority: Math.max(1, Math.min(5, Math.round(result.priority))),
      confidence,
      headline: result.headline.slice(0, 80),
      phrasing: result.phrasing.slice(0, 280),
      why: result.why.slice(0, 180),
      triggerQuote: result.triggerQuote.slice(0, 180),
      createdAt,
      expiresAt: createdAt + expiresInMs,
      latencyMs,
    };

    this.recentSuggestions.push({
      text: `${suggestion.headline} ${suggestion.phrasing}`,
      at: createdAt,
    });
    if (this.recentSuggestions.length > MAX_RECENT_SUGGESTIONS) {
      this.recentSuggestions.shift();
    }
    this.suggestionsEmitted++;
    this.emit('suggestion', suggestion);
    this.emit('eval', {
      completed: true,
      suggested: true,
      incidentType,
      trigger: trigger.reason,
      latencyMs,
    });
  }
}
