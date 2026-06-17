import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { claudeTriage } from '../claude-cli.js';
import {
  COACH_SYSTEM,
  buildCoachPrompt,
  type CoachSuggestionResult,
  type CoachKind,
} from './prompts/coach.v1.js';
import type { AgendaStatus } from './agenda.js';

const EVAL_INTERVAL_MS = 30_000;
const MIN_NEW_WORDS_BEFORE_EVAL = 30;
const WINDOW_TAIL_CHARS = 2_800;
const MIN_PRIORITY = 4;
const MAX_RECENT_SUGGESTIONS = 8;
// Event-driven triggering off moment-shaped segments.
const TRIGGER_MIN_GAP_MS = 15_000;
const TRIGGER_DEBOUNCE_MS = 2_000;

const MOMENT_HINTS: Record<string, string> = {
  'moment:question': 'A question appears to have just been directed at the user.',
  'moment:decision': 'A decision appears to be happening right now.',
  'moment:deferral': 'Something is being deferred or pushed out right now — if it touches the user\'s goals, this is the moment to push back.',
  'moment:commitment': 'Work was just mentioned without a clear owner or date.',
  'agenda-warning': 'The agenda tracker just flagged something as possibly missing.',
};

/**
 * Cheap local heuristic for "this is a moment the user might need to act on".
 * Only meeting-side segments trigger — tips react to what others say.
 */
