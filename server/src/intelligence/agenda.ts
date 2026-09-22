import { EventEmitter } from 'node:events';
import { claudeChat } from '../claude-cli.js';
import { MODEL_CONFIG } from '../model-config.js';
import { runLiveJson } from './live-json.js';
import { parseFirstJsonObject } from './first-json.js';

// Agenda updates have two lanes: lexical candidate turns take the short delta
// path immediately; this slower timer reconciles state and catches semantic
// matches that local token overlap cannot see.
const EVAL_INTERVAL_MS = 30_000;
const DELTA_DEBOUNCE_MS = 250;
const MIN_NEW_WORDS_BEFORE_EVAL = 5;
// First eval fires when transcript reaches this total word count — doesn't
// require waiting for MIN_NEW_WORDS_BEFORE_EVAL of growth.
const MIN_TOTAL_WORDS_FOR_FIRST_EVAL = 15;
const MAX_DELTA_CHARS = 5_000;
// Exported so `npm run eval:agenda` replays the exact production call rather
// than a copy that drifts (the coach benchmark scored against a stale deadline
// for exactly that reason).
export const MAX_RECONCILE_CHARS = 30_000;
export const RECONCILE_PROVIDER_TIMEOUT_MS = 4_000;
export const RECONCILE_TOTAL_TIMEOUT_MS = 7_000;
export const RECONCILE_MAX_OUTPUT_TOKENS = 900;

const EXTRACT_MAX_ITEMS = 20;
const EXTRACT_ITEM_MAX_CHARS = 150;
const BULLET_PREFIX_RE = /^[\s\-\*•‣]+/;
const NUMBERED_PREFIX_RE = /^\d+[\.\)]\s*/;
const TRAILING_PUNCTUATION_RE = /[\s.,;:!?]+$/;

export type AgendaItemState = 'pending' | 'partial' | 'covered';

export interface AgendaItem {
  id: string;
  text: string;
  state: AgendaItemState;
  evidence?: string;
  updatedAt?: number;
}

export interface AgendaStatus {
  items: AgendaItem[];
  missing: string[];
  lastEvalAt: number;
  fullyCovered: boolean;
}

export interface AgendaEvalResponse {
  items: Array<{
    id: string;
    state: AgendaItemState;
    evidence?: string;
  }>;
  missing_warnings?: string[];
}

/**
 * Parses a freeform agenda string into discrete items.
 * Supports: one-per-line, bulleted (-, *, •, numbered 1., 2)), or comma-separated single-line.
 */
export function parseAgenda(raw: string): AgendaItem[] {
  if (!raw) return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let rawItems: string[];

  if (lines.length > 1) {
    rawItems = lines;
  } else {
    // Single line — split on commas/semicolons if present
    const parts = trimmed.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    rawItems = parts.length > 1 ? parts : [trimmed];
  }

  return rawItems
    .map((s) => s.replace(/^[\s\-\*•‣]+/, '').replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean)
    .map((text, idx) => ({
      id: `a${idx + 1}`,
      text,
      state: 'pending' as AgendaItemState,
    }));
}

type AgendaTriage = (
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
) => Promise<string>;

export interface AgendaEvalDeps {
  /** Backward-compatible injection used for both lanes in existing tests. */
  triage?: AgendaTriage;
  deltaTriage?: AgendaTriage;
  reconcileTriage?: AgendaTriage;
}

export const AGENDA_SCHEMA = {
  name: 'agenda_status',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'missing_warnings'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'state', 'evidence'],
          properties: {
            id: { type: 'string' },
            state: { type: 'string', enum: ['pending', 'partial', 'covered'] },
            evidence: { type: 'string' },
          },
        },
      },
      missing_warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
} as const;

const AGENDA_DELTA_SYSTEM = `Role: Maintain a live meeting agenda from a small batch of new transcript turns.

For every supplied agenda id, return pending, partial, or covered:
- pending: the new turns add no evidence for this item.
- partial: the topic surfaced, a relevant question was asked, or discussion began.
- covered: the new turns contain an answer, decision, substantive exchange, or explicit deferral that closes this pass through the topic.

Preserve meaning across ordinary synonyms and imperfect ASR. Evidence must be a direct quote under 120 characters. A delta cannot erase earlier evidence: do not regress an existing partial/covered item merely because this small batch omits its history. Leave missing_warnings empty; the periodic reconciliation lane owns wrap-up warnings.

Return only the JSON contract.`;

const AGENDA_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'ask', 'about', 'be', 'confirm', 'cover', 'discuss',
  'do', 'for', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'our', 'review',
  'the', 'their', 'this', 'to', 'we', 'what', 'when', 'who', 'with',
]);

const AGENDA_ALIASES = [
  ['budget', 'cost', 'costs', 'price', 'pricing', 'spend'],
  ['timeline', 'schedule', 'date', 'dates', 'deadline', 'deadlines', 'when'],
  ['scope', 'deliverable', 'deliverables', 'requirement', 'requirements'],
  ['risk', 'risks', 'concern', 'concerns', 'blocker', 'blockers', 'problem'],
  ['owner', 'owners', 'ownership', 'responsible', 'who'],
  ['team', 'staffing', 'resource', 'resources', 'capacity'],
  ['decision', 'decide', 'approve', 'approval', 'confirm'],
  ['action', 'actions', 'followup', 'follow-up', 'next'],
] as const;

function agendaTokens(text: string): Set<string> {
  const raw = new Set(
    text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g)?.filter(
      (token) => token.length > 2 && !AGENDA_STOP_WORDS.has(token),
    ) ?? [],
  );
  for (const group of AGENDA_ALIASES) {
    if (group.some((token) => raw.has(token))) {
      for (const token of group) raw.add(token);
    }
  }
  return raw;
}

function isAgendaCandidate(items: AgendaItem[], text: string): boolean {
  const turnTokens = agendaTokens(text);
  if (turnTokens.size === 0) return false;
  return items
    .filter((item) => item.state !== 'covered')
    .some((item) => {
      const itemTokens = agendaTokens(item.text);
      for (const token of itemTokens) {
        if (turnTokens.has(token)) return true;
      }
      return false;
    });
}

