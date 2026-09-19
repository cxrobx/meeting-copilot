import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { claudeChat, claudeTriage, claudeSuggest } from '../claude-cli.js';
import { isOpenAiApiAvailable, openaiTriageJson } from '../api/openai.js';
import { isAnthropicApiAvailable, anthropicSuggestStream } from '../api/anthropic.js';
import { LLM_CONFIG, MODEL_CONFIG } from '../model-config.js';
import { LlmBudgetExceededError, resetLlmBudget } from '../api/budget.js';
import { parsePartialSuggestion, type PartialSuggestion } from './partial-json.js';
import type { TranscriptSegment } from '../transcription/types.js';
import type { ActionSuggestion } from '../workers/types.js';
import type { ProjectContext } from '../project/index.js';
import { formatProjectBrief } from '../project/index.js';
import type { ContextDoc } from '../context/index.js';
import { buildContextManifest, buildContextBlock } from '../context/index.js';
import {
  HAIKU_TRIAGE_SYSTEM,
  buildHaikuTriagePrompt,
  type HaikuTriageResult,
} from './prompts/haiku-triage.v1.js';
import {
  SONNET_SUGGEST_SYSTEM,
  buildSonnetSuggestPrompt,
  buildSonnetSuggestPromptSplit,
  type SonnetSuggestionResult,
} from './prompts/sonnet-suggest.v1.js';

const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BASE_EVAL_INTERVAL_MS = 15_000;
const CONTEXT_COMPRESSION_INTERVAL_MS = 5 * 60 * 1000;
const OVERLAP_HISTORY_SIZE = 5;
const RECENT_ACTION_SUGGESTION_LIMIT = 12;

const IMMEDIATE_TRIGGERS = [
  '?',
  'should we',
  "let's",
  'what if',
];

export class IntelligenceEngine extends EventEmitter {
  private segments: TranscriptSegment[] = [];
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private compressionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private evalInFlight = false;
  private evalDirty = false;
  private evalDebounce: ReturnType<typeof setTimeout> | null = null;
  private currentEvalAbort: AbortController | null = null;
  private triageApiFailures = 0;
  private triageApiDisabledUntil = 0;
  private suggestionApiFailures = 0;
  private suggestionApiDisabledUntil = 0;
  private recentWindowHashes: string[] = [];
  private recentActionSuggestions: Array<{ title: string; triggerQuote: string }> = [];
  private contextSummaries: Array<{
    summary: string;
    windowStart: number;
    windowEnd: number;
    createdAt: number;
  }> = [];

  // Runtime-tunable eval cadence (settings system); backoff = 2× base.
  private baseEvalIntervalMs = DEFAULT_BASE_EVAL_INTERVAL_MS;

  // Project names to watch for - can be configured externally
  public projectNames: string[] = [];
  private projectContext: ProjectContext[] = [];
  private meetingContext: { agenda?: string; attendees?: string } = {};
  private contextDocs: ContextDoc[] = [];
  private contextManifest: string = '';

  // Metrics
  public evalsRun = 0;
  public haikuActionableCount = 0;
  public sonnetCallCount = 0;
  public totalSuggestionLatencyMs = 0;

  private suggestionCallback:
    | ((suggestion: ActionSuggestion) => void)
    | null = null;
  /**
   * Streaming suggestion updates. Fires repeatedly as the Sonnet JSON streams
   * in (final=null), then once more when parsing completes (final set, or
   * done=true with final=null on parse failure so the consumer can drop the
   * in-progress card). `id` is stable across one suggestion's updates.
   */
  private partialSuggestionCallback:
    | ((update: { id: string; partial: PartialSuggestion; final: ActionSuggestion | null; done: boolean }) => void)
    | null = null;
  private contextSummaryCallback:
    | ((summary: { summary: string; windowStart: number; windowEnd: number }) => void)
    | null = null;

  constructor() {
    super();
  }

  onSuggestion(callback: (suggestion: ActionSuggestion) => void): void {
    this.suggestionCallback = callback;
  }

  onPartialSuggestion(
    callback: (update: { id: string; partial: PartialSuggestion; final: ActionSuggestion | null; done: boolean }) => void,
  ): void {
    this.partialSuggestionCallback = callback;
  }

  onContextSummary(
    callback: (summary: {
      summary: string;
      windowStart: number;
      windowEnd: number;
    }) => void,
  ): void {
    this.contextSummaryCallback = callback;
  }