export function detectMoment(text: string, source: string): string | null {
  if (source === 'mic' || !text) return null;
  if (/\?/.test(text) && /\b(you|your|we)\b/i.test(text)) return 'moment:question';
  if (/\b(let'?s go with|we'?ll go with|let'?s do|going with|decided|we agreed|agreed to|move forward with|finali[sz]e[ds]?|lock(ing)? (it |that )?in|ship it)\b/i.test(text)) return 'moment:decision';
  if (/\b(revisit|defer|postpone|punt on|park (it|this|that)|table (it|this|that)|push (it|this|that|the \w+) (to|out|back)|circle back|next (quarter|sprint|month|year) instead|not this (quarter|sprint|month|year))\b/i.test(text)) return 'moment:deferral';
  if (/\b(someone should|somebody should|we should|we need to|needs? to (happen|own|get done)|who'?s going to|who will)\b/i.test(text)) return 'moment:commitment';
  return null;
}

export interface CoachSuggestion {
  id: string;
  kind: CoachKind;
  priority: number;
  headline: string;
  phrasing: string;
  why: string;
  triggerQuote: string;
  createdAt: number;
}

/**
 * Opt-in "say next" coach. One cheap JSON call per window asking whether
 * there is ONE high-priority thing the user should mention, ask, or address.
 * Emits nothing for most windows by design.
 *
 * Fully inert until start() — zero API cost while toggled off.
 */
export class CoachMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private generation = 0;
  private currentEval: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  private transcriptProvider: () => string = () => '';
  private wordCountProvider: () => number = () => 0;
  private agendaStatusProvider: () => AgendaStatus | null = () => null;
  private goalsProvider: () => string = () => '';
  private speakerStatsProvider: () => { micWords: number; meetingWords: number } | null = () => null;
  private sessionTitle = '';
  private attendees = '';

  private lastEvalWordCount = 0;
  private lastRunAt = 0;
  private triggerTimer: ReturnType<typeof setTimeout> | null = null;
  private recentSuggestions: string[] = [];

  // Metrics
  public evalsRun = 0;
  public suggestionsEmitted = 0;

  isRunning(): boolean {
    return this.running;
  }

  start(options: {
    transcriptProvider: () => string;
    wordCountProvider: () => number;
    agendaStatusProvider?: () => AgendaStatus | null;
    goalsProvider?: () => string;
    speakerStatsProvider?: () => { micWords: number; meetingWords: number } | null;
    sessionTitle?: string;
    attendees?: string;
  }): void {
    this.stop();
    this.transcriptProvider = options.transcriptProvider;
    this.wordCountProvider = options.wordCountProvider;
    this.agendaStatusProvider = options.agendaStatusProvider ?? (() => null);
    this.goalsProvider = options.goalsProvider ?? (() => '');
    this.speakerStatsProvider = options.speakerStatsProvider ?? (() => null);
    this.sessionTitle = options.sessionTitle ?? '';
    this.attendees = options.attendees ?? '';
    this.lastEvalWordCount = this.wordCountProvider();

    this.running = true;
    this.timer = setInterval(() => {
      this.scheduleEval('interval').catch(() => {/* surfaced via error event */});
    }, EVAL_INTERVAL_MS);
  }

  /**
   * Event-driven entry: called per transcript segment. Moment-shaped segments
   * (question at the user, decision language, ownerless work) fire an eval
   * within ~2s instead of waiting for the next interval.
   */
  noteSegment(text: string, source: string): void {
    if (!this.running) return;
    const moment = detectMoment(text, source);
    if (!moment) return;
    this.requestEval(moment);
  }

  /** Throttled external trigger (also used by the agenda-warning hook). */
  requestEval(reason: string): void {
    if (!this.running) return;
    if (Date.now() - this.lastRunAt < TRIGGER_MIN_GAP_MS) return;
    if (this.currentEval || this.triggerTimer) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      this.scheduleEval(reason).catch(() => {/* surfaced via error event */});
    }, TRIGGER_DEBOUNCE_MS);
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
    this.lastRunAt = 0;
    this.recentSuggestions = [];
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async scheduleEval(trigger: string): Promise<void> {
    if (!this.running) return;
    if (this.currentEval) {
      this.emit('eval', { skipped: 'in-flight', trigger });
      return;
    }

    if (trigger === 'interval') {
      // Interval evals gate on word growth; triggered evals bypass it — the
      // triggering moment is the signal.
      const words = this.wordCountProvider();
      if (words - this.lastEvalWordCount < MIN_NEW_WORDS_BEFORE_EVAL) {
        this.emit('eval', { skipped: `growth: +${words - this.lastEvalWordCount}/${MIN_NEW_WORDS_BEFORE_EVAL}`, trigger });
        return;
      }
    }

    const gen = this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    const task = this.runEval(gen, trigger, controller.signal)
      .catch((err) => {
        if (gen === this.generation) {
          this.emit('error', err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        this.currentEval = null;
        if (this.abortController === controller) this.abortController = null;
      });
    this.currentEval = task;
    await task;
  }

  private async runEval(gen: number, trigger: string, signal: AbortSignal): Promise<void> {
    const transcript = this.transcriptProvider();
    if (!transcript || transcript.trim().length < 60) return;
    this.lastEvalWordCount = this.wordCountProvider();
    this.lastRunAt = Date.now();

    const agendaStatus = this.agendaStatusProvider();
    const agendaSummary = agendaStatus && agendaStatus.items.length > 0
      ? agendaStatus.items.map((i) => `[${i.state}] ${i.text}`).join('\n') +
        (agendaStatus.missing.length > 0 ? `\nPossibly missing: ${agendaStatus.missing.join('; ')}` : '')
      : '';

    const stats = this.speakerStatsProvider();
    let speakerBalance = '';
    if (stats && stats.micWords + stats.meetingWords > 100) {
      const share = Math.round((stats.micWords / (stats.micWords + stats.meetingWords)) * 100);
      speakerBalance = `the user has spoken ${share}% of the words so far`;
    }

    const prompt = buildCoachPrompt({
      transcriptWindow: transcript.slice(-WINDOW_TAIL_CHARS),
      agendaSummary,
      meetingTitle: this.sessionTitle,
      attendees: this.attendees,
      recentSuggestions: this.recentSuggestions,
      userGoals: this.goalsProvider(),
      speakerBalance,
      momentHint: MOMENT_HINTS[trigger],
    });

    this.evalsRun++;
    // CLI-only (subscription, no paid API): Gemini → Haiku → Codex chain.
    const raw = await claudeTriage(
      `${prompt}\n\nRespond with JSON only, no prose or code fences: {"hasSuggestion" (bool), "kind" ("mention"|"ask"|"address"), "priority" (1-5 integer), "headline", "phrasing", "why", "triggerQuote"}`,
      COACH_SYSTEM,
      signal,
    );
    if (gen !== this.generation) return;

    let result: CoachSuggestionResult;
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      result = JSON.parse(start !== -1 && end > start ? raw.slice(start, end + 1) : raw) as CoachSuggestionResult;
    } catch {
      this.emit('eval', { skipped: 'parse-failed' });
      return;
    }

    if (!result.hasSuggestion || result.priority < MIN_PRIORITY || !result.phrasing) {
      this.emit('eval', { suggested: false, priority: result.priority ?? 0, trigger });
      return;
    }

    // Soft dedup against recent suggestions by headline overlap
    const normalized = result.headline.toLowerCase().trim();
    if (this.recentSuggestions.some((s) => s.toLowerCase().includes(normalized) || normalized.includes(s.toLowerCase()))) {
      this.emit('eval', { skipped: 'duplicate', headline: result.headline, trigger });
      return;
    }
    this.recentSuggestions.push(result.headline);
    if (this.recentSuggestions.length > MAX_RECENT_SUGGESTIONS) this.recentSuggestions.shift();

    this.suggestionsEmitted++;
    const suggestion: CoachSuggestion = {
      id: randomUUID(),
      kind: result.kind,
      priority: result.priority,
      headline: result.headline,
      phrasing: result.phrasing,
      why: result.why,
      triggerQuote: result.triggerQuote,
      createdAt: Date.now(),
    };
    this.emit('suggestion', suggestion);
  }
}