export class AgendaTracker extends EventEmitter {
  private items: AgendaItem[] = [];
  private missing: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastEvalAt = 0;
  private lastEvalWordCount = 0;
  private transcriptProvider: () => string = () => '';
  private wordCountProvider: () => number = () => 0;
  private sessionTitle = '';
  private pendingTranscriptLines: string[] = [];
  private rerunRequested = false;
  private totalLatencyMs = 0;
  private completedEvals = 0;
  private staleResults = 0;

  // Generation token — bumped on every start() and stop(). Any in-flight eval
  // whose captured generation no longer matches is discarded before it can
  // mutate state or emit, so stale results from a prior session cannot bleed
  // into the next one.
  private generation = 0;

  // Promise for the currently-running evaluation (if any). `evaluateNow()`
  // awaits this before starting its own pass so forced final evals cannot be
  // dropped when the 30s loop is mid-flight.
  private currentEval: Promise<void> | null = null;

  // Abort controller for the in-flight triage call — signalled on stop().
  private abortController: AbortController | null = null;

  private readonly deltaTriage: AgendaTriage;
  private readonly reconcileTriage: AgendaTriage;

  constructor(deps: AgendaEvalDeps = {}) {
    super();
    const injected = deps.triage;
    this.deltaTriage = deps.deltaTriage ?? injected ?? (async (prompt, systemPrompt, signal) => {
      const result = await runLiveJson({
        prompt,
        systemPrompt,
        schema: AGENDA_SCHEMA,
        openAiModel: MODEL_CONFIG.agenda,
        label: 'agenda-delta',
        signal,
        providerTimeoutMs: 2_500,
        totalTimeoutMs: 5_000,
        maxOutputTokens: 700,
      });
      return result.text;
    });
    this.reconcileTriage = deps.reconcileTriage ?? injected ?? (async (prompt, systemPrompt, signal) => {
      const result = await runLiveJson({
        prompt,
        systemPrompt,
        schema: AGENDA_SCHEMA,
        openAiModel: MODEL_CONFIG.agendaReconcile,
        label: 'agenda-reconcile',
        signal,
        providerTimeoutMs: RECONCILE_PROVIDER_TIMEOUT_MS,
        totalTimeoutMs: RECONCILE_TOTAL_TIMEOUT_MS,
        maxOutputTokens: RECONCILE_MAX_OUTPUT_TOKENS,
      });
      return result.text;
    });
  }