  setProjectContext(contexts: ProjectContext[]): void {
    this.projectContext = contexts;
    this.projectNames = contexts.map((c) => c.name);
  }

  getProjectContext(): ProjectContext[] {
    return this.projectContext;
  }

  setMeetingContext(context: { agenda?: string; attendees?: string }): void {
    this.meetingContext = context;
  }

  getMeetingContext(): { agenda?: string; attendees?: string } {
    return this.meetingContext;
  }

  setContextDocs(docs: ContextDoc[]): void {
    this.contextDocs = docs;
    this.contextManifest = docs.length > 0 ? buildContextManifest(docs) : '';
  }

  getContextDocs(): ContextDoc[] {
    return this.contextDocs;
  }

  addTranscript(segment: TranscriptSegment): void {
    this.segments.push(segment);

    // Evaluate on meaningful transcript arrivals, with a short debounce. This
    // cuts perceived latency while the periodic timer remains a safety net.
    if (this.running && segment.wordCount >= 4) {
      if (this.evalDebounce) clearTimeout(this.evalDebounce);
      const delay = this.shouldTriggerImmediate(segment.text) ? 0 : 300;
      this.evalDebounce = setTimeout(() => {
        this.evalDebounce = null;
        this.scheduleEval();
      }, delay);
    }
  }

  start(): void {
    if (this.running) return;
    // Intelligence state is session-scoped. The singleton engine is reused by
    // the server, so a meeting started soon after another one must not inherit
    // transcript windows, compressed context, dedup history, or metrics.
    this.segments = [];
    this.recentWindowHashes = [];
    this.recentActionSuggestions = [];
    this.contextSummaries = [];
    this.evalsRun = 0;
    this.haikuActionableCount = 0;
    this.sonnetCallCount = 0;
    this.totalSuggestionLatencyMs = 0;
    this.running = true;
    resetLlmBudget();

    // Start adaptive eval loop
    this.resetEvalTimer();

    // Start context compression timer
    this.compressionTimer = setInterval(() => {
      this.compressOldContext();
    }, CONTEXT_COMPRESSION_INTERVAL_MS);

    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
    if (this.compressionTimer) {
      clearInterval(this.compressionTimer);
      this.compressionTimer = null;
    }
    if (this.evalDebounce) {
      clearTimeout(this.evalDebounce);
      this.evalDebounce = null;
    }
    this.currentEvalAbort?.abort();
    this.currentEvalAbort = null;
    this.evalDirty = false;

    this.projectContext = [];
    this.meetingContext = {};
    this.contextDocs = [];
    this.contextManifest = '';

    this.emit('stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  get haikuHitRate(): number {
    return this.evalsRun > 0 ? this.haikuActionableCount / this.evalsRun : 0;
  }

  get sonnetCallRate(): number {
    return this.evalsRun > 0 ? this.sonnetCallCount / this.evalsRun : 0;
  }

  get avgSuggestionLatencyMs(): number {
    return this.sonnetCallCount > 0
      ? this.totalSuggestionLatencyMs / this.sonnetCallCount
      : 0;
  }

  getTranscriptWindow(): string {
    const cutoff = Date.now() - WINDOW_DURATION_MS;
    const windowSegments = this.segments.filter(
      (s) => s.timestamp >= cutoff && s.text.length > 0,
    );
    const transcript = windowSegments
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');

    // Prepend meeting context header if available
    const contextParts: string[] = [];
    if (this.meetingContext.agenda) {
      contextParts.push(`Meeting Agenda: ${this.meetingContext.agenda}`);
    }
    if (this.meetingContext.attendees) {
      contextParts.push(`Attendees: ${this.meetingContext.attendees}`);
    }
    // Re-inject compressed history — compression summarizes >5-min-old
    // segments before dropping them; without this the summary was written to
    // SQLite and never read, so the eval window simply forgot the meeting's
    // first half. Last 2 summaries ≈ the previous ~10 minutes.
    const recentSummaries = this.contextSummaries.slice(-2);
    if (recentSummaries.length > 0) {
      contextParts.push(
        `Earlier discussion (compressed):\n${recentSummaries.map((s) => s.summary).join('\n---\n')}`,
      );
    }
    if (contextParts.length > 0) {
      return `[Meeting Context]\n${contextParts.join('\n')}\n\n[Transcript]\n${transcript}`;
    }
    return transcript;
  }

  getFullTranscript(): string {
    return this.segments
      .filter((s) => s.text.length > 0)
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');
  }

  private shouldTriggerImmediate(text: string): boolean {
    const lower = text.toLowerCase();
    for (const trigger of IMMEDIATE_TRIGGERS) {
      if (lower.includes(trigger)) return true;
    }
    for (const name of this.projectNames) {
      if (lower.includes(name.toLowerCase())) return true;
    }
    return false;
  }

  /**
   * Runtime-tunable base eval cadence (settings system). Re-arms the timer
   * immediately when the engine is running so the change applies live.
   */
  setEvalCadence(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.baseEvalIntervalMs = ms;
    if (this.running) this.resetEvalTimer();
  }

  private resetEvalTimer(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
    }

    // No quiet-period backoff. This used to double the interval after 3
    // non-actionable evals, which slowed the copilot down exactly when a moment
    // was most likely to slip past unnoticed — a quiet stretch is not evidence
    // that the next minute is quiet too. Missing a moment costs more than an
    // ignored card, so the cadence stays flat.
    this.evalTimer = setInterval(() => {
      this.scheduleEval();
    }, this.baseEvalIntervalMs);
  }