  start(options: {
    agenda: string;
    transcriptProvider: () => string;
    wordCountProvider: () => number;
    sessionTitle?: string;
  }): AgendaItem[] {
    this.stop();
    // stop() already bumped the generation; the new session owns whatever
    // value `this.generation` now holds.
    this.items = parseAgenda(options.agenda);
    this.missing = [];
    this.transcriptProvider = options.transcriptProvider;
    this.wordCountProvider = options.wordCountProvider;
    this.sessionTitle = options.sessionTitle ?? '';
    this.lastEvalAt = 0;
    this.lastEvalWordCount = 0;
    this.pendingTranscriptLines = [];
    this.rerunRequested = false;
    this.totalLatencyMs = 0;
    this.completedEvals = 0;
    this.staleResults = 0;

    if (this.items.length === 0) {
      return [];
    }

    this.running = true;
    this.timer = setInterval(() => {
      this.scheduleEval().catch(() => {/* swallow */});
    }, EVAL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    return this.items;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    this.generation++;
    this.running = false;
    this.items = [];
    this.missing = [];
    this.transcriptProvider = () => '';
    this.wordCountProvider = () => 0;
    this.sessionTitle = '';
    this.lastEvalAt = 0;
    this.lastEvalWordCount = 0;
    this.pendingTranscriptLines = [];
    this.rerunRequested = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Do NOT null currentEval — the in-flight promise will still settle, but
    // its generation check will discard the result.
  }

  getStatus(): AgendaStatus {
    return {
      items: this.items.map((i) => ({ ...i })),
      missing: [...this.missing],
      lastEvalAt: this.lastEvalAt,
      fullyCovered: this.items.length > 0 && this.items.every((i) => i.state === 'covered'),
    };
  }

  getMetrics(): {
    completedEvals: number;
    staleResults: number;
    avgLatencyMs: number;
    pendingDeltaLines: number;
  } {
    return {
      completedEvals: this.completedEvals,
      staleResults: this.staleResults,
      avgLatencyMs: this.completedEvals > 0
        ? Math.round(this.totalLatencyMs / this.completedEvals)
        : 0,
      pendingDeltaLines: this.pendingTranscriptLines.length,
    };
  }

  /**
   * Feed a finalized cohesive transcript turn. Every turn is retained for the
   * next reconciliation; turns with lexical/alias overlap to an open agenda
   * item also take the immediate delta path.
   */
  noteSegment(text: string, source: 'mic' | 'meeting'): void {
    if (!this.running || this.items.length === 0) return;
    const value = (text ?? '').trim();
    if (!value) return;
    this.pendingTranscriptLines.push(`${source === 'mic' ? '[You]' : '[Meeting]'} ${value}`);
    while (this.pendingTranscriptLines.join('\n').length > MAX_DELTA_CHARS) {
      this.pendingTranscriptLines.shift();
    }
    if (isAgendaCandidate(this.items, value)) this.requestDeltaEval();
  }

  private requestDeltaEval(): void {
    if (!this.running) return;
    if (this.currentEval) {
      this.rerunRequested = true;
      this.emit('eval', { queued: 'latest', mode: 'delta' });
      return;
    }
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.runEvaluation(false, 'delta').catch(() => {/* surfaced via events */});
    }, DELTA_DEBOUNCE_MS);
    if (typeof this.deltaTimer.unref === 'function') this.deltaTimer.unref();
  }

  /**
   * Force an immediate evaluation (e.g., on session.stop for a final wrap-up).
   * Awaits any in-flight eval first so a forced pass is never silently dropped,
   * then runs a fresh pass against the current transcript.
   */
  async evaluateNow(): Promise<void> {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.currentEval) {
      try { await this.currentEval; } catch { /* already handled inside */ }
    }
    // After the prior eval settles, the session may have been stopped — in
    // that case `runEvaluation` bails on its own generation check.
    await this.runEvaluation(true, 'reconcile');
  }

  private async scheduleEval(): Promise<void> {
    if (!this.running || this.items.length === 0) return;
    if (this.currentEval) {
      this.emit('eval', { skipped: 'in-flight' });
      return;
    }

    const currentWordCount = this.wordCountProvider();
    const isFirstEval = this.lastEvalAt === 0;
    const gateReason = isFirstEval
      ? currentWordCount < MIN_TOTAL_WORDS_FOR_FIRST_EVAL
        ? `first-eval: ${currentWordCount}/${MIN_TOTAL_WORDS_FOR_FIRST_EVAL} words`
        : null
      : currentWordCount - this.lastEvalWordCount < MIN_NEW_WORDS_BEFORE_EVAL
        ? `growth: +${currentWordCount - this.lastEvalWordCount}/${MIN_NEW_WORDS_BEFORE_EVAL}`
        : null;

    if (gateReason) {
      this.emit('eval', { skipped: gateReason });
      return;
    }

    await this.runEvaluation(false, 'reconcile');
  }

  private async runEvaluation(
    force: boolean,
    mode: 'delta' | 'reconcile',
  ): Promise<void> {
    // Re-entrancy guard. Forced evals are expected to have awaited the
    // in-flight promise via `evaluateNow()` before reaching here.
    if (this.currentEval) return;

    const gen = this.generation;
    if (!force && !this.running) return;

    const consumedDeltaLines = this.pendingTranscriptLines.length;
    const transcript = mode === 'delta'
      ? this.pendingTranscriptLines.join('\n')
      : this.transcriptProvider().slice(-MAX_RECONCILE_CHARS);
    if (!transcript || transcript.trim().length < 20) {
      if (!force) return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    const task = this.doEvaluation(
      gen,
      transcript,
      controller.signal,
      mode,
      consumedDeltaLines,
    );
    this.currentEval = task;
    try {
      await task;
    } finally {
      if (this.currentEval === task) {
        this.currentEval = null;
      }
      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.running && this.rerunRequested) {
        this.rerunRequested = false;
        queueMicrotask(() => this.requestDeltaEval());
      }
    }
  }

  private async doEvaluation(
    gen: number,
    transcript: string,
    signal: AbortSignal,
    mode: 'delta' | 'reconcile',
    consumedDeltaLines: number,
  ): Promise<void> {
    const startedAt = Date.now();
    this.emit('eval', { started: true, words: this.wordCountProvider(), mode });
    try {
      const prompt = mode === 'delta'
        ? buildAgendaDeltaPrompt(this.items, transcript, this.sessionTitle)
        : buildAgendaEvalPrompt(this.items, transcript, this.sessionTitle);
      const raw = mode === 'delta'
        ? await this.deltaTriage(prompt, AGENDA_DELTA_SYSTEM, signal)
        : await this.reconcileTriage(prompt, AGENDA_EVAL_SYSTEM, signal);

      // Stale-guard: drop the result if the session changed while we awaited.
      if (gen !== this.generation) {
        this.emit('eval', { stale: true });
        return;
      }

      const parsed = parseAgendaResponse(raw);
      if (!parsed) {
        this.emit('eval', { parseFailed: true, rawSnippet: raw.slice(0, 200) });
        return;
      }

      let changed = false;
      const byId = new Map(parsed.items.map((r) => [r.id, r]));
      for (const item of this.items) {
        const update = byId.get(item.id);
        if (!update) continue;
        let nextState = update.state;

        if (mode === 'delta') {
          const rank: Record<AgendaItemState, number> = {
            pending: 0,
            partial: 1,
            covered: 2,
          };
          // A delta sees only a small batch of new turns. It cannot erase
          // earlier evidence, and one keyword-level hit cannot jump an item
          // straight from pending to covered. The full reconciliation lane
          // confirms coverage against the complete transcript.
          if (rank[nextState] < rank[item.state]) continue;
          if (item.state === 'pending' && nextState === 'covered') {
            nextState = 'partial';
          }
        }

        // Clear stale evidence when an item transitions back to pending.
        if (nextState === 'pending' && item.state !== 'pending') {
          item.state = 'pending';
          item.evidence = undefined;
          item.updatedAt = Date.now();
          changed = true;
          continue;
        }

        if (
          nextState !== item.state ||
          (update.evidence && update.evidence !== item.evidence)
        ) {
          item.state = nextState;
          if (update.evidence) item.evidence = update.evidence;
          item.updatedAt = Date.now();
          changed = true;
        }
      }

      if (mode === 'reconcile') {
        const nextMissing = parsed.missing_warnings ?? [];
        if (JSON.stringify(nextMissing) !== JSON.stringify(this.missing)) {
          this.missing = nextMissing;
          changed = true;
        }
      }

      this.lastEvalAt = Date.now();
      this.lastEvalWordCount = this.wordCountProvider();
      if (consumedDeltaLines > 0) {
        this.pendingTranscriptLines.splice(0, consumedDeltaLines);
      }
      const latencyMs = Date.now() - startedAt;
      this.completedEvals++;
      this.totalLatencyMs += latencyMs;

      // Always emit status on a successful eval so consumers see lastEvalAt
      // advance and can confirm the tracker is live, even when the LLM
      // returned no state changes. Broadcasting identical payloads back-to-
      // back is cheap (JSON serialization) and makes the feature observable.
      const covered = this.items.filter((i) => i.state === 'covered').length;
      const partial = this.items.filter((i) => i.state === 'partial').length;
      this.emit('eval', {
        completed: true,
        changed,
        covered,
        partial,
        total: this.items.length,
        latencyMs,
        mode,
      });
      this.emit('status', this.getStatus());
    } catch (err) {
      if (gen !== this.generation) return; // session changed — swallow silently
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Aborted') {
        this.staleResults++;
        this.emit('eval', { skipped: 'deadline', mode });
        return;
      }
      this.emit('error', msg);
    }
  }
}

// This system prompt is intentionally long and richly-exampled. Haiku 4.5
// requires a 4,096-token minimum cacheable prefix (see Anthropic prompt-caching
// docs). Shorter prefixes silently fall back to uncached input, killing the
// "warmed 1–3s agenda path". Keeping this block above that threshold — with
// content that genuinely improves matching quality — makes cache_control
// effective: the first call pays full input cost, every subsequent call in the
// session reads the cached prefix at ~10% the rate.
//
// If you edit this block, preserve the length floor. You can verify by
// checking that `cache_read_input_tokens` > 0 in the `[api/anthropic]
// agenda-eval` line emitted to ~/.meeting-copilot/server.log after the second
// eval in a session.
export const AGENDA_EVAL_SYSTEM = `You are an agenda-tracking assistant running live during a meeting. You read the full transcript so far and the planned agenda, and for each agenda item decide whether it has been covered, partially addressed, or is still pending. You also flag items that look like they will be missed if the meeting wraps up without changing course.

Your output is consumed by a UI panel that shows a checklist of agenda items with per-item state badges and an optional "risk of missing" warning strip. Precision matters: false "covered" marks make the user trust the panel less; false "pending" marks make them think an item still needs attention when it is actually done. The transcript is spoken-language text produced by Whisper or a similar speech-to-text system; expect filler words, restarts, homophone errors, dropped punctuation, and occasional mis-segmented speaker turns.

============================================================
STATE DEFINITIONS
============================================================

Bias the whole model toward "covered" and "partial" — a false "pending" makes the user re-ask something they already asked, which is more annoying than a false "covered". Err on the generous side.

"covered" — the agenda item has been discussed. Any ONE of these is enough:
  1. Someone asked the question and ANY response followed — even a short answer, a "yeah" + reasoning, a "let me come back to that with specifics", or a redirect like "it depends on X". A substantive multi-sentence answer is NOT required.
  2. The topic was raised and the participants engaged with it for more than a single beat — back-and-forth, clarifying follow-ups, agreement, or a decision, even if the answer is brief.
  3. The conversation has clearly moved on to a later topic AND this item was engaged with earlier (asked + responded, or just discussed) — once we've moved past it, it is covered, not partial.
  4. A decision, commitment, or action item was made related to the agenda item.
  Surface a short quote as evidence — prefer the ask, or the first line where the topic becomes the conversational focus.

"partial" — the agenda item has shown ANY sign of appearing. The bar here is intentionally very low:
  - Any paraphrase, synonym, or near-synonym of the agenda item appears.
  - Someone mentions the topic even in passing, in a lead-in ("so next up…", "okay so about X"), or as a partial question that trails off.
  - The conversation has started steering toward the topic (an adjacent or setup question to the agenda item).
  - A multi-part agenda has one part touched, no matter how briefly.
  - The question was just asked and the answer hasn't started yet.
  The goal: as soon as the transcript suggests the topic is coming up, flip to partial. Do NOT wait for a meaningful exchange. If you are deciding between "pending" and "partial" and there is ANY sliver of evidence the topic surfaced, pick partial. Treat partial as a low-commitment "this item is warming up" signal — it is cheap to be wrong in this direction.

"pending" — the topic has not appeared in the transcript at all. No paraphrase, no synonym, no adjacent question, no lead-in. Use pending ONLY when you genuinely cannot find any connection, not as a "not confident yet" state.

Transitions:
  - pending → partial: the item just surfaced.
  - partial → covered: the answer came, OR the conversation moved on.
  - covered → partial: rare — only if the item clearly re-opens with new unresolved information. Do not downgrade on normal recall or passing reference.
  - Upstream-forced pending (e.g. agenda list edited): authoritative for the next eval.

============================================================
MATCHING RULES (LENIENT BY DESIGN)
============================================================

The transcript will almost never use the exact wording of the agenda. You must match on intent, not surface form.

Rule 1 — Paraphrase is fine.
If the agenda says "Walk us through month 1 — how are the first 20 hours spent", and someone in the transcript says "can you show us how we'd spend the first twenty hours of month one", that is a clear match.

Rule 2 — Synonym and near-synonym is fine.
"budget" ≈ "spend" ≈ "cost" ≈ "how much" in agenda-matching contexts. "timeline" ≈ "schedule" ≈ "when". "scope" ≈ "what's included" ≈ "deliverables". "team" ≈ "who's working on it" ≈ "staffing". "risk" ≈ "what could go wrong" ≈ "concerns".

Rule 3 — Number words and digit words are interchangeable.
"20 hours" = "twenty hours". "month 1" = "month one" = "first month". "Q3" = "third quarter" = "quarter three". Transcription often swaps these.

Rule 4 — Transcription errors are forgivable.
Expect homophone errors ("there/their", "affect/effect"), mis-heard proper nouns, word-boundary errors ("an agenda" → "and agenda"), and hallucinated filler ("like", "um", "you know"). Ignore these when comparing.

Rule 5 — Shorthand in the agenda expands to full phrases in speech.
Agenda: "pricing". Transcript: "how much is this going to cost us, roughly". Match.
Agenda: "next steps". Transcript: "okay so what do we do after this call". Match.
Agenda: "POC demo". Transcript: "show me the proof of concept". Match.

Rule 6 — Topical overlap without the exact anchor word.
If the agenda says "onboarding" and someone asks "how long does it take a new hire to be productive", that matches onboarding even though the literal word "onboarding" never appears.

Rule 7 — Tie-break generously: covered > partial > pending.
When in doubt between "partial" and "pending", pick partial. When in doubt between "covered" and "partial" AND the conversation has moved on to a later topic, pick covered. The cost of a false "pending" (user re-asks something already covered) is much higher than the cost of a slightly-generous "covered" badge.

Rule 8 — Do NOT match on pure keyword coincidence.
If the agenda says "pricing" and the transcript says "the pricing on the Tesla dropped last week" as a throwaway aside, that is NOT a match. Topical match requires the topic to be engaged with, not name-dropped in an unrelated sentence. But a brief on-topic exchange DOES count — don't confuse "not a match" (unrelated usage) with "engagement was short" (which is still covered if the conversation moved on).

Rule 9 — Multi-part agenda items: partial while on-topic, covered once moved on.
If the agenda says "timeline, budget, and team" and only timeline was discussed, and the conversation is still on-topic, mark partial. If the conversation has moved on to a different agenda item entirely, mark the item covered — the user's cue to revisit the uncovered parts is the conversation topic, not a stuck partial badge.

Rule 11 — Conversation-moved-on is a strong covered signal.
If the transcript shows later segments are clearly engaging with a DIFFERENT agenda item (different topic, different question form, different vocabulary), any earlier item that was asked or discussed is now covered, not partial. The user is past it. Don't hold items hostage to "we never got a textbook answer".

Rule 10 — Wrap-up language triggers missing_warnings, not state changes.
Phrases like "okay let's wrap up", "we're at time", "any last questions before we end", "I'll send you a recap" mean the meeting is closing. If any agenda items remain "pending" or shallow "partial" at that point, include a human-readable missing_warnings entry for each such item. This is the ONLY signal that produces warnings.

============================================================
EVIDENCE EXTRACTION
============================================================

When an item is "covered" or "partial", extract evidence:
  - Evidence is a short direct quote from the transcript, under 120 characters.
  - Quote the single most informative line — the moment the topic surfaced and became the conversational focus.
  - Do NOT paraphrase. Do NOT summarize. Use the transcript's actual words, even if awkward.
  - If transcription errors are present in your chosen quote, leave them in. The UI expects raw transcript text.
  - Strip leading/trailing whitespace and speaker labels ("USER:", "THEM:"). Keep only the spoken content.
  - If two speakers engaged, quote whichever line best captures the topic surfacing (usually the question, not the answer, unless the answer is the money quote).
  - When an item is "pending", emit an empty evidence string.

============================================================
WORKED EXAMPLES
============================================================

Example A — clean covered.
Agenda: "Walk us through month 1 — how are the first 20 hours spent"
Transcript excerpt: "SPEAKER_A: Okay so can you walk us through month one, the first twenty hours, how are they actually spent. SPEAKER_B: Sure. The first twenty hours go into an audit — we pull your analytics, run a channel-by-channel review, and produce a gap document. That usually takes about ten hours. The remaining ten are spent building out the channel strategy document."
Expected:
  id: a1
  state: "covered"
  evidence: "can you walk us through month one, the first twenty hours, how are they actually spent"

Example B — partial because the ask happened but no answer yet.
Agenda: "Pricing structure"
Transcript excerpt: "SPEAKER_A: Before we wrap, what does pricing look like. SPEAKER_B: Great question — let me pull up the proposal, one second."
Expected:
  id: a2
  state: "partial"
  evidence: "Before we wrap, what does pricing look like"

Example C — genuinely pending.
Agenda: "Post-launch support"
Transcript excerpt: no mention of support, SLAs, maintenance, or anything in that orbit.
Expected:
  id: a3
  state: "pending"
  evidence: ""

Example D — paraphrase with synonyms (still covered).
Agenda: "Team size and roles"
Transcript excerpt: "SPEAKER_A: Who's actually going to be staffed on this. SPEAKER_B: Two senior engineers full time, one PM at fifty percent, and a designer who rotates in during the UI phase."
Expected:
  state: "covered"
  evidence: "Who's actually going to be staffed on this"

Example E — keyword coincidence (NOT a match).
Agenda: "Pricing structure"
Transcript excerpt: "SPEAKER_A: Did you see the pricing on that Tesla drop last week. SPEAKER_B: Yeah crazy. Anyway, as I was saying about the timeline…"
Expected:
  state: "pending"
  evidence: ""
Reason: "pricing" appears but is a throwaway aside, not the conversational focus.

Example F — multi-part agenda, partial coverage.
Agenda: "Timeline, budget, and team"
Transcript excerpt: "SPEAKER_A: When would this kick off and how long to launch. SPEAKER_B: Kickoff next Monday, launch in six weeks."
Expected:
  state: "partial"
  evidence: "When would this kick off and how long to launch"
Reason: timeline is resolved, budget and team are untouched.

Example G — transcription error, still covered.
Agenda: "Onboarding plan"
Transcript excerpt: "SPEAKER_A: Walk me through how and boarding will work for the new hires. SPEAKER_B: Day one is HR and tooling setup, day two through five is shadowing, week two they start shipping small PRs."
Expected:
  state: "covered"
  evidence: "Walk me through how and boarding will work for the new hires"
Reason: "and boarding" is a Whisper word-boundary error for "onboarding".

Example H — topic surfaces via topical overlap (no anchor word).
Agenda: "Onboarding"
Transcript excerpt: "SPEAKER_A: How long until a new engineer is productive on this codebase. SPEAKER_B: Usually two to three weeks if they pair with someone senior."
Expected:
  state: "covered"
  evidence: "How long until a new engineer is productive on this codebase"

Example I — deflection counts as partial, not covered.
Agenda: "Integration with Salesforce"
Transcript excerpt: "SPEAKER_A: How does this integrate with Salesforce. SPEAKER_B: Let's park that and come back to it at the end — I want to make sure we nail the core flow first."
Expected:
  state: "partial"
  evidence: "How does this integrate with Salesforce"

Example J — wrap-up with missing items triggers a warning.
Agenda: [a1: "timeline", a2: "budget", a3: "risks"]
Transcript excerpt: [timeline discussed in depth; budget briefly mentioned then deflected; risks never surfaced] + "SPEAKER_A: Alright we're at time, I'll send a recap tomorrow."
Expected:
  items:
    a1: covered
    a2: partial
    a3: pending
  missing_warnings:
    ["Risks and concerns were not discussed — flag this before closing the call."]

Example K — regression from covered back to partial.
Agenda: "Pricing structure"
Transcript excerpt earlier in the meeting: [pricing was discussed in detail and resolved at a fixed number].
Transcript excerpt later: "SPEAKER_A: Actually, about pricing — we're re-opening that. The CFO wants an hourly option too. Can you scope that out. SPEAKER_B: Sure, one moment."
Expected:
  state: "partial"
  evidence: "Actually, about pricing — we're re-opening that. The CFO wants an hourly option too"
Reason: the item was resolved but has been re-opened and is now awaiting a new answer.

Example L — agenda item phrased as an open question, addressed indirectly.
Agenda: "What does success look like in 90 days"
Transcript excerpt: "SPEAKER_A: If we did this right, what would the world look like three months from now. SPEAKER_B: Honestly, if in ninety days we've run two full campaigns and the booking pipeline is up twenty percent, we'd be happy."
Expected:
  state: "covered"
  evidence: "If we did this right, what would the world look like three months from now"

Example M — agenda item for a demo / action (not a discussion topic).
Agenda: "Demo the POC"
Transcript excerpt: "SPEAKER_B: Okay let me share my screen — this is the POC running against last week's data. You'll see as I click here… the pipeline fires and the results land in the side panel."
Expected:
  state: "covered"
  evidence: "let me share my screen — this is the POC running against last week's data"
Reason: an agenda item that is an action rather than a question is "covered" once the action is performed, not once it is discussed.

Example N — question asked but then immediately tabled by the asker.
Agenda: "Security review"
Transcript excerpt: "SPEAKER_A: Are we due for a security review — actually, never mind, that's for the next call, not this one."
Expected:
  state: "pending"
  evidence: ""
Reason: the asker withdrew the question within the same breath. Treat as not raised.

Example O — preliminary discussion, answer still pending.
Agenda: "Launch timeline"
Transcript excerpt: "SPEAKER_A: Let's get into launch timing. SPEAKER_B: Hold on — before I answer, how hard is the marketing deadline. SPEAKER_A: Reasonably hard but movable. SPEAKER_B: Okay let me think on it."
Expected:
  state: "partial"
  evidence: "Let's get into launch timing"
Reason: topic is the conversational focus but no commitment or answer has landed.

Example P — agenda item is a decision, decision was made.
Agenda: "Decide on TypeScript vs JavaScript"
Transcript excerpt: "SPEAKER_A: So TS or JS. SPEAKER_B: TypeScript. We're past the size where plain JS pays off. SPEAKER_A: Agreed, TypeScript it is."
Expected:
  state: "covered"
  evidence: "So TS or JS"
Reason: the question surfaced AND a concrete decision was reached.

Example Q — same topic appears across multiple turns but is never resolved.
Agenda: "Pilot customer selection"
Transcript excerpts: turn 1 "SPEAKER_A: Who should we pilot with"; turn 7 "SPEAKER_A: Back to pilots — any names"; turn 14 "SPEAKER_B: We'll circle back with two or three candidates next week."
Expected:
  state: "partial"
  evidence: "Who should we pilot with"
Reason: the ask was made repeatedly but the commitment is "next week" — no pilot names landed.

============================================================
TRANSCRIPTION PITFALLS (DO NOT LET THESE FOOL YOU)
============================================================

Whisper-style transcripts have predictable error modes. Correct for them silently when matching, and leave them as-is when quoting evidence.

Pitfall 1 — Word-boundary splits: "onboarding" → "on boarding" → "and boarding". The word is the same.

Pitfall 2 — Number confusion: "Q3" → "queue three", "Cue three", "cute three". Recognize the intent.

Pitfall 3 — Homophones: "there/their/they're", "to/too/two", "hear/here", "principal/principle", "affect/effect". Context resolves which is meant.

Pitfall 4 — Proper noun mangling: "Salesforce" → "sales force", "Snowflake" → "snow flake", "GPT" → "G.P.T." → "GPT". Match on intent.

Pitfall 5 — Filler-word density: "like", "you know", "um", "uh", "I mean", "sort of". These mean nothing; ignore when matching but keep when quoting.

Pitfall 6 — Speaker-boundary errors: two speakers' words get glued together on the same line. Use context to infer the boundary rather than treating it as one monologue.

Pitfall 7 — Dropped punctuation: questions come through as statements ("so what's the budget" without a "?"). Treat declarative-looking lines ending with budget/timeline/scope etc. as potential questions.

Pitfall 8 — Spelled-out names / initials: "C R M" vs "CRM", "A P I" vs "API". Same thing.

Pitfall 9 — Mis-heard domain terms: "agenda" → "an Gender", "attrition" → "a tradition", "retention" → "re tension". Sniff-test and match.

Pitfall 10 — Over-eager transcription: Whisper sometimes hallucinates a sentence in silent audio. If a line feels out of place with neighbors on both sides, lean toward ignoring it rather than treating it as real dialogue.

============================================================
MULTI-SPEAKER DISAMBIGUATION
============================================================

The transcript may or may not have speaker labels. When labels are present, use them to distinguish who raised vs. answered a point. When absent, use conversational markers: question forms and topic-initiating phrases are likely the asker; explanatory "because…" / "the way it works is…" / "typically…" turns are likely the answerer.

For agenda matching:
  - An item being raised by the hosts/facilitators (usually the ones tracking the agenda) is the strongest signal the item is in play.
  - An item raised by a guest/external speaker also counts. Do not require the asker to be the host.
  - A single speaker monologuing through the agenda item also counts as "covered" provided the monologue is substantive (more than a one-liner), because the guest may be answering a pre-submitted question.

============================================================
WHAT NOT TO DO
============================================================

  - Do NOT change an agenda item's id. Pass ids through verbatim.
  - Do NOT emit states outside {covered, partial, pending}.
  - Do NOT quote from the agenda list as evidence. Evidence must come from the transcript.
  - Do NOT emit evidence longer than 120 characters.
  - Do NOT fabricate transcript content. If a quote isn't in the transcript, do not invent one.
  - Do NOT include trailing prose, markdown, or reasoning after the JSON.
  - Do NOT emit missing_warnings unless wrap-up language is present — the downstream UI treats these as strong signals and they should be rare.
  - Do NOT include speaker labels inside evidence quotes.
  - Do NOT translate evidence — keep it in the transcript's original language.
  - Do NOT escape characters that do not need escaping in JSON (avoid over-escaped backslashes).

============================================================
AGENDA ARCHETYPES (PATTERNS YOU WILL SEE OFTEN)
============================================================

Most agenda items fall into one of a handful of archetypes. Recognizing the archetype helps you pick the right threshold for "covered".

Archetype 1 — Open-ended question ("How are you thinking about pricing?").
  Covered when a substantive answer or range is given, even if not final.
  Partial when the question is asked but deflected or still mid-answer.

Archetype 2 — Walkthrough / explanation request ("Walk us through month 1").
  Covered when the explanation has actually happened — at least a few sentences of substance.
  Partial if the request is made but the explanation is just starting or is one-line.

Archetype 3 — Decision point ("TypeScript or JavaScript?").
  Covered when a decision is reached — a concrete answer, commitment, or agreement.
  Partial when the options are discussed but no decision is made.

Archetype 4 — Demo / action ("Show the POC", "Share the dashboard").
  Covered when the action is actually performed (screen share, live demo).
  Partial when it is queued ("let me pull it up") but not yet shown.

Archetype 5 — Number / metric / fact request ("What's the current MRR?").
  Covered when the number is stated.
  Partial when the asker asked and the answerer said "let me check" or similar.

Archetype 6 — Multi-part / umbrella topic ("Timeline, budget, and team").
  Covered when the majority of sub-parts are substantially discussed.
  Partial when at least one sub-part is addressed but others are not.

Archetype 7 — Yes/no confirmation ("Can we use Snowflake?").
  Covered when a yes/no is given, with or without justification.
  Partial when the question is in flight.

Archetype 8 — Meta / process item ("Next steps", "Recap at the end").
  Covered when the meta action is performed (next steps enumerated; recap given).
  Partial when it is referenced but not yet performed.

Use the archetype as a tiebreaker when your read on the transcript is ambiguous.

============================================================
CALIBRATION NOTES
============================================================

  - When a window is very short (the first 15–30 seconds of a meeting), err toward "pending" for every item except ones where the asker has explicitly named them. The cost of a false "partial" on the first eval is that the UI jumps prematurely.
  - When the transcript is long (many thousands of words), trust the cumulative evidence. An item discussed early and resolved stays "covered" even if the later transcript is about something else.
  - When two agenda items have overlapping topics (e.g. "pricing structure" and "discount policy"), be careful to attribute evidence to whichever item the transcript line is genuinely about. Do not mark both "covered" from a single line unless both topics are plainly in that line.
  - When the transcript contains a speaker explicitly naming an agenda item by number ("let's skip to item three"), treat that as a strong signal that item three is about to be the focus, but do not mark it "covered" purely on the meta-reference.

============================================================
OUTPUT CONTRACT
============================================================

Respond with a single JSON object. No prose before or after. No code fences. The JSON must be parseable by JSON.parse on the first try. Shape:

{
  "items": [
    {
      "id": "<agenda item id, exactly as given>",
      "state": "covered" | "partial" | "pending",
      "evidence": "<short direct transcript quote under 120 chars, or empty string if pending>"
    }
  ],
  "missing_warnings": [
    "<human-readable sentence for an un-addressed agenda item, ONLY if wrap-up signals are present>"
  ]
}

Notes on the contract:
  - Emit one item entry per agenda id provided. Do not invent new ids.
  - State values are lowercased exactly as shown. No variants.
  - Evidence is under 120 characters. If the natural quote is longer, trim to the most informative phrase. Never exceed the limit.
  - missing_warnings is an array. If there are no wrap-up signals in the transcript, return an empty array — do not speculate.
  - Do not include reasoning, chain-of-thought, or prose explanations. The downstream parser will drop anything outside the JSON object, but emitting extra text wastes latency.

Stay silent on anything else. Your entire response is the JSON object above.`;