  private scheduleEval(): void {
    if (!this.running) return;
    if (this.evalInFlight) {
      this.evalDirty = true;
      return;
    }
    this.evalInFlight = true;
    this.currentEvalAbort = new AbortController();
    const signal = this.currentEvalAbort.signal;
    this.runEvaluation(signal).finally(() => {
      this.evalInFlight = false;
      this.currentEvalAbort = null;
      if (this.running && this.evalDirty) {
        this.evalDirty = false;
        queueMicrotask(() => this.scheduleEval());
      }
    });
  }

  private async runEvaluation(signal: AbortSignal): Promise<void> {
    const window = this.getTranscriptWindow();
    if (!window || window.trim().length < 20) return;

    // Overlap dedup
    const windowHash = this.hashWindow(window);
    if (this.isOverlapping(windowHash)) return;

    this.recentWindowHashes.push(windowHash);
    if (this.recentWindowHashes.length > OVERLAP_HISTORY_SIZE) {
      this.recentWindowHashes.shift();
    }

    this.evalsRun++;
    const startTime = Date.now();
    this.emit('intelligence.activity', { phase: 'evaluating' });

    try {
      // Tier 1: Haiku triage
      const triageResult = await this.runHaikuTriage(window, signal);
      const repeatedMoment = triageResult.actionable
        && this.isRepeatedActionableMoment(triageResult.triggerQuote);
      this.emit('intelligence.eval', {
        tier: 1,
        actionable: triageResult.actionable && !repeatedMoment,
        reason: repeatedMoment
          ? 'Suppressed a repeat of an action card already surfaced this meeting'
          : triageResult.reason,
      });

      if (!triageResult.actionable || repeatedMoment) {
        return;
      }

      this.haikuActionableCount++;

      // Tier 2: Sonnet suggestion
      this.sonnetCallCount++;
      this.emit('intelligence.activity', { phase: 'generating' });
      const suggestion = await this.runSonnetSuggestion(window, triageResult, signal);
      const latency = Date.now() - startTime;
      this.totalSuggestionLatencyMs += latency;

      if (suggestion) {
        this.recentActionSuggestions.push({
          title: suggestion.title,
          triggerQuote: suggestion.triggerQuote || triageResult.triggerQuote,
        });
        if (this.recentActionSuggestions.length > RECENT_ACTION_SUGGESTION_LIMIT) {
          this.recentActionSuggestions.splice(
            0,
            this.recentActionSuggestions.length - RECENT_ACTION_SUGGESTION_LIMIT,
          );
        }
        this.emit('intelligence.suggestion', suggestion);
        if (this.suggestionCallback) {
          this.suggestionCallback(suggestion);
        }
      }
    } catch (error) {
      this.emit('intelligence.error', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Concurrent evals (MAX_EVAL_IN_FLIGHT=2) can interleave phases; last
      // writer wins, which is acceptable for a status indicator.
      this.emit('intelligence.activity', { phase: 'idle' });
    }
  }

  private async runHaikuTriage(window: string, signal: AbortSignal): Promise<HaikuTriageResult> {
    const projectBrief = this.projectContext.length > 0
      ? formatProjectBrief(this.projectContext[0]!)
      : undefined;
    const prompt = buildHaikuTriagePrompt(
      window,
      projectBrief,
      this.contextManifest || undefined,
      this.recentActionSuggestions,
    );

    // In auto/api mode, prefer the direct structured API for predictable live
    // latency. `COPILOT_LIVE_LLM_MODE=cli` forces the subscription-backed
    // Gemini → Haiku fallback chain when incremental cost matters more.
    const useApi = LLM_CONFIG.liveTransport !== 'cli'
      && isOpenAiApiAvailable()
      && Date.now() >= this.triageApiDisabledUntil;
    let text: string;
    if (useApi) {
      try {
        text = await openaiTriageJson(
          prompt,
          HAIKU_TRIAGE_SYSTEM,
          {
            name: 'meeting_triage',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['actionable', 'reason', 'triggerQuote'],
              properties: {
                actionable: { type: 'boolean' },
                reason: { type: 'string' },
                triggerQuote: { type: 'string' },
              },
            },
          },
          { signal, timeoutMs: 5_000, label: 'live-triage' },
        );
        this.triageApiFailures = 0;
      } catch (error) {
        if (signal.aborted || error instanceof LlmBudgetExceededError || this.isAuthenticationError(error)) throw error;
        this.triageApiFailures += 1;
        if (this.triageApiFailures >= 2) {
          this.triageApiDisabledUntil = Date.now() + 2 * 60_000;
        }
        this.emit('intelligence.error', { code: 'TRIAGE_API_DEGRADED', fallback: 'claude-cli' });
        text = await claudeChat(prompt, {
          systemPrompt: HAIKU_TRIAGE_SYSTEM,
          model: MODEL_CONFIG.haiku,
          signal,
        });
      }
    } else {
      text = await claudeTriage(prompt, HAIKU_TRIAGE_SYSTEM, signal);
    }
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as HaikuTriageResult;
      }
      return JSON.parse(text) as HaikuTriageResult;
    } catch {
      return { actionable: false, reason: 'Failed to parse triage response', triggerQuote: '' };
    }
  }

  private async runSonnetSuggestion(
    window: string,
    triageResult: HaikuTriageResult,
    signal: AbortSignal,
  ): Promise<ActionSuggestion | null> {
    const projectBriefs = this.projectContext.map((c) => formatProjectBrief(c));
    const contextBlock = this.contextDocs.length > 0
      ? buildContextBlock(this.contextDocs, triageResult.triggerQuote)
      : undefined;

    // CLI-only (subscription, no paid API): streaming Sonnet via claudeSuggest.
    // Stable id correlates every partial of this one suggestion so the consumer
    // can build one growing card and pre-approve it before generation finishes.
    const sid = randomUUID();
    let buffer = '';
    let lastEmit = 0;
    let lastParamsReady = false;
    const emit = (final: ActionSuggestion | null, done: boolean): void => {
      if (!this.partialSuggestionCallback) return;
      this.partialSuggestionCallback({ id: sid, partial: parsePartialSuggestion(buffer), final, done });
    };
    const onDelta = (chunk: string): void => {
      buffer += chunk;
      if (!this.partialSuggestionCallback) return;
      const partial = parsePartialSuggestion(buffer);
      const now = Date.now();
      // Throttle to ~50ms, but always emit the instant params closes (that's the
      // moment a pre-approved worker can launch) or the first time a title lands.
      if (partial.paramsReady && !lastParamsReady) {
        lastParamsReady = true;
        lastEmit = now;
        this.partialSuggestionCallback({ id: sid, partial, final: null, done: false });
      } else if (now - lastEmit > 50) {
        lastEmit = now;
        this.partialSuggestionCallback({ id: sid, partial, final: null, done: false });
      }
    };

    const triage = {
      reason: triageResult.reason,
      triggerQuote: triageResult.triggerQuote,
    };
    const useApi = LLM_CONFIG.liveTransport !== 'cli'
      && isAnthropicApiAvailable()
      && Date.now() >= this.suggestionApiDisabledUntil;
    let text: string;
    if (useApi) {
      const split = buildSonnetSuggestPromptSplit(
        window,
        triage,
        projectBriefs.length > 0 ? projectBriefs : undefined,
        contextBlock,
      );
      try {
        const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const result = await anthropicSuggestStream({
          systemPrompt: SONNET_SUGGEST_SYSTEM,
          staticContext: split.staticPrefix,
          dynamicTail: split.dynamicTail,
          signal: deadlineSignal,
          onDelta,
          label: 'live-suggestion',
        });
        text = result.text;
        this.suggestionApiFailures = 0;
      } catch (error) {
        if (signal.aborted || error instanceof LlmBudgetExceededError || this.isAuthenticationError(error)) throw error;
        this.suggestionApiFailures += 1;
        if (this.suggestionApiFailures >= 2) {
          this.suggestionApiDisabledUntil = Date.now() + 2 * 60_000;
        }
        this.emit('intelligence.error', { code: 'SUGGESTION_API_DEGRADED', fallback: 'claude-cli' });
        text = await claudeSuggest(
          split.staticPrefix + split.dynamicTail,
          SONNET_SUGGEST_SYSTEM,
          signal,
          undefined,
          { onDelta },
        );
      }
    } else {
      text = await claudeSuggest(
        buildSonnetSuggestPrompt(
          window,
          triage,
          projectBriefs.length > 0 ? projectBriefs : undefined,
          contextBlock,
        ),
        SONNET_SUGGEST_SYSTEM,
        signal,
        undefined,
        { onDelta },
      );
    }

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const raw = jsonMatch ? jsonMatch[0] : text;
      const result = JSON.parse(raw) as SonnetSuggestionResult;
      const final: ActionSuggestion = {
        type: result.type,
        title: result.title,
        description: result.description,
        triggerQuote: result.triggerQuote,
        estimatedDurationSec: result.estimatedDurationSec,
        params: result.params,
      };
      buffer = raw; // ensure the final partial reflects the clean JSON
      emit(final, true);
      return final;
    } catch {
      emit(null, true); // tell the consumer to drop the in-progress card
      return null;
    }
  }

  private hashWindow(window: string): string {
    return createHash('sha256').update(window).digest('hex');
  }

  private isRepeatedActionableMoment(triggerQuote: string): boolean {
    const normalized = triggerQuote.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normalized.length < 20) return false;
    const words = new Set(normalized.split(/\s+/).filter((word) => word.length > 2));

    for (const recent of this.recentActionSuggestions) {
      const prior = recent.triggerQuote.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (prior.length < 20) continue;
      if (normalized === prior || normalized.includes(prior) || prior.includes(normalized)) {
        return true;
      }

      const priorWords = new Set(prior.split(/\s+/).filter((word) => word.length > 2));
      let intersection = 0;
      for (const word of words) {
        if (priorWords.has(word)) intersection++;
      }
      const union = words.size + priorWords.size - intersection;
      if (intersection >= 5 && union > 0 && intersection / union >= 0.8) {
        return true;
      }
    }
    return false;
  }

  private isAuthenticationError(error: unknown): boolean {
    const status = (error as { status?: number } | null)?.status;
    return status === 401 || status === 403;
  }

  private isOverlapping(newHash: string): boolean {
    // Exact-window dedup is sufficient with single-flight/latest-wins. Fuzzy
    // Jaccard dedup suppressed fresh speech because a five-minute rolling
    // window is naturally >80% similar after each new sentence.
    return this.recentWindowHashes.includes(newHash);
  }

  private async compressOldContext(): Promise<void> {
    const cutoff = Date.now() - WINDOW_DURATION_MS;
    const oldSegments = this.segments.filter(
      (s) => s.timestamp < cutoff && s.text.length > 0,
    );

    if (oldSegments.length < 10) return; // Not enough to compress

    const oldText = oldSegments
      .map((s) => `${s.label} ${s.text}`)
      .join('\n');

    try {
      const summary = await claudeTriage(
        oldText,
        'Summarize this meeting transcript excerpt into a concise paragraph preserving key decisions, action items, and topics discussed. Be factual and specific.',
      );

      if (summary) {
        const summaryRecord = {
          summary,
          windowStart: oldSegments[0]!.timestamp,
          windowEnd: oldSegments[oldSegments.length - 1]!.timestamp,
          createdAt: Date.now(),
        };

        this.contextSummaries.push(summaryRecord);
        // Bound prompt growth on multi-hour meetings — only the last 2 are
        // re-injected into the eval window; older ones live in SQLite.
        if (this.contextSummaries.length > 10) {
          this.contextSummaries.splice(0, this.contextSummaries.length - 10);
        }

        if (this.contextSummaryCallback) {
          this.contextSummaryCallback(summaryRecord);
        }

        this.emit('intelligence.compression', summaryRecord);

        // Remove compressed segments
        this.segments = this.segments.filter(
          (s) => s.timestamp >= cutoff,
        );
      }
    } catch (error) {
      this.emit('intelligence.error', {
        error: `Context compression failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