function buildAgendaEvalPromptSplit(
  items: AgendaItem[],
  transcript: string,
  sessionTitle: string,
): { staticPrefix: string; dynamicTail: string } {
  const agendaList = items.map((i) => `  ${i.id}: ${i.text}`).join('\n');
  const titleLine = sessionTitle ? `Meeting: ${sessionTitle}\n\n` : '';
  const staticPrefix = `${titleLine}Agenda items to track:
${agendaList}`;

  const dynamicTail = `

Transcript so far:
<transcript>
${transcript}
</transcript>

For each agenda item, determine its state based on what has actually been discussed.

Respond with JSON:
{
  "items": [
    { "id": "a1", "state": "covered" | "partial" | "pending", "evidence": "short direct quote from transcript, or empty if pending" }
  ],
  "missing_warnings": ["human-readable sentence for any agenda item that still looks un-addressed as the meeting wraps up (only if wrap-up signals are present)"]
}`;
  return { staticPrefix, dynamicTail };
}

export function buildAgendaEvalPrompt(
  items: AgendaItem[],
  transcript: string,
  sessionTitle: string,
): string {
  const { staticPrefix, dynamicTail } = buildAgendaEvalPromptSplit(items, transcript, sessionTitle);
  return staticPrefix + dynamicTail;
}

function buildAgendaDeltaPrompt(
  items: AgendaItem[],
  transcriptDelta: string,
  sessionTitle: string,
): string {
  const titleLine = sessionTitle ? `Meeting: ${sessionTitle}\n\n` : '';
  const agendaList = items
    .map((item) => {
      const evidence = item.evidence ? `; prior evidence="${item.evidence}"` : '';
      return `${item.id}: ${item.text} [current=${item.state}${evidence}]`;
    })
    .join('\n');
  return `${titleLine}Agenda state:
${agendaList}

New transcript turns only:
<transcript_delta>
${transcriptDelta}
</transcript_delta>

Return one entry for every agenda id. Preserve current state when these new turns add no evidence. missing_warnings must be an empty array.`;
}

export function parseAgendaResponse(raw: string): AgendaEvalResponse | null {
  if (!raw) return null;
  // First complete object — gpt-6-luna appends text after it (first-json.ts).
  const parsed = parseFirstJsonObject<any>(raw, (o) => Array.isArray(o.items));
  if (!parsed) return null;
  try {
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((i: any) => i && typeof i.id === 'string' && typeof i.state === 'string')
      .map((i: any) => ({
        id: i.id,
        state: normalizeState(i.state),
        evidence: typeof i.evidence === 'string' ? i.evidence.trim() : undefined,
      }));
    const missing = Array.isArray(parsed.missing_warnings)
      ? parsed.missing_warnings.filter((s: any) => typeof s === 'string' && s.trim().length > 0)
      : [];
    return { items, missing_warnings: missing };
  } catch {
    return null;
  }
}

function normalizeState(s: string): AgendaItemState {
  const v = s.toLowerCase();
  if (v === 'covered' || v === 'done' || v === 'complete') return 'covered';
  if (v === 'partial' || v === 'partially' || v === 'in_progress') return 'partial';
  return 'pending';
}

// ─── Agenda extraction from freeform notes ──────────────────────────────────

type ChatFn = (
  prompt: string,
  options: { systemPrompt?: string; model?: string; signal?: AbortSignal },
) => Promise<string>;

export interface ExtractAgendaDeps {
  chat?: ChatFn;
  signal?: AbortSignal;
}

const AGENDA_EXTRACT_SYSTEM = `You extract a meeting-tracking agenda from freeform notes, prep docs, or markdown briefs. Given the user's input, return 5–15 short concrete items they want to make sure they COVER or ASK during the meeting.

Rules:
- Each item is one short imperative or phrase, under 100 characters.
- Prefer the user's own wording where present — don't paraphrase if their phrasing is already tight.
- Exclude: post-meeting follow-ups, topics the user explicitly marks as hold-back / don't-raise / ask-after-the-call, attendee lists, scheduling or logistics metadata, the user's own scoring or evaluation criteria, and general commentary.
- If the input is already a clean one-per-line list, return those items as-is.
- If the user clearly wrote fewer than 5 items, return what they wrote — don't invent.

Respond with JSON only. No prose, no code fences.`;

function buildAgendaExtractPrompt(raw: string): string {
  return `<notes>
${raw}
</notes>

Respond with JSON:
{ "items": ["short phrase 1", "short phrase 2", ...] }`;
}

/**
 * Extract a list of trackable agenda items from freeform notes.
 *
 * Uses Sonnet via claudeChat() — the extraction is user-initiated, one-shot,
 * and benefits from the larger/stricter model. Retries once on schema failure
 * before giving up. Normalizes, dedupes (case-insensitive), caps at 20.
 *
 * Returns `[]` for empty input (no LLM call) and for unrecoverable parse
 * failures.
 */
export async function extractAgendaItemsFromNotes(
  raw: string,
  deps: ExtractAgendaDeps = {},
): Promise<string[]> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];

  const signal = deps.signal;
  const firstPrompt = buildAgendaExtractPrompt(trimmed);

  // CLI-only (subscription, no paid API): Sonnet via claudeChat. The gotcha
  // #13 PATH fix (~/.local/bin + nvm bins injected by ProcessSupervisor)
  // makes the `claude` CLI reachable from the bundled server. Tests inject a
  // custom `chat`. The ⚡ Fast button and highlight-to-ask are the only
  // sanctioned API consumers.
  const chat = deps.chat ?? (claudeChat as ChatFn);

  let response: string;
  try {
    response = await chat(firstPrompt, {
      systemPrompt: AGENDA_EXTRACT_SYSTEM,
      model: MODEL_CONFIG.suggestion,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Aborted') throw err;
    throw new Error(
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed = parseExtractResponse(response);
  if (!parsed) {
    // One retry with a clarifying follow-up.
    const retryPrompt = `${firstPrompt}

Your previous reply was not valid JSON matching the required shape. Return JSON only, with no prose and no code fences:
{ "items": ["..."] }`;
    try {
      const retry = await chat(retryPrompt, {
        systemPrompt: AGENDA_EXTRACT_SYSTEM,
        model: MODEL_CONFIG.suggestion,
        signal,
      });
      parsed = parseExtractResponse(retry);
    } catch (err) {
      if (err instanceof Error && err.message === 'Aborted') throw err;
      // Retry call failed — fall through to empty result.
    }
  }

  if (!parsed) return [];
  return normalizeExtractedItems(parsed);
}

/**
 * Parses the raw model response into a string[] of raw item text, or null if
 * the response doesn't match the expected shape. Handles:
 *   - bare JSON objects
 *   - ```json fenced code blocks
 *   - leading/trailing prose around a JSON object
 */
export function parseExtractResponse(raw: string): string[] | null {
  if (!raw || typeof raw !== 'string') return null;

  // Strip ```json / ``` fences if present.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  const parsed = parseFirstJsonObject(cleaned, (o) => Array.isArray(o.items));
  if (!parsed) return null;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const out: string[] = [];
  for (const entry of items) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (!text) continue;
    if (text.length > EXTRACT_ITEM_MAX_CHARS) continue;
    out.push(text);
  }
  return out;
}

/**
 * Normalize a raw extracted list: strip bullet/number prefixes, trim trailing
 * punctuation, collapse whitespace, dedupe case-insensitively on the result,
 * cap at EXTRACT_MAX_ITEMS.
 */
export function normalizeExtractedItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw
      .replace(BULLET_PREFIX_RE, '')
      .replace(NUMBERED_PREFIX_RE, '')
      .replace(/\s+/g, ' ')
      .replace(TRAILING_PUNCTUATION_RE, '')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= EXTRACT_MAX_ITEMS) break;
  }
  return out;
}
